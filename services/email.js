require('dotenv').config(); 
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT || '587', 10),
  secure: process.env.EMAIL_SECURE === 'true' || false, // set EMAIL_SECURE=true for port 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Send an email.
 * @param {string} to - recipient email (comma-separated allowed)
 * @param {string} subject - email subject
 * @param {string} html - html body
 */
async function sendEmail(to, subject, html) {
  if (!to) {
    console.log('sendEmail: no recipient provided, skipping.');
    return;
  }

  const mail = {
    from: `"SuperSheldon" <${process.env.EMAIL_USER}>`,
    to,
    subject,
    html
  };

  try {
    const info = await transporter.sendMail(mail);
    console.log('Email sent →', to, 'messageId:', info.messageId);
    return { ok: true, info };
  } catch (err) {
    console.error('Email error →', err && err.message ? err.message : err);
    return { ok: false, error: err };
  }
}

module.exports = { sendEmail };
