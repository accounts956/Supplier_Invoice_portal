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
let transporter;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 15000, // ✅ NEW
      greetingTimeout: 15000,   // ✅ NEW
      socketTimeout: 30000,     // ✅ NEW
    });
  }
  return transporter;
};

const sendInvoiceMail = async (doc) => {
  const filePath = path.join(UPLOAD_DIR, doc.storedName);
  if (!fs.existsSync(filePath)) throw new Error('Stored invoice file not found');

  // ✅ NEW: send via Brevo HTTPS API when BREVO_API_KEY is set (SMTP is blocked on Render free tier)
  if (process.env.BREVO_API_KEY) {
    const to = String(process.env.INVOICE_RECIPIENT_EMAIL || '').trim();
    if (!EMAIL_RE.test(to)) throw Object.assign(new Error('INVOICE_RECIPIENT_EMAIL missing/invalid'), { code: 'EENVELOPE' });
    const name = path.basename(doc.originalName).replace(/[^\w.\- ]/g, '_');
    let r;
    try {
      r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: process.env.INVOICE_MAIL_FROM, name: 'Supplier Invoice Portal' },
          to: [{ email: to }],
          subject: 'New Supplier Invoice Received',
          textContent: `Dear Team,\n\nA new invoice document has been uploaded by a supplier.\n\nSupplier Email: ${doc.supplierEmail}\n\nPlease find the invoice document attached.\n\nRegards,\nSupplier Invoice Portal`,
          attachment: [{ name, content: fs.readFileSync(filePath).toString('base64') }],
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      throw Object.assign(new Error('Brevo unreachable: ' + e.message), { code: 'ECONNECTION' });
    }
    const body = await r.text();
    console.log('[supplier-invoice] Brevo:', r.status, body);
    if (!r.ok) throw Object.assign(new Error(`Brevo ${r.status}: ${body}`.slice(0, 400)), { code: r.status === 401 || r.status === 403 ? 'EAUTH' : r.status === 400 ? 'EENVELOPE' : 'EAPI' });
    return JSON.parse(body).messageId;
  }

  // ✅ NEW: fail loudly on missing config
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)
    throw Object.assign(new Error('SMTP env vars missing'), { code: 'ECONFIG' });
  if (!EMAIL_RE.test(String(process.env.INVOICE_RECIPIENT_EMAIL || '').trim()))
    throw Object.assign(new Error('INVOICE_RECIPIENT_EMAIL missing/invalid'), { code: 'EENVELOPE' });

  const safeName = path.basename(doc.originalName).replace(/[^\w.\- ]/g, '_');
  const info = await getTransporter().sendMail({
    from: process.env.INVOICE_MAIL_FROM || process.env.SMTP_USER, // system sender, NOT supplier
    to: process.env.INVOICE_RECIPIENT_EMAIL,                      // admin-configured recipient
    subject: 'New Supplier Invoice Received',
    text:
`Dear Team,

A new invoice document has been uploaded by a supplier.

Supplier Email: ${doc.supplierEmail}

Please find the invoice document attached.

Regards,
Supplier Invoice Portal`,
    attachments: [{ filename: safeName, path: filePath, contentType: doc.mimeType }],
  });

  // ✅ NEW: confirm SMTP actually accepted the message
  console.log('[supplier-invoice] SMTP:', info.response, '| accepted:', info.accepted, '| rejected:', info.rejected);
  if (!info.accepted || !info.accepted.length || (info.rejected && info.rejected.length))
    throw Object.assign(new Error('SMTP rejected the recipient'), { code: 'EENVELOPE' });

  return info.messageId;
};

const trySend = async (doc) => {
  doc.attempts += 1;
  try {
    doc.messageId = await sendInvoiceMail(doc);
    doc.status = 'sent';
    doc.sentAt = new Date();
    doc.lastError = '';
  } catch (err) {
    doc.status = 'failed';
    doc.lastError = String(err.message || err).slice(0, 500);
    doc._errCode = err.code; // ✅ NEW (plain property, not saved to DB)
    console.error('[supplier-invoice] email failed:', doc._id, doc.lastError);
    console.error('[supplier-invoice] SMTP error code:', err.code, '| response:', err.response); // ✅ NEW
  }
  await doc.save();
  return doc;
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

      // ✅ NEW: wait for the SMTP result before replying (replaces the early 201 + background send)
      const sent = await trySend(doc);
      if (sent.status !== 'sent') {
        const c = sent._errCode;
        const msg =
          c === 'EAUTH' ? 'Email service login failed. Please contact the accounts team.' :
          c === 'EENVELOPE' ? 'The accounts email address was rejected. Please contact the accounts team.' :
          ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(c) ? 'Could not reach the email server. Please try again later.' :
          'Invoice could not be emailed. Please try again later.';
        return res.status(502).json({ message: msg });
      }
      res.status(201).json({ message: 'Invoice sent' });
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

module.exports = router;
