require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer'); // ✅ NEW

const app = express();

const isProd = process.env.NODE_ENV === 'production' || !!process.env.RENDER; // ✅ NEW

// CORS_ORIGIN may be a comma-separated list, e.g. https://a.vercel.app,https://b.vercel.app
const origins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

// ✅ NEW: warn loudly if production is missing required env vars
if (isProd) {
  ['MONGO_URI', 'CORS_ORIGIN', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'INVOICE_RECIPIENT_EMAIL'].forEach((k) => {
    if (!process.env[k]) console.error(`[config] Missing environment variable: ${k}`);
  });
}

app.use(cors({ origin: origins }));
app.use(express.json());

app.get('/', (req, res) => res.send('Supplier Invoice API is running'));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/supplier-invoices', require('./modules/supplier-invoice/routes'));

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/supplier_invoice');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`API running on port ${PORT}`); // ✅ CHANGED: no localhost wording
    console.log('[config] Allowed CORS origins:', origins.join(', ')); // ✅ NEW

    // ✅ NEW: log SMTP connectivity at startup (shows in Render logs)
    if (process.env.SMTP_HOST) {
      nodemailer
        .createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === 'true',
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          connectionTimeout: 15000,
        })
        .verify()
        .then(() => console.log('[smtp] verify OK'))
        .catch((e) => console.error('[smtp] verify FAILED:', e.code, e.message));
    }

    // Keep-alive: Render's free tier sleeps after ~15 min without inbound traffic.
    if (process.env.RENDER_EXTERNAL_URL) {
      setInterval(() => {
        fetch(`${process.env.RENDER_EXTERNAL_URL}/api/health`).catch((e) =>
          console.warn('keep-alive ping failed:', e.message)
        );
      }, 10 * 60 * 1000).unref();
    }
  });
}

start();
