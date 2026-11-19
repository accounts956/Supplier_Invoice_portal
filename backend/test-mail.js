require('dotenv').config();
const nodemailer = require('nodemailer');

const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

(async () => {
  console.log('User:', process.env.SMTP_USER, '| Pass length:', (process.env.SMTP_PASS || '').length, '(should be 16)');
  try {
    await t.verify();
    console.log('SMTP login OK');
    const info = await t.sendMail({
      from: process.env.INVOICE_MAIL_FROM || process.env.SMTP_USER,
      to: process.env.INVOICE_RECIPIENT_EMAIL,
      subject: 'Test mail - Supplier Invoice Portal',
      text: 'SMTP works.',
    });
    console.log('Sent:', info.accepted);
  } catch (e) {
    console.error('FAILED:', e.message);
  }
})();
