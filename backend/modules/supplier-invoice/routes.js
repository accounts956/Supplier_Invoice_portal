const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { google } = require('googleapis');
const MailComposer = require('nodemailer/lib/mail-composer'); // MIME builder only (no SMTP transport is created)
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
// ---------- mail: Gmail API over HTTPS (OAuth 2.0), scope gmail.send only ----------
// Works on Render Free, which blocks outbound SMTP (ports 25/465/587).
const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'INVOICE_MAIL_FROM', 'INVOICE_RECIPIENT_EMAIL'];
const missingEnv = () => REQUIRED_ENV.filter((k) => !String(process.env[k] || '').trim());

// Error carrying a supplier-safe message + HTTP status. Raw Google details go to logs/DB only.
class MailError extends Error {
  constructor(publicMessage, status, detail) {
    super(detail || publicMessage);
    this.publicMessage = publicMessage;
    this.status = status;
  }
}

let oauthClient;
const getOAuthClient = () => {
  if (!oauthClient) {
    oauthClient = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    oauthClient.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return oauthClient;
};
const getGmail = () => google.gmail({ version: 'v1', auth: getOAuthClient() });

// Translate a googleapis / network failure into a MailError
const classifyMailError = (err) => {
  if (err instanceof MailError) return err;
  const data = (err.response && err.response.data) || {};
  const status = Number((err.response && err.response.status) || (typeof err.code === 'number' ? err.code : 0)) || 0;
  const reason = typeof data.error === 'string' ? data.error : (data.error && (data.error.status || data.error.message)) || '';
  const detail = `${status || err.code || 'ERR'} ${reason} ${data.error_description || ''} ${err.message || ''}`.replace(/\s+/g, ' ').trim();
  const msg = `${reason} ${err.message}`;

  if (/invalid_grant|invalid_client|unauthorized_client/i.test(msg) || status === 401 ||
      (status === 403 && /insufficient|scope|disabled|not been used|access.?not.?configured/i.test(msg)))
    return new MailError('Email service authentication failed. Please contact the accounts team.', 502, detail);
  if (status === 429 || (status === 403 && /rate|quota|limit/i.test(msg)))
    return new MailError('The email service is temporarily over its sending limit. Please try again later.', 503, detail);
  if (status === 400)
    return new MailError('The invoice could not be emailed (rejected by the email service).', 502, detail);
  if (!status && /ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|ESOCKET|EHOSTUNREACH|socket hang up|network|timeout|fetch failed/i.test(`${err.code} ${err.message}`))
    return new MailError('Could not reach the email service. Please try again shortly.', 503, detail);
  return new MailError('The invoice could not be emailed. Please try again.', 502, detail);
};

const sendInvoiceMail = async (doc) => {
  const missing = missingEnv();
  if (missing.length)
    throw new MailError('Email is not configured on the server. Please contact the accounts team.', 503,
      `Missing env vars: ${missing.join(', ')}`);

  const filePath = path.join(UPLOAD_DIR, doc.storedName);
  let stat;
  try { stat = fs.statSync(filePath); } catch { stat = null; }
  if (!stat || stat.size === 0)
    throw new MailError('Your file could not be processed. Please upload it again.', 400, 'Stored invoice file missing or empty');

  const recipients = process.env.INVOICE_RECIPIENT_EMAIL.split(',').map((r) => r.trim()).filter(Boolean);
  if (!recipients.length || !recipients.every((r) => EMAIL_RE.test(r)))
    throw new MailError('Accounts email is misconfigured. Please contact the accounts team.', 503, 'INVOICE_RECIPIENT_EMAIL is not a valid address');

  const fromRaw = process.env.INVOICE_MAIL_FROM.trim();
  const fromAddress = (fromRaw.match(/<([^>]+)>/) || [null, fromRaw])[1].trim();
  const safeName = path.basename(doc.originalName).replace(/[^\w.\- ]/g, '_');

  // Build the RFC 822 message with the real file attached
  let raw;
  try {
    raw = await new Promise((resolve, reject) =>
      new MailComposer({
        // Gmail always sends as the authenticated mailbox, so show the supplier as the sender NAME;
        // Reply-To makes replies go straight to the supplier.
        from: { name: `${doc.supplierEmail} (via Supplier Invoice Portal)`, address: fromAddress },
        to: recipients,
        replyTo: doc.supplierEmail,
        subject: `New Supplier Invoice from ${doc.supplierEmail}`, // supplier email already validated (no newlines)
        text:
`Dear Team,

A new invoice document has been uploaded by a supplier.

Supplier Email: ${doc.supplierEmail}

Please find the invoice document attached.

Regards,
Supplier Invoice Portal`,
        attachments: [{ filename: safeName, path: filePath, contentType: doc.mimeType }],
      }).compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
  } catch (err) {
    throw new MailError('Your file could not be attached. Please upload it again.', 400, `Attachment build failed: ${err.message}`);
  }
  const encoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  let result;
  try {
    result = await getGmail().users.messages.send({ userId: 'me', requestBody: { raw: encoded } }, { timeout: 45000 });
  } catch (err) {
    throw classifyMailError(err);
  }

  // Success only if Gmail accepted the message AND returned a message id.
  const data = result && result.data;
  if (!result || result.status < 200 || result.status >= 300 || !data || !data.id)
    throw new MailError('The invoice could not be emailed. Please try again.', 502,
      `Gmail did not confirm acceptance: status=${result && result.status}`);
  console.log('[supplier-invoice] Gmail accepted:', JSON.stringify({ id: String(doc._id), gmailMessageId: data.id, labels: data.labelIds }));
  return data.id;
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
      // Wait for Gmail's confirmation before telling the supplier anything.
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

// ADMIN: verify the Gmail OAuth credentials from the deployed server (never exposes secrets)
router.get('/admin/mail-check', protect, adminOnly, async (req, res) => {
  const missing = missingEnv();
  if (missing.length) return res.status(503).json({ ok: false, missingEnv: missing });
  try {
    await getOAuthClient().getAccessToken();
    res.json({ ok: true, mode: 'gmail-api', from: process.env.INVOICE_MAIL_FROM });
  } catch (err) {
    res.status(502).json({ ok: false, mode: 'gmail-api', error: classifyMailError(err).message });
  }
});

module.exports = router;
