// utils/emailService.js
// Robust, defensive email sender for local/dev and production.
// - Uses nodemailer when SMTP config is present.
// - Falls back to a no-op logger when no SMTP config is provided.
// - Returns a stable result object: { success: boolean, info?, error? }

const util = require('util');

let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer not installed — we'll gracefully fall back to logger behavior.
  nodemailer = null;
  console.warn('[emailService] nodemailer not installed; email sending disabled.');
}

const SMTP_HOST = process.env.SMTP_HOST || process.env.EMAIL_HOST || '';
const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : undefined;
const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.EMAIL_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || process.env.SMTP_FROM || process.env.ADMIN_EMAIL || 'no-reply@example.com';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || process.env.SENDGRID_API_KEY || '';

// transporter instance (lazy)
let transporter = null;
let transporterReady = false;

const createTransporter = async () => {
  // If already created, return
  if (transporter || transporterReady) return transporter;

  // If nodemailer missing, mark not ready and return null
  if (!nodemailer) {
    transporterReady = false;
    return null;
  }

  try {
    // Option 1: explicit SMTP config
    if (SMTP_HOST && SMTP_USER) {
      const secure = SMTP_PORT === 465; // common secure port
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT || (secure ? 465 : 587),
        secure: secure,
        auth: {
          user: SMTP_USER,
          pass: SMTP_PASS
        },
        // allow self-signed certs in dev if explicitly set (not recommended in prod)
        tls: {
          rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false'
        }
      });
      // verify transporter (best-effort)
      try {
        await transporter.verify();
        transporterReady = true;
        console.info('[emailService] SMTP transporter created & verified.');
      } catch (vErr) {
        transporterReady = false;
        console.warn('[emailService] SMTP transporter created but verification failed:', vErr && vErr.message ? vErr.message : vErr);
      }
      return transporter;
    }

    // Option 2: SendGrid via API key using nodemailer-sendgrid-transport (if installed)
    if (SENDGRID_API_KEY) {
      try {
        // require on demand to avoid mandatory dep
        // if plugin not installed, fall back to direct API or logger
        const sgTransport = require('nodemailer-sendgrid-transport');
        transporter = nodemailer.createTransport(sgTransport({
          auth: { api_key: SENDGRID_API_KEY }
        }));
        try {
          await transporter.verify();
          transporterReady = true;
          console.info('[emailService] SendGrid transporter created & verified.');
        } catch (vErr) {
          transporterReady = false;
          console.warn('[emailService] SendGrid transporter created but verification failed:', vErr && vErr.message ? vErr.message : vErr);
        }
        return transporter;
      } catch (e) {
        // nodemailer-sendgrid-transport not installed — fall through to logger fallback
        console.warn('[emailService] nodemailer-sendgrid-transport not installed; cannot create SendGrid transporter.');
      }
    }

    // Option 3: no SMTP config — keep transporter null
    transporterReady = false;
    console.info('[emailService] No SMTP config found; email sending is disabled (emails will be logged).');
    return null;
  } catch (err) {
    transporter = null;
    transporterReady = false;
    console.error('[emailService] createTransporter error:', err && err.message ? err.message : err);
    return null;
  }
};

/**
 * sendEmail(options)
 * options: { to, subject, text, html, from }
 * Returns: { success: boolean, info?: object, error?: Error }
 */
async function sendEmail(options = {}) {
  const { to, subject, text, html, from } = options;

  // Basic validation
  if (!to) {
    return { success: false, error: new Error('Missing "to" address') };
  }
  if (!subject) {
    return { success: false, error: new Error('Missing "subject"') };
  }

  // Ensure transporter created (best-effort)
  try {
    await createTransporter();
  } catch (e) {
    // createTransporter guards itself, but swallow errors here
  }

  // If transporter is ready, send email
  if (transporter && transporterReady) {
    const mailOptions = {
      from: from || FROM_EMAIL,
      to,
      subject,
      text: text || (html ? stripHtml(html) : ''),
      html: html || undefined
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      // nodemailer returns 'info' object; return it for debugging
      return { success: true, info };
    } catch (sendErr) {
      console.error('[emailService] Failed to send email:', sendErr && sendErr.message ? sendErr.message : sendErr);
      return { success: false, error: sendErr };
    }
  }

  // Fallback: do not throw — log the email contents so dev can inspect
  try {
    const safePreview = {
      from: from || FROM_EMAIL,
      to,
      subject,
      text: text || stripHtml(html || '') || '',
      // don't include long html bodies in logs by default, but include a note
      htmlPreview: html ? (html.length > 1000 ? `${html.slice(0, 1000)}... (truncated)` : html) : undefined
    };
    console.info('[emailService] Email not sent (no transporter). Logging preview:', util.inspect(safePreview, { depth: 2, breakLength: 120 }));
    return { success: false, error: new Error('No email transporter configured; email logged to server console') };
  } catch (logErr) {
    // If logging somehow fails, still return non-throwing response
    console.warn('[emailService] Failed to log email preview:', logErr && logErr.message ? logErr.message : logErr);
    return { success: false, error: new Error('No email transporter and logging failed') };
  }
}

// small helper to strip HTML tags for text fallback
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html.replace(/<\/?[^>]+(>|$)/g, '');
}

// Expose a function to manually initialize transporter (useful for startup diagnostics)
async function initEmailService() {
  await createTransporter();
  if (transporter && transporterReady) {
    return { success: true, message: 'Email transporter ready' };
  }
  return { success: false, message: 'Email transporter not configured or not ready' };
}

module.exports = {
  sendEmail,
  initEmailService,
  _internal: {
    get transporter() { return transporter; },
    get transporterReady() { return transporterReady; }
  }
};
