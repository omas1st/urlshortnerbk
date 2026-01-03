// controllers/redirectController.js
const Url = require('../models/Url');
const Click = require('../models/Click'); // optional: log clicks
const encryptionService = require('../config/encryption');
const bcrypt = require('bcryptjs'); // if not installed, see notes below
const sanitize = require('mongo-sanitize'); // defensive

// TTL (seconds) for splash auto-redirect. You can tweak this value.
const SPLASH_REDIRECT_SECONDS = 3;

/**
 * Helper: render simple password entry HTML (POSTs back to same URL)
 */
const renderPasswordForm = (shortId, message = null) => {
  const msgHtml = message ? `<p style="color:#b00;margin:10px 0">${message}</p>` : '';
  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Protected link</title>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f7f7f7}
        .card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,0.08);max-width:420px;width:100%}
        input[type=password]{width:100%;padding:10px 12px;margin-top:8px;margin-bottom:12px;border-radius:8px;border:1px solid #ddd}
        button{padding:10px 16px;border:none;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer}
        .hint{font-size:13px;color:#666;margin-top:8px}
      </style>
    </head>
    <body>
      <div class="card" role="main" aria-labelledby="title">
        <h2 id="title">This link is password protected</h2>
        ${msgHtml}
        <form method="POST" action="/s/${encodeURIComponent(shortId)}">
          <label for="password">Enter password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <!-- preserve skipSplash hint if caller passed skipSplash -->
          <input type="hidden" name="skipSplash" value="0" />
          <div style="display:flex;gap:8px;margin-top:8px">
            <button type="submit">Continue</button>
            <a href="/" style="align-self:center;color:#1f6feb;text-decoration:none">Cancel</a>
          </div>
          <p class="hint">If you were given a password — enter it to proceed to the destination.</p>
        </form>
      </div>
    </body>
  </html>
  `;
};

/**
 * Helper: render splash page HTML (shows splash image + auto redirect JS)
 * Assumes password already validated (if required).
 */
const renderSplashPage = ({ shortId, splashImage, loadingPageText = 'Redirecting...', destination }) => {
  const safeDestination = encodeURI(destination || '/');
  const seconds = SPLASH_REDIRECT_SECONDS;
  return `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>Redirecting…</title>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta http-equiv="refresh" content="${seconds};url=${safeDestination}">
      <style>
        html,body{height:100%;margin:0}
        body{display:flex;align-items:center;justify-content:center;background:#111;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial}
        .wrap{max-width:900px;width:100%;padding:20px;text-align:center}
        .splash-img{max-width:100%;height:auto;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5)}
        .text{margin-top:18px;font-size:18px}
        .action{margin-top:14px}
        .btn{display:inline-block;padding:10px 16px;border-radius:8px;background:#fff;color:#111;text-decoration:none;font-weight:600}
        .count{opacity:0.85;margin-left:8px;font-weight:700}
      </style>
    </head>
    <body>
      <div class="wrap" role="main" aria-live="polite">
        <img class="splash-img" src="${splashImage}" alt="Redirect splash" />
        <div class="text">${loadingPageText} <span class="count">(${seconds})</span></div>
        <div class="action">
          <a id="continue" class="btn" href="${safeDestination}">Continue now</a>
        </div>
      </div>

      <script>
        // Countdown and redirect (page also has meta refresh as fallback)
        (function(){
          var seconds = ${seconds};
          var el = document.querySelector('.count');
          var t = setInterval(function(){
            seconds--;
            if(el) el.textContent = '(' + seconds + ')';
            if(seconds <= 0){
              clearInterval(t);
            }
          }, 1000);
          // prevent open redirect by ensuring destination is absolute OR begins with http(s)
          // (server already controls destination)
        }());
      </script>
    </body>
  </html>
  `;
};

const safeFindUrl = async (shortId) => {
  if (!shortId) return null;
  const clean = sanitize(shortId);
  return Url.findOne({ shortId: clean }).lean ? await Url.findOne({ shortId: clean }) : await Url.findOne({ shortId: clean });
};

/**
 * Main redirect handler
 * Accepts GET and POST to same endpoint:
 *  - GET /s/:shortId           -> show password form if required, or splash/redirect
 *  - POST /s/:shortId (password form) -> validate password, then splash/redirect
 */
const handleRedirect = async (req, res) => {
  try {
    const shortId = req.params.shortId;
    const url = await safeFindUrl(shortId);

    if (!url) {
      return res.status(404).send('URL not found');
    }

    // Check activation/expiration
    if (url.isActive === false) {
      return res.status(410).send('This link is inactive');
    }
    if (url.expirationDate && new Date() > new Date(url.expirationDate)) {
      return res.status(410).send('This link has expired');
    }

    // Password protection
    if (url.password) {
      // get provided password from POST body OR query param
      const providedPassword = (req.method === 'POST' ? (req.body && req.body.password) : (req.query && req.query.password)) || '';

      // if no password provided, show password form
      if (!providedPassword) {
        return res.send(renderPasswordForm(shortId));
      }

      // Compare — support bcrypt-hashed stored password OR plain-text stored password
      let ok = false;
      try {
        if (typeof url.password === 'string' && /^\$2[aby]\$/.test(url.password)) {
          // bcrypt hash
          ok = await bcrypt.compare(providedPassword, url.password);
        } else {
          // plain-text comparison (trim both sides)
          ok = String(providedPassword).trim() === String(url.password).trim();
        }
      } catch (err) {
        ok = false;
      }

      if (!ok) {
        // Password provided but incorrect: show form with message
        return res.send(renderPasswordForm(shortId, 'Incorrect password. Please try again.'));
      }
      // password OK — continue to splash/redirect
    }

    // Resolve destination (decrypt if necessary)
    let destination = url.destinationUrl || '/';
    try {
      if (encryptionService && typeof encryptionService.decrypt === 'function') {
        // Use decrypt if destination is encrypted
        destination = encryptionService.decrypt(destination);
      }
    } catch (e) {
      // ignore and use stored destination
    }

    // Optionally: log click (do it after password check, because only after password is granted)
    (async () => {
      try {
        if (Click) {
          await Click.create({
            urlId: url._id,
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            referrer: req.get('Referer') || null,
            timestamp: new Date()
          });
          // increment clicks counter safely
          await Url.updateOne({ _id: url._id }, { $inc: { clicks: 1 } }).catch(()=>{});
        }
      } catch (e) {
        // logging non-fatal
        // console.warn('click log failed', e.message);
      }
    })();

    // If splash exists and visitor hasn't explicitly skipped it, show it first
    // Allow skip via query ?skipSplash=1 or POST body skipSplash === '1'
    const skipSplash = (req.query && req.query.skipSplash === '1') || (req.body && (req.body.skipSplash === '1' || req.body.skipSplash === 1));

    if (url.splashImage && !skipSplash) {
      // Render lightweight splash HTML which will auto-redirect
      return res.send(renderSplashPage({
        shortId,
        splashImage: url.splashImage,
        loadingPageText: url.loadingPageText || 'Redirecting...',
        destination
      }));
    }

    // No splash: direct redirect
    // Use 302 temporary redirect. It's fine to change to 301 if permanent.
    return res.redirect(302, destination);
  } catch (error) {
    console.error('Redirect handler error:', error);
    return res.status(500).send('Server error');
  }
};

module.exports = {
  handleRedirect
};
