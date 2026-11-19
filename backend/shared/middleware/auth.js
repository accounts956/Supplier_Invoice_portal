// Simple admin guard: expects "Authorization: Bearer <ADMIN_TOKEN>".
// Replace with your real auth (JWT etc.) if you have one.
const crypto = require('crypto');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const protect = (req, res, next) => {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(500).json({ message: 'ADMIN_TOKEN not configured' });
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !safeEqual(token, expected)) return res.status(401).json({ message: 'Unauthorized' });
  req.user = { role: 'admin' };
  next();
};

const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ message: 'Forbidden' });

module.exports = { protect, adminOnly };
