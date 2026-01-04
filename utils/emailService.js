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

// FIXED: Use ADMIN_EMAIL and ADMIN_EMAIL_PASSWORD from environment variables
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_EMAIL_PASSWORD = process.env.ADMIN_EMAIL_PASSWORD || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
const SMTP_USER = ADMIN_EMAIL; // Use admin email as SMTP user
const SMTP_PASS = ADMIN_EMAIL_PASSWORD; // Use admin email password
const FROM_EMAIL = ADMIN_EMAIL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';

// transporter instance (lazy)
let transporter = null;
let transporterReady = false;

const createTransporter = async () => {
  // If already created, return
  if (transporter || transporterReady) return transporter;

  // If nodemailer missing, mark not ready and return null
  if (!nodemailer) {
    transporterReady = false;
    console.error('[emailService] Nodemailer not installed. Please install: npm install nodemailer');
    return null;
  }

  try {
    // Option 1: explicit SMTP config using Gmail
    if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
      console.log('[emailService] Creating SMTP transporter with config:', {
        host: SMTP_HOST,
        port: SMTP_PORT,
        user: SMTP_USER,
        hasPassword: !!SMTP_PASS
      });

      // Remove spaces from password if present (common copy-paste issue)
      const cleanedPassword = SMTP_PASS.replace(/\s+/g, '');
      
      transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_PORT === 465, // true for 465, false for other ports
        auth: {
          user: SMTP_USER,
          pass: cleanedPassword
        },
        // For Gmail, you might need to enable "Less secure app access" or use OAuth2
        // For now, we'll use the basic auth
        tls: {
          rejectUnauthorized: false // Allow self-signed certificates in development
        }
      });

      // verify transporter (best-effort)
      try {
        await transporter.verify();
        transporterReady = true;
        console.info('[emailService] SMTP transporter created & verified successfully.');
        return transporter;
      } catch (vErr) {
        transporterReady = false;
        console.error('[emailService] SMTP transporter verification failed:', vErr && vErr.message ? vErr.message : vErr);
        
        // Try alternative configuration for Gmail
        if (SMTP_HOST.includes('gmail.com')) {
          console.log('[emailService] Trying alternative Gmail configuration...');
          transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
              user: SMTP_USER,
              pass: cleanedPassword
            },
            tls: {
              rejectUnauthorized: false
            }
          });
          
          try {
            await transporter.verify();
            transporterReady = true;
            console.info('[emailService] Alternative Gmail transporter verified.');
            return transporter;
          } catch (gmailErr) {
            console.error('[emailService] Alternative Gmail configuration also failed:', gmailErr && gmailErr.message ? gmailErr.message : gmailErr);
          }
        }
        return transporter; // return transporter even if verification failed
      }
    }

    // Option 2: SendGrid via API key using nodemailer-sendgrid-transport (if installed)
    if (SENDGRID_API_KEY) {
      try {
        // require on demand to avoid mandatory dep
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
    console.error('[emailService] No valid SMTP configuration found. Check your environment variables:');
    console.error('[emailService] ADMIN_EMAIL:', ADMIN_EMAIL ? 'Set' : 'Not set');
    console.error('[emailService] ADMIN_EMAIL_PASSWORD:', ADMIN_EMAIL_PASSWORD ? 'Set' : 'Not set');
    console.error('[emailService] Email sending is disabled (emails will be logged).');
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
    console.error('[emailService] Failed to create transporter:', e && e.message ? e.message : e);
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

    console.log('[emailService] Attempting to send email to:', to);
    
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('[emailService] Email sent successfully:', info.messageId);
      // nodemailer returns 'info' object; return it for debugging
      return { success: true, info };
    } catch (sendErr) {
      console.error('[emailService] Failed to send email:', sendErr && sendErr.message ? sendErr.message : sendErr);
      
      // Provide more helpful error messages for common issues
      let errorMessage = sendErr.message;
      if (sendErr.code === 'EAUTH') {
        errorMessage = 'Authentication failed. Check your email credentials.';
        console.error('[emailService] Authentication error. For Gmail:');
        console.error('[emailService] 1. Enable "Less secure app access" at https://myaccount.google.com/lesssecureapps');
        console.error('[emailService] 2. Or use an App Password: https://support.google.com/accounts/answer/185833');
      } else if (sendErr.code === 'ECONNECTION') {
        errorMessage = 'Connection to email server failed. Check SMTP settings.';
      }
      
      return { success: false, error: new Error(errorMessage) };
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
    return { success: false, error: new Error('Email service not configured. Check server logs.') };
  } catch (logErr) {
    // If logging somehow fails, still return non-throwing response
    console.warn('[emailService] Failed to log email preview:', logErr && logErr.message ? logErr.message : logErr);
    return { success: false, error: new Error('Email service error') };
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