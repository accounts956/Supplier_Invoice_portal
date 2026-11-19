require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:3000' }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api/supplier-invoices', require('./modules/supplier-invoice/routes')); // ✅ NEW

const PORT = process.env.PORT || 5000;
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/supplier_invoice')
  .then(() => app.listen(PORT, () => {
    console.log(`API running on http://localhost:${PORT}`);
    // Keep-alive: Render's free tier sleeps after ~15 min without inbound traffic.
    if (process.env.RENDER_EXTERNAL_URL) {
      setInterval(() => {
        fetch(`${process.env.RENDER_EXTERNAL_URL}/api/health`).catch((e) => console.warn('keep-alive ping failed:', e.message));
      }, 10 * 60 * 1000).unref();
    }
  }))
  .catch((err) => { console.error('MongoDB connection failed:', err.message); process.exit(1); });
