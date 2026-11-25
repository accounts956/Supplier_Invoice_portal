require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
// CORS_ORIGIN may be a comma-separated list, e.g. https://a.vercel.app,https://b.vercel.app
const origins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);
app.use(cors({ origin: origins }));
app.use(express.json());

app.get('/', (req, res) => res.send('Supplier Invoice API is running'));
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/supplier-invoices', require('./modules/supplier-invoice/routes')); // ✅ NEW

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/supplier_invoice');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
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