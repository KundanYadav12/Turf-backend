/**
 * PlayZo Email & Notification Service
 * Transporter: Nodemailer with Gmail SMTP
 * Features: Connection verification, graceful error handling, branded HTML templates
 */

const nodemailer = require('nodemailer');
const { APP_URL, buildPublicUrl } = require('../config/siteConfig');

// 1. Initialize Nodemailer Transporter
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const host = process.env.EMAIL_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.EMAIL_PORT || '587', 10);
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn('[EmailService] EMAIL_USER or EMAIL_PASS not configured. Emails will be logged to console.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  return transporter;
}

// Default From Address
const getDefaultFrom = () => process.env.EMAIL_FROM || `"PlayZo" <${process.env.EMAIL_USER || 'dealup24@gmail.com'}>`;

/**
 * Verifies SMTP connection without blocking server boot
 */
async function verifyConnection() {
  const t = getTransporter();
  if (!t) {
    return { success: false, message: 'SMTP credentials missing' };
  }

  try {
    await t.verify();
    console.log(`📧 [EmailService] SMTP connection verified successfully (${process.env.EMAIL_USER})`);
    return { success: true };
  } catch (error) {
    console.warn(`⚠️ [EmailService] SMTP verification warning: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Core generic email dispatcher
 * Safe execution: errors are caught and logged so API flows are not interrupted
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to) {
    console.warn('[EmailService] Recipient "to" address is required.');
    return { success: false, error: 'Recipient address required' };
  }

  const t = getTransporter();

  // If transporter not configured, log simulated email
  if (!t) {
    console.log(`[EmailService:Simulated] To: ${to} | Subject: ${subject}`);
    return { success: true, simulated: true };
  }

  const mailOptions = {
    from: getDefaultFrom(),
    to,
    subject,
    text: text || subject,
    html: html || `<p>${text || subject}</p>`
  };

  try {
    const info = await t.sendMail(mailOptions);
    console.log(`📧 [EmailService] Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [EmailService] Failed to send email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML Email Templates (Branded PlayZo Aesthetics)
// ─────────────────────────────────────────────────────────────────────────────

function renderEmailLayout({ title, preheader, bodyHtml, actionUrl, actionText }) {
  const currentYear = new Date().getFullYear();
  const webUrl = APP_URL || 'https://playzo.duckdns.org';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { margin: 0; padding: 0; background-color: #0b1120; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e2e8f0; }
    .container { max-width: 600px; margin: 30px auto; background-color: #0f172a; border-radius: 16px; border: 1px solid #1e293b; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5); }
    .header { background: linear-gradient(135deg, #059669 0%, #0d9488 50%, #0284c7 100%); padding: 32px 24px; text-align: center; }
    .header h1 { margin: 0; color: #ffffff; font-size: 26px; font-weight: 800; letter-spacing: -0.5px; }
    .header p { margin: 6px 0 0; color: #d1fae5; font-size: 14px; }
    .content { padding: 32px 28px; line-height: 1.6; color: #cbd5e1; font-size: 15px; }
    .card { background-color: #1e293b; border-radius: 12px; padding: 20px; margin: 20px 0; border: 1px solid #334155; }
    .btn { display: inline-block; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; font-size: 15px; margin: 24px 0 10px; text-align: center; }
    .footer { padding: 24px; text-align: center; font-size: 12px; color: #64748b; border-top: 1px solid #1e293b; }
    .footer a { color: #10b981; text-decoration: none; }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader || title}
  </div>
  <div class="container">
    <div class="header">
      <h1>⚡ PlayZo Sports</h1>
      <p>Your Premier Sports Booking & Tournament Platform</p>
    </div>
    <div class="content">
      ${bodyHtml}
      ${actionUrl && actionText ? `
        <div style="text-align: center;">
          <a href="${actionUrl}" class="btn" target="_blank">${actionText}</a>
        </div>
      ` : ''}
    </div>
    <div class="footer">
      <p>© ${currentYear} PlayZo Sports Platform. All rights reserved.</p>
      <p>
        <a href="${webUrl}">Visit PlayZo</a> • 
        <a href="${webUrl}/tournaments">Tournaments</a> • 
        <a href="${webUrl}/privacy-policy">Privacy Policy</a>
      </p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * 1. Send Welcome Email upon registration
 */
async function sendWelcomeEmail({ email, fullName, username }) {
  const subject = `Welcome to PlayZo, ${fullName || 'Athlete'}! 🏆`;
  const actionUrl = buildPublicUrl('/search');

  const bodyHtml = `
    <h2 style="color: #ffffff; margin-top: 0;">Welcome aboard, ${fullName || 'Sports Champion'}!</h2>
    <p>Your PlayZo account is officially ready. You can now book courts, discover live tournaments, manage team rosters, and compete in sports venues near you.</p>
    
    <div class="card">
      <p style="margin: 0 0 8px; color: #94a3b8; font-size: 13px;">ACCOUNT OVERVIEW</p>
      <p style="margin: 4px 0;"><strong>Username:</strong> <span style="color: #34d399;">@${username || 'athlete'}</span></p>
      <p style="margin: 4px 0;"><strong>Email:</strong> ${email}</p>
      <p style="margin: 4px 0;"><strong>Status:</strong> <span style="color: #34d399; font-weight: 600;">Active</span></p>
    </div>

    <p>Ready to hit the field? Explore local turf venues, reserve slots instantly, or join ongoing tournaments.</p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader: 'Welcome to PlayZo - Find sports venues, book slots, and enter tournaments.',
    bodyHtml,
    actionUrl,
    actionText: 'Find Venues & Book Now'
  });

  return await sendEmail({ to: email, subject, html, text: `Welcome to PlayZo, ${fullName}!` });
}

/**
 * 2. Send Slot Booking Confirmation Email
 */
async function sendBookingConfirmation({
  email,
  fullName,
  bookingNumber,
  venueName,
  courtName,
  bookingDate,
  startTime,
  endTime,
  finalAmount,
  qrCodeToken
}) {
  const subject = `Booking Confirmed: ${bookingNumber} at ${venueName || 'Venue'} 🎫`;
  const actionUrl = buildPublicUrl('/my-bookings');

  const bodyHtml = `
    <h2 style="color: #ffffff; margin-top: 0;">Your Slot is Confirmed!</h2>
    <p>Hello ${fullName || 'Valued Player'}, your turf reservation has been successfully booked and paid for.</p>
    
    <div class="card">
      <div style="display: flex; justify-content: space-between; margin-bottom: 12px; border-bottom: 1px solid #334155; padding-bottom: 8px;">
        <span style="color: #94a3b8; font-size: 13px;">BOOKING REFERENCE</span>
        <strong style="color: #38bdf8; font-size: 14px;">${bookingNumber}</strong>
      </div>
      <p style="margin: 6px 0;"><strong>Venue:</strong> ${venueName || 'Sports Arena'}</p>
      <p style="margin: 6px 0;"><strong>Court:</strong> ${courtName || 'Court 1'}</p>
      <p style="margin: 6px 0;"><strong>Date:</strong> ${bookingDate}</p>
      <p style="margin: 6px 0;"><strong>Time Slot:</strong> ${startTime} - ${endTime}</p>
      <p style="margin: 6px 0;"><strong>Total Paid:</strong> <span style="color: #34d399; font-weight: 700;">₹${parseFloat(finalAmount || 0).toFixed(2)}</span></p>
    </div>

    <p style="font-size: 13px; color: #94a3b8;">
      💡 <em>Tip: Show your booking code <strong>${bookingNumber}</strong> or the digital pass in your PlayZo account at the venue reception to check in.</em>
    </p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader: `Booking confirmation for ${bookingNumber} at ${venueName}`,
    bodyHtml,
    actionUrl,
    actionText: 'View My Bookings & Pass'
  });

  return await sendEmail({ to: email, subject, html, text: `Booking Confirmed: ${bookingNumber} at ${venueName}` });
}

/**
 * 3. Send Password Reset / Security Email
 */
async function sendPasswordResetEmail({ email, fullName, resetUrl }) {
  const subject = 'Reset your PlayZo password 🔒';

  const bodyHtml = `
    <h2 style="color: #ffffff; margin-top: 0;">Password Reset Request</h2>
    <p>Hello ${fullName || 'User'}, we received a request to reset the password for your PlayZo account.</p>
    
    <p>Click the button below to choose a new password. This link is valid for 1 hour for your security.</p>
    
    <p style="font-size: 13px; color: #94a3b8;">
      If you did not request a password reset, you can safely ignore this email; your account remains secure.
    </p>
  `;

  const html = renderEmailLayout({
    title: subject,
    preheader: 'Reset your PlayZo account password',
    bodyHtml,
    actionUrl: resetUrl,
    actionText: 'Reset Password'
  });

  return await sendEmail({ to: email, subject, html, text: `Reset your PlayZo password: ${resetUrl}` });
}

module.exports = {
  getTransporter,
  verifyConnection,
  sendEmail,
  sendWelcomeEmail,
  sendBookingConfirmation,
  sendPasswordResetEmail
};
