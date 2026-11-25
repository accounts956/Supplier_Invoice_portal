const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const SupplierInvoice = require('./SupplierInvoice.model');
// ⚠️ point this at your existing admin auth guard
const { protect, adminOnly } = require('../../shared/middleware/auth');

const router = express.Router();

// ---------- storage (outside any public/static dir) ----------
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'private_uploads', 'supplier-invoices');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  '.pdf': ['application/pdf'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
};

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) =>
      cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED[ext] && ALLOWED[ext].includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only PDF, JPG, JPEG and PNG files are allowed'));
  },
});

// verify real file signature, not just the extension
const hasValidSignature = (filePath) => {
  const buf = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, 8, 0);
  fs.closeSync(fd);
  return (
    buf.slice(0, 4).toString('latin1') === '%PDF' ||
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  );
};

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// ---------- mail ----------
// Two delivery modes:
//  1. Gmail API over HTTPS (OAuth 2.0) -- works on Render Free, which blocks SMTP ports 25/465/587.
//  2. Plain SMTP (fallback, e.g. local development).
const useGmail = () => Boolean(String(process.env.GOOGLE_REFRESH_TOKEN || '').trim());
const requiredEnv = () => useGmail()
  ? ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'INVOICE_MAIL_FROM', 'INVOICE_RECIPIENT_EMAIL']
  : ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'INVOICE_RECIPIENT_EMAIL'];
const missingEnv = () => requiredEnv().filter((k) => !String(process.env[k] || '').trim());

// Error that carries a supplier-safe message + HTTP status. Raw SMTP details go to logs/DB only.
class MailError extends Error {
  constructor(publicMessage, status, detail) {
    super(detail || publicMessage);
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

let transporter;
const getTransporter = () => {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      // port 465 = implicit TLS; 587 = STARTTLS. SMTP_SECURE can still force it.
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // fail fast instead of hanging until the browser gives up (Render blocks some SMTP ports)
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }
  return transporter;
};

// Translate a nodemailer/SMTP failure into a MailError
const classifyMailError = (err) => {
  if (err instanceof MailError) return err;
  const detail = `${err.code || 'ERR'}${err.responseCode ? ' ' + err.responseCode : ''}: ${err.response || err.message}`;
  if (err.code === 'EAUTH' || err.responseCode === 535 || err.responseCode === 534)
    return new MailError('Email service authentication failed. Please contact the accounts team.', 502, detail);
  if (err.code === 'EENVELOPE' || (err.responseCode >= 550 && err.responseCode <= 554))
    return new MailError('The accounts email address was rejected by the mail server. Please contact the accounts team.', 502, detail);
  if (['ETIMEDOUT', 'ECONNECTION', 'ECONNREFUSED', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(err.code))
    return new MailError('Could not reach the email server. Please try again shortly.', 503, detail);
  return new MailError('The invoice could not be emailed. Please try again.', 502, detail);
};

// ----- Gmail API (OAuth 2.0 refresh-token flow, HTTPS only) -----
let gToken = { value: null, exp: 0 };
const getGoogleAccessToken = async () => {
  if (gToken.value && Date.now() < gToken.exp - 60000) return gToken.value;
  let res, body;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(20000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    throw new MailError('Could not reach the email service. Please try again shortly.', 503, `Google token endpoint unreachable: ${err.message}`);
  }
  if (!res.ok || !body.access_token) {
    // invalid_grant = refresh token revoked/expired; invalid_client = wrong client id/secret
    throw new MailError('Email service authentication failed. Please contact the accounts team.', 502,
      `Google OAuth ${res.status}: ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  gToken = { value: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return gToken.value;
};

const sendViaGmail = async ({ from, recipients, replyTo, subject, text, filename, filePath, contentType }) => {
  // Build the RFC 822 message (headers + multipart + attachment) with nodemailer's composer
  const MailComposer = require('nodemailer/lib/mail-composer');
  const raw = await new Promise((resolve, reject) =>
    new MailComposer({
      // Gmail always sends as the authenticated account, so show the supplier as the sender NAME
      // (visible in the inbox list); Reply-To sends replies straight to the supplier.
      from: { name: `${replyTo} (via Supplier Invoice Portal)`, address: (from.match(/<([^>]+)>/) || [null, from])[1].trim() },
      to: recipients, replyTo, subject, text,
      attachments: [{ filename, path: filePath, contentType }],
    }).compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
  const encoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const accessToken = await getGoogleAccessToken();
  let res, body;
  try {
    res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
      signal: AbortSignal.timeout(45000),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    throw new MailError('Could not reach the email service. Please try again shortly.', 503, `Gmail API unreachable: ${err.message}`);
  }
  console.log('[supplier-invoice] Gmail API result:', res.status, JSON.stringify({ id: body.id, threadId: body.threadId, labelIds: body.labelIds }));
  if (!res.ok || !body.id) {
    const g = body.error || {};
    const detail = `Gmail API ${res.status}: ${g.status || ''} ${g.message || JSON.stringify(body)}`.trim();
    if (res.status === 401) gToken = { value: null, exp: 0 };
    if (res.status === 401 || res.status === 403 && /insufficient|scope|disabled|not been used/i.test(g.message || ''))
      throw new MailError('Email service authentication failed. Please contact the accounts team.', 502, detail);
    if (res.status === 429 || (res.status === 403 && /rate|quota|limit/i.test(g.message || '')))
      throw new MailError('The email service is temporarily over its sending limit. Please try again later.', 503, detail);
    if (res.status === 400)
      throw new MailError('The invoice could not be emailed (rejected by the email service).', 502, detail);
    throw new MailError('The invoice could not be emailed. Please try again.', 502, detail);
  }
  return body.id; // Gmail message id: proof Gmail accepted and stored the message
};

const sendInvoiceMail = async (doc) => {
  const missing = missingEnv();
  if (missing.length)
    throw new MailError('Email is not configured on the server. Please contact the accounts team.', 503,
      `Missing env vars: ${missing.join(', ')}`);

  const filePath = path.join(UPLOAD_DIR, doc.storedName);
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || stat.size === 0) throw new MailError('Your file could not be processed. Please upload it again.', 400, 'Stored invoice file missing or empty');

  const recipients = process.env.INVOICE_RECIPIENT_EMAIL.split(',').map((r) => r.trim()).filter(Boolean);
  if (!recipients.length || !recipients.every((r) => EMAIL_RE.test(r)))
    throw new MailError('Accounts email is misconfigured. Please contact the accounts team.', 503, 'INVOICE_RECIPIENT_EMAIL is not a valid address');

  const safeName = path.basename(doc.originalName).replace(/[^\w.\- ]/g, '_');
  const from = process.env.INVOICE_MAIL_FROM || process.env.SMTP_USER; // system sender, NOT supplier

  const subject = `New Supplier Invoice from ${doc.supplierEmail}`; // supplier email already validated (no newlines)
  const text =
`Dear Team,

A new invoice document has been uploaded by a supplier.

Supplier Email: ${doc.supplierEmail}

Please find the invoice document attached.

Regards,
Supplier Invoice Portal`;

  if (useGmail()) {
    try {
      return await sendViaGmail({ from, recipients, replyTo: doc.supplierEmail, subject, text, filename: safeName, filePath, contentType: doc.mimeType });
    } catch (err) {
      if (err instanceof MailError) throw err;
      throw new MailError('Could not reach the email service. Please try again shortly.', 503, `${err.name}: ${err.message}`);
    }
  }

  let info;
  try {
    info = await getTransporter().sendMail({
      from,
      to: recipients,
      replyTo: doc.supplierEmail, // lets accounts reply to the supplier without spoofing the sender
      subject,
      text,
      attachments: [{ filename: safeName, path: filePath, contentType: doc.mimeType }],
    });
  } catch (err) {
    throw classifyMailError(err);
  }

  // Do not trust "no exception" — confirm the SMTP server accepted every recipient.
  console.log('[supplier-invoice] SMTP result:', JSON.stringify({
    id: String(doc._id), messageId: info.messageId, accepted: info.accepted,
    rejected: info.rejected, response: info.response,
  }));
  const accepted = (info.accepted || []).map((a) => String(a).toLowerCase());
  const allAccepted = recipients.every((r) => accepted.includes(r.toLowerCase()));
  if (!allAccepted || (info.rejected && info.rejected.length))
    throw new MailError('The accounts email address was rejected by the mail server. Please contact the accounts team.', 502,
      `Rejected by SMTP: ${JSON.stringify(info.rejected)} response=${info.response}`);
  if (!/^2\d\d/.test(String(info.response || '250')))
    throw new MailError('The invoice could not be emailed. Please try again.', 502, `Unexpected SMTP response: ${info.response}`);

  return info.messageId;
};

// Returns { doc, error } — never throws; status is persisted either way.
const trySend = async (doc) => {
  doc.attempts += 1;
  let error = null;
  try {
    doc.messageId = await sendInvoiceMail(doc);
    doc.status = 'sent';
    doc.sentAt = new Date();
    doc.lastError = '';
  } catch (err) {
    error = classifyMailError(err);
    doc.status = 'failed';
    doc.lastError = String(error.message).slice(0, 500);
    console.error('[supplier-invoice] email failed:', String(doc._id), error.message);
  }
  await doc.save();
  return { doc, error };
};

// ---------- PUBLIC: supplier submit ----------
router.post('/', (req, res) => {
  upload.single('invoice')(req, res, async (uploadErr) => {
    const file = req.file;
    const discard = () => file && fs.unlink(file.path, () => {});

    if (uploadErr) {
      return res.status(400).json({
        message: uploadErr.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 10 MB)' : uploadErr.message,
      });
    }

    const email = String(req.body.supplierEmail || '').trim().toLowerCase();
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
      discard();
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }
    if (!file) return res.status(400).json({ message: 'Please upload an invoice document' });
    if (!hasValidSignature(file.path)) {
      discard();
      return res.status(400).json({ message: 'Invalid or corrupted file' });
    }

    try {
      const doc = await SupplierInvoice.create({
        supplierEmail: email,
        originalName: file.originalname,
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
      });
      // Wait for the SMTP server's answer before telling the supplier anything.
      const { error } = await trySend(doc);
      if (error) return res.status(error.status).json({ message: error.publicMessage });
      return res.status(201).json({ message: 'Invoice submitted successfully' });
    } catch (err) {
      console.error('[supplier-invoice] save failed:', err);
      res.status(500).json({ message: 'Something went wrong. Please try again.' });
    }
  });
});

// ---------- ADMIN: list + retry ----------
router.get('/admin/list', protect, adminOnly, async (req, res) => {
  const items = await SupplierInvoice.find().sort({ createdAt: -1 }).limit(200).select('-storedName');
  res.json(items);
});

router.post('/admin/:id/retry', protect, adminOnly, async (req, res) => {
  const doc = await SupplierInvoice.findById(req.params.id);
  if (!doc) return res.status(404).json({ message: 'Not found' });
  if (doc.status === 'sent') return res.status(409).json({ message: 'Already sent' });
  await trySend(doc);
  res.json({ status: doc.status, lastError: doc.lastError });
});

// ADMIN: verify SMTP login/connection from the deployed server (never exposes secrets)
router.get('/admin/mail-check', protect, adminOnly, async (req, res) => {
  const missing = missingEnv();
  if (missing.length) return res.status(503).json({ ok: false, missingEnv: missing });
  if (useGmail()) {
    try {
      await getGoogleAccessToken();
      return res.json({ ok: true, mode: 'gmail-api', from: process.env.INVOICE_MAIL_FROM });
    } catch (err) { return res.status(err.status || 502).json({ ok: false, mode: 'gmail-api', error: err.message }); }
  }
  try {
    await getTransporter().verify();
    res.json({ ok: true, host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), user: process.env.SMTP_USER });
  } catch (err) {
    res.status(502).json({ ok: false, error: classifyMailError(err).message });
  }
});

module.exports = router;
