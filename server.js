// server.js - FIXED: Redirect to original URL when no matching rule found
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('mongo-sanitize');
const xss = require('xss');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const crypto = require('crypto');
const UA = require('ua-parser-js');
const cookieParser = require('cookie-parser');

// Import encryption service
const encryptionService = require('./config/encryption');

dotenv.config();

// Try to require geoip-lite if available (optional dependency)
let geoip = null;
try {
  // eslint-disable-next-line global-require
  geoip = require('geoip-lite');
} catch (err) {
  // Not fatal — country lookups will simply return 'Unknown' when geoip isn't available
  geoip = null;
}

 // Routes
const authRoutes = require('./routes/authRoutes');
const urlRoutes = require('./routes/urlRoutes');
const analyticsRoutes = require('./routes/analyticsRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const adminRoutes = require('./routes/adminRoutes');
const helpRoutes = require('./routes/helpRoutes');
const customDomainRoutes = require('./routes/customDomainRoutes');

const Url = require('./models/Url');
const Click = require('./models/Click');

const app = express();

// Trust proxy so req.ip and x-forwarded-for behave when behind a proxy/load-balancer
app.set('trust proxy', true);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Cookie'],
}));
// parse cookies (for cookie-based auth)
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// FIXED: Better URL normalization function
function normalizeUrl(dest) {
  if (!dest || typeof dest !== 'string') return null;

  let urlStr = dest.trim();
  if (!urlStr) return null;

  // Remove any surrounding quotes or brackets
  urlStr = urlStr.replace(/^["'()\[\]{}<>]+|["'()\[\]{}<>]+$/g, '');

  // Check if it's a valid URL format
  try {
    // If it already has a scheme
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(urlStr)) {
      const urlObj = new URL(urlStr);
      // Only allow http and https for redirects
      if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
        return urlStr;
      }
      return null; // Reject other protocols
    }
    
    // If scheme-relative URL (//example.com)
    if (urlStr.startsWith('//')) {
      const urlObj = new URL('https:' + urlStr);
      return urlObj.toString();
    }
    
    // If no scheme, try to add https://
    // Check if it looks like a domain
    if (/^[a-zA-Z0-9][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+(\/[^\s]*)?$/.test(urlStr) || 
        /^localhost(\:[0-9]+)?(\/[^\s]*)?$/.test(urlStr)) {
      
      // Add https:// if not present
      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        urlStr = 'https://' + urlStr;
      }
      
      try {
        const urlObj = new URL(urlStr);
        return urlObj.toString();
      } catch (e) {
        // Try with http:// if https:// fails
        if (urlStr.startsWith('https://')) {
          try {
            const httpUrl = urlStr.replace('https://', 'http://');
            const urlObj = new URL(httpUrl);
            return urlObj.toString();
          } catch (httpErr) {
            console.warn('Failed to parse URL even with http://:', urlStr, httpErr.message);
            return null;
          }
        }
        return null;
      }
    }
    
    // Try to parse as URL anyway (might be IP address or localhost)
    try {
      const urlObj = new URL('https://' + urlStr);
      return urlObj.toString();
    } catch (finalErr) {
      console.warn('Failed to parse URL after all attempts:', urlStr, finalErr.message);
      return null;
    }
    
  } catch (error) {
    console.warn('URL normalization error for:', urlStr, error.message);
    return null;
  }
}

// Security middleware - FIXED VERSION
app.use((req, res, next) => {
  try {
    // Sanitize request body
    if (req.body && typeof req.body === 'object') {
      const sanitizedBody = {};
      Object.keys(req.body).forEach(key => {
        if (typeof req.body[key] === 'string') {
          sanitizedBody[key] = xss(req.body[key], { 
            whiteList: {}, 
            stripIgnoreTag: true, 
            stripIgnoreTagBody: ['script'] 
          });
        } else {
          sanitizedBody[key] = req.body[key];
        }
      });
      req.body = mongoSanitize(sanitizedBody);
    }
    
    // Sanitize query params
    if (req.query && typeof req.query === 'object') {
      const sanitizedQuery = {};
      Object.keys(req.query).forEach(key => {
        if (typeof req.query[key] === 'string') {
          sanitizedQuery[key] = xss(req.query[key], { 
            whiteList: {}, 
            stripIgnoreTag: true, 
            stripIgnoreTagBody: ['script'] 
          });
        } else {
          sanitizedQuery[key] = req.query[key];
        }
      });
      req.query = mongoSanitize(sanitizedQuery);
    }
  } catch (err) {
    console.error('Security middleware error:', err);
  }
  next();
});

// Database connection - SAFER INDEX SYNC (uses model.syncIndexes instead of raw collection.createIndexes)
mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    console.log('✅ MongoDB connected successfully');

    // Sync indexes for each registered model (safer than iterating raw collections)
    try {
      const modelNames = mongoose.modelNames();
      if (modelNames.length === 0) {
        console.log('No mongoose models registered yet; skipping index sync.');
      } else {
        for (const name of modelNames) {
          try {
            const model = mongoose.model(name);
            const res = await model.syncIndexes();
            console.log(`✅ Indexes synced for model "${name}":`, Array.isArray(res) ? `${res.length} ops` : JSON.stringify(res));
          } catch (modelErr) {
            console.error(`Error syncing indexes for model "${name}":`, modelErr && modelErr.message ? modelErr.message : modelErr);
          }
        }
      }
    } catch (err) {
      console.error('Index sync overall error:', err && err.message ? err.message : err);
    }
  })
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    console.log('Trying to connect without deprecated options...');
    
    // Try without any options
    mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    })
    .then(async () => {
      console.log('✅ MongoDB connected on second attempt');

      // Attempt index sync on second attempt as well
      try {
        const modelNames = mongoose.modelNames();
        for (const name of modelNames) {
          try {
            const model = mongoose.model(name);
            const res = await model.syncIndexes();
            console.log(`✅ Indexes synced for model "${name}":`, Array.isArray(res) ? `${res.length} ops` : JSON.stringify(res));
          } catch (modelErr) {
            console.error(`Error syncing indexes for model "${name}":`, modelErr && modelErr.message ? modelErr.message : modelErr);
          }
        }
      } catch (err2) {
        console.error('Index sync overall error (second attempt):', err2 && err2.message ? err2.message : err2);
      }
    })
    .catch(err2 => console.error('❌ MongoDB second connection attempt failed:', err2.message));
  });

// Mongoose connection events
mongoose.connection.on('error', err => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  console.log('MongoDB reconnected');
});

// Cron job for URL expiration
cron.schedule('0 0 * * *', async () => {
  try {
    const expired = await Url.find({ 
      expirationDate: { $lt: new Date() }, 
      isActive: true 
    });
    for (const u of expired) {
      u.isActive = false;
      await u.save();
      console.log(`Expired URL deactivated: ${u.shortId}`);
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

// Helper to detect device type
const detectDeviceType = (userAgent) => {
  if (!userAgent) return 'desktop';
  
  const ua = UA(userAgent);
  if (ua.device.type === 'mobile') return 'mobile';
  if (ua.device.type === 'tablet') return 'tablet';
  if (ua.device.type === 'console') return 'console';
  if (ua.device.type === 'smarttv') return 'smarttv';
  return 'desktop';
};

// Helper to get country from IP (improved - uses geoip-lite when available)
const getCountryFromIP = (ip) => {
  try {
    if (!ip || typeof ip !== 'string') return 'Unknown';

    // pick first if multiple IPs (X-Forwarded-For)
    const maybe = ip.split(',')[0].trim();

    // Remove IPv6 prefix for ipv4-mapped addresses
    let plain = maybe;
    if (plain.includes('::ffff:')) {
      plain = plain.split('::ffff:').pop();
    }

    // Localhost / private
    if (plain === '::1' || plain === '127.0.0.1' || plain.startsWith('192.168.') || plain.startsWith('10.') || plain.startsWith('172.')) {
      return 'Local';
    }

    // If geoip is available
    if (geoip) {
      const lookup = geoip.lookup(plain);
      if (lookup && lookup.country) return lookup.country;
    }
  } catch (err) {
    console.warn('getCountryFromIP failed:', err && err.message ? err.message : err);
  }
  return 'Unknown';
};

// Simple encryption service for backward compatibility
const simpleEncryptionService = {
  encryptUrlPassword: (password) => {
    if (!password) return null;
    // Simple base64 encoding for backward compatibility
    // Note: This is only for existing passwords that were created with base64
    return Buffer.from(password).toString('base64');
  },
  
  decryptUrlPassword: (encryptedPassword) => {
    if (!encryptedPassword) return null;
    try {
      // Try to decrypt as base64 first (for backward compatibility)
      // If it fails, it might be AES encrypted
      return Buffer.from(encryptedPassword, 'base64').toString();
    } catch (error) {
      console.error('Base64 decryption failed, trying AES:', error);
      // Try AES decryption instead
      try {
        return encryptionService.decryptUrlPassword(encryptedPassword);
      } catch (aesError) {
        console.error('AES decryption also failed:', aesError);
        return null;
      }
    }
  }
};

// Utility: resolve splash image URL from various possible stored shapes
function resolveSplashUrl(splash) {
  if (!splash) return null;

  // If string, assume it's a direct URL
  if (typeof splash === 'string') return splash;

  // If array, take first element (string or object)
  if (Array.isArray(splash) && splash.length > 0) {
    return resolveSplashUrl(splash[0]);
  }

  // If object, try common properties
  const candidates = [
    'secure_url', // Cloudinary upload result
    'secureUrl',
    'url',
    'path',
    'src',
    'publicUrl',
    'public_url'
  ];

  for (const key of candidates) {
    if (splash[key] && typeof splash[key] === 'string') {
      return splash[key];
    }
  }

  // If object has nested result etc.
  if (splash.result && typeof splash.result === 'object') {
    return resolveSplashUrl(splash.result);
  }

  return null;
}

// Helper: weighted pick among destination objects (returns chosen destination object)
function weightedPickDestination(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const total = items.reduce((s, it) => s + (parseInt(it.weight, 10) || 1), 0);
  if (total <= 0) return items[0];
  let r = Math.random() * total;
  for (const it of items) {
    r -= (parseInt(it.weight, 10) || 1);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// Helper: parse rule value and get current visitor's value for matching
function getVisitorValueForRule(ruleType, userAgent, ip, uaParser) {
  switch(ruleType) {
    case 'country':
      return getCountryFromIP(ip).toLowerCase();
    case 'device':
      return detectDeviceType(userAgent).toLowerCase();
    case 'browser':
      return (uaParser.browser.name || '').toLowerCase();
    case 'time': {
      const hour = new Date().getHours();
      return hour.toString(); // Return as string for easier comparison
    }
    case 'os':
      return (uaParser.os.name || '').toLowerCase();
    case 'referrer':
      // This would need to be passed from the request
      return '';
    case 'language':
      // This would need to be passed from the request headers
      return '';
    default:
      return '';
  }
}

// Helper: check if visitor matches a rule
function visitorMatchesRule(ruleType, ruleValue, userAgent, ip, uaParser) {
  const visitorValue = getVisitorValueForRule(ruleType, userAgent, ip, uaParser);
  
  if (!visitorValue || !ruleValue) return false;
  
  switch(ruleType) {
    case 'time': {
      // Handle time range format like "09-17"
      const [startStr, endStr] = ruleValue.split('-').map(s => s.trim());
      const currentHour = new Date().getHours();
      const startHour = parseInt(startStr, 10);
      const endHour = parseInt(endStr, 10);
      
      if (isNaN(startHour) || isNaN(endHour)) return false;
      
      if (startHour <= endHour) {
        // Normal range (e.g., 09-17)
        return currentHour >= startHour && currentHour <= endHour;
      } else {
        // Overnight range (e.g., 22-06)
        return currentHour >= startHour || currentHour <= endHour;
      }
    }
    case 'browser':
    case 'os':
    case 'device':
      // Exact match for browser, OS, device
      return visitorValue === ruleValue.toLowerCase();
    case 'country':
      // Country code match
      return visitorValue === ruleValue.toLowerCase();
    case 'referrer':
      // Referrer domain match (simplified)
      return visitorValue.includes(ruleValue.toLowerCase());
    case 'language':
      // Language code match
      return visitorValue.startsWith(ruleValue.toLowerCase());
    default:
      return false;
  }
}

// Custom domain redirect handler
const handleCustomDomainRedirect = async (req, res) => {
  try {
    const host = req.headers.host;
    const path = req.path.substring(1); // Remove leading slash
    
    // Skip if it's our own domain
    const baseUrl = process.env.BASE_URL || 'http://localhost:5000';
    const baseHost = new URL(baseUrl).hostname;
    
    if (host === baseHost || host.includes('localhost')) {
      return false; // Let normal redirect handle it
    }
    
    // Look up custom domain
    const CustomDomain = require('./models/CustomDomain');
    const customDomain = await CustomDomain.findOne({ 
      domain: host,
      status: 'active'
    });
    
    if (!customDomain) {
      return false;
    }
    
    // If path matches branded short ID
    if (path === customDomain.brandedShortId || path === '') {
      // Find the original URL
      const Url = require('./models/Url');
      const url = await Url.findOne({ shortId: customDomain.shortId });
      
      if (!url) {
        return res.status(404).json({ success: false, message: 'URL not found' });
      }
      
      // Check if URL is active
      if (!url.isActive) {
        return res.status(403).json({ success: false, message: 'URL is inactive' });
      }
      
      // Handle expiration
      if (url.expirationDate && new Date() > new Date(url.expirationDate)) {
        url.isActive = false;
        await url.save();
        return res.status(410).json({ success: false, message: 'URL has expired' });
      }
      
      // Increment clicks
      url.clicks = (url.clicks || 0) + 1;
      url.lastClicked = new Date();
      await url.save();
      
      // Record click with custom domain info
      const Click = require('./models/Click');
      const userAgent = req.headers['user-agent'] || '';
      const ip = req.ip || req.headers['x-forwarded-for'] || 'Unknown';
      const uaParser = UA(userAgent);
      
      const clickData = {
        urlId: url._id,
        ipAddress: ip,
        userAgent: userAgent,
        referrer: req.headers.referer || req.headers.referrer || 'Direct',
        timestamp: new Date(),
        country: getCountryFromIP(ip),
        device: detectDeviceType(userAgent),
        browser: uaParser.browser.name || 'Unknown',
        customDomain: customDomain.domain,
        isBranded: true
      };
      
      const click = new Click(clickData);
      await click.save();
      
      // Redirect to destination
      return res.redirect(302, url.destinationUrl);
    }
    
    return false;
  } catch (error) {
    console.error('Custom domain redirect error:', error);
    return false;
  }
};

// Add middleware to check custom domains before normal redirects
app.use(async (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api') || req.path.startsWith('/s/')) {
    return next();
  }
  
  // Handle custom domain redirect
  const handled = await handleCustomDomainRedirect(req, res);
  if (!handled) {
    next();
  }
});

// SHORT URL REDIRECT ENDPOINT - FIXED VERSION: Multiple destinations work independently of smartDynamicLinks flag
app.get('/s/:shortId', async (req, res) => {
  try {
    const { shortId } = req.params;
    
    if (!shortId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Short URL ID is required' 
      });
    }
    
    // Find the URL
    const url = await Url.findOne({ shortId });
    
    if (!url) {
      return res.status(404).json({ 
        success: false, 
        message: 'Short URL not found' 
      });
    }
    
    // Check if URL is active
    if (!url.isActive) {
      return res.status(403).json({ 
        success: false, 
        message: 'This URL is currently inactive' 
      });
    }
    
    // Check if URL is restricted
    if (url.isRestricted) {
      return res.status(403).json({ 
        success: false, 
        message: 'This URL has been restricted' 
      });
    }
    
    // Check expiration date
    if (url.expirationDate && new Date() > new Date(url.expirationDate)) {
      url.isActive = false;
      await url.save();
      return res.status(410).json({ 
        success: false, 
        message: 'This URL has expired' 
      });
    }
    
    // Handle password protection - Serve password page
    if (url.password) {
      const password = req.query.password;
      
      if (!password) {
        // Serve password entry page (same as before)
        const passwordPage = `
          <!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>Password Protected URL</title>
              <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                }
                .password-container {
                  background: white;
                  border-radius: 16px;
                  padding: 40px;
                  box-shadow: 0 20px 60px rgba(0,0,0,0.2);
                  max-width: 480px;
                  width: 100%;
                  text-align: center;
                }
                .lock-icon {
                  font-size: 48px;
                  color: #667eea;
                  margin-bottom: 20px;
                }
                h1 {
                  color: #333;
                  margin-bottom: 10px;
                  font-size: 28px;
                }
                p {
                  color: #666;
                  margin-bottom: 30px;
                  line-height: 1.6;
                }
                .password-form {
                  margin-bottom: 20px;
                }
                .password-input {
                  width: '100%';
                  padding: 16px 20px;
                  border: 2px solid #e1e5e9;
                  border-radius: 12px;
                  font-size: 16px;
                  transition: border-color 0.3s;
                  margin-bottom: 20px;
                }
                .password-input:focus {
                  outline: none;
                  border-color: #667eea;
                }
                .submit-btn {
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  border: none;
                  padding: 16px 40px;
                  border-radius: 12px;
                  font-size: 16px;
                  font-weight: 600;
                  cursor: pointer;
                  transition: transform 0.2s, box-shadow 0.2s;
                  width: '100%';
                }
                .submit-btn:hover {
                  transform: translateY(-2px);
                  box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
                }
                .submit-btn:active {
                  transform: translateY(0);
                }
                .error-message {
                  color: #e53e3e;
                  background: #fed7d7;
                  padding: 12px;
                  border-radius: 8px;
                  margin-top: 20px;
                  display: ${req.query.error ? 'block' : 'none'};
                }
                .footer {
                  margin-top: 30px;
                  color: #999;
                  font-size: 14px;
                }
              </style>
            </head>
            <body>
              <div class="password-container">
                <div class="lock-icon">🔒</div>
                <h1>Password Required</h1>
                <p>This link is password protected. Please enter the password to continue.</p>
                
                <form class="password-form" action="/s/${shortId}" method="GET">
                  <input type="password" 
                         name="password" 
                         class="password-input" 
                         placeholder="Enter password" 
                         required
                         autocomplete="current-password"
                         autofocus>
                  <button type="submit" class="submit-btn">Continue to Link</button>
                </form>
                
                <div class="error-message" id="errorMessage">
                  Incorrect password. Please try again.
                </div>
                
                <div class="footer">
                  This link is protected for security reasons.
                </div>
              </div>
              
              <script>
                // Auto-focus on password input
                document.querySelector('.password-input').focus();
                
                // Show error if present in URL
                const urlParams = new URLSearchParams(window.location.search);
                if (urlParams.get('error') === '1') {
                  document.getElementById('errorMessage').style.display = 'block';
                }
                
                // Form submission with validation
                document.querySelector('.password-form').addEventListener('submit', function(e) {
                  const password = document.querySelector('.password-input').value;
                  if (!password.trim()) {
                    e.preventDefault();
                    alert('Please enter a password');
                  }
                });
              </script>
            </body>
          </html>
        `;
        return res.send(passwordPage);
      }
      
      // FIXED PASSWORD VERIFICATION - Try multiple decryption methods
      let decryptedPassword = null;
      
      try {
        // First try AES decryption (current method)
        decryptedPassword = encryptionService.decryptUrlPassword(url.password);
      } catch (aesError) {
        console.log('AES decryption failed, trying base64:', aesError);
        // If AES fails, try base64 for backward compatibility
        try {
          decryptedPassword = simpleEncryptionService.decryptUrlPassword(url.password);
        } catch (base64Error) {
          console.error('All password decryption methods failed:', base64Error);
          decryptedPassword = null;
        }
      }
      
      // Check if we got a valid decrypted password
      if (!decryptedPassword) {
        console.error('Could not decrypt password for URL:', shortId);
        return res.redirect(`/s/${shortId}?error=1`);
      }
      
      // Compare passwords
      if (password !== decryptedPassword) {
        console.log('Password mismatch for URL:', shortId);
        return res.redirect(`/s/${shortId}?error=1`);
      }
      
      // Password is correct - continue with redirect flow
    }
    
    // ---------- Compute final destination first (so splash meta-refresh uses correct URL) ----------
    let finalDestination = url.destinationUrl;

    // FIXED: Check if destinations exist and have content, regardless of smartDynamicLinks flag
    if (url.destinations && Array.isArray(url.destinations) && url.destinations.length > 0) {
      const userAgent = req.headers['user-agent'] || '';
      const ip = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || 'Unknown';
      const uaParser = UA(userAgent);
      
      console.log(`\n=== Multiple destinations check for ${shortId} ===`);
      console.log(`Total destinations in DB: ${url.destinations.length}`);
      
      // Log all destinations for debugging
      url.destinations.forEach((dest, index) => {
        console.log(`Destination ${index + 1}:`, {
          url: dest.url,
          rule: dest.rule,
          weight: dest.weight,
          hasUrlProperty: !!dest.url,
          urlType: typeof dest.url
        });
      });
      
      // Parse destinations to extract rule type and value
      const parsedDestinations = url.destinations.map(dest => {
        if (!dest || !dest.rule || !dest.url) {
          console.log(`Skipping invalid destination:`, dest);
          return null;
        }
        
        const [ruleType, ...ruleValueParts] = dest.rule.split(':');
        const ruleValue = ruleValueParts.join(':').trim();
        
        // Create new object with ALL original properties
        const parsedDest = {
          url: dest.url, // Explicitly preserve the URL
          rule: dest.rule,
          weight: dest.weight || 1,
          _id: dest._id,
          parsedRuleType: ruleType ? ruleType.toLowerCase() : '',
          parsedRuleValue: ruleValue ? ruleValue.toLowerCase() : ''
        };
        
        console.log(`Parsed destination ${dest.url}:`, {
          originalUrl: dest.url,
          parsedRuleType: parsedDest.parsedRuleType,
          parsedRuleValue: parsedDest.parsedRuleValue
        });
        
        return parsedDest;
      }).filter(Boolean);
      
      console.log(`Valid parsed destinations: ${parsedDestinations.length}`);
      
      if (parsedDestinations.length > 0) {
        // First, find destinations that match the visitor
        const matchingDestinations = parsedDestinations.filter(dest => {
          const matches = visitorMatchesRule(
            dest.parsedRuleType, 
            dest.parsedRuleValue, 
            userAgent, 
            ip, 
            uaParser
          );
          
          console.log(`Checking rule ${dest.parsedRuleType}:${dest.parsedRuleValue} for ${dest.url} -> ${matches}`);
          return matches;
        });
        
        console.log(`\nVisitor details:`);
        console.log(`- User Agent: ${userAgent.substring(0, 100)}...`);
        console.log(`- IP: ${ip}`);
        console.log(`- Country: ${getCountryFromIP(ip)}`);
        console.log(`- Device: ${detectDeviceType(userAgent)}`);
        console.log(`- Browser: ${uaParser.browser.name || 'Unknown'}`);
        console.log(`- OS: ${uaParser.os.name || 'Unknown'}`);
        console.log(`- Current hour: ${new Date().getHours()}`);
        
        console.log(`\nMatching destinations found: ${matchingDestinations.length}`);
        matchingDestinations.forEach((dest, index) => {
          console.log(`Match ${index + 1}: ${dest.url} (rule: ${dest.parsedRuleType}:${dest.parsedRuleValue})`);
        });
        
        if (matchingDestinations.length === 1) {
          // Only one match, use it
          const matchedDest = matchingDestinations[0];
          console.log(`\nSelected: Single match`);
          console.log(`- URL: ${matchedDest.url}`);
          console.log(`- Rule: ${matchedDest.parsedRuleType}:${matchedDest.parsedRuleValue}`);
          finalDestination = matchedDest.url;
        } else if (matchingDestinations.length > 1) {
          // Multiple matches, use weighted selection
          const chosen = weightedPickDestination(matchingDestinations);
          if (chosen && chosen.url) {
            finalDestination = chosen.url;
            console.log(`\nSelected: Weighted selection from ${matchingDestinations.length} matches`);
            console.log(`- URL: ${chosen.url}`);
            console.log(`- Rule: ${chosen.parsedRuleType}:${chosen.parsedRuleValue}`);
          }
        } else {
          // FIXED: No matches found - use original destination URL
          console.log(`\nNo matching destinations found. Using original URL: ${url.destinationUrl}`);
          finalDestination = url.destinationUrl;
        }
      } else {
        console.log('No valid parsed destinations found. Using original URL.');
        finalDestination = url.destinationUrl;
      }
      
      console.log(`\nFinal destination selected: ${finalDestination}`);
    } else {
      console.log(`No multiple destinations configured for ${shortId}. Using original URL.`);
    }

    // Ensure finalDestination is an absolute http(s) URL
    console.log(`\nNormalizing URL: "${finalDestination}"`);
    let normalized = normalizeUrl(finalDestination);
    
    if (!normalized) {
      console.error('Invalid or unsupported destination URL stored for shortId', shortId, '->', finalDestination);
      console.error('Type of finalDestination:', typeof finalDestination);
      
      // Try to get the original destination URL as fallback
      const fallbackNormalized = normalizeUrl(url.destinationUrl);
      if (fallbackNormalized) {
        console.log(`Using fallback (original destination): ${fallbackNormalized}`);
        normalized = fallbackNormalized;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Destination URL is invalid or unsupported. Please check the URL format.'
        });
      }
    }

    // Verify the normalized URL is parseable
    try {
      new URL(normalized);
      console.log(`URL successfully parsed: ${normalized}`);
    } catch (err) {
      console.error('Normalized destination URL is not a valid URL:', normalized, err);
      return res.status(400).json({
        success: false,
        message: 'Normalized destination URL is invalid'
      });
    }

    // ---------- Affiliate tracking: set cookie and append params ----------
    try {
      if (url.enableAffiliateTracking) {
        // Set cookie with affiliate info if available
        const affId = url.affiliateId || null;
        const affTag = url.affiliateTag || null;
        const cookieDays = parseInt(url.cookieDuration, 10) || 30;
        const cookieOptions = {
          maxAge: cookieDays * 24 * 60 * 60 * 1000,
          httpOnly: false,
          sameSite: 'Lax',
          secure: process.env.NODE_ENV === 'production'
        };

        if (affId || affTag) {
          try {
            res.cookie('affiliate', JSON.stringify({ affiliateId: affId, affiliateTag: affTag }), cookieOptions);
          } catch (cookieErr) {
            // ignore cookie errors
          }
        }

        // Append custom params or default UTM
        try {
          const redirectUrlObj = new URL(normalized);

          if (url.customParams && typeof url.customParams === 'string' && url.customParams.trim()) {
            // Expect format key=value&key2=value2
            const pairs = url.customParams.split('&').map(s => s.trim()).filter(Boolean);
            pairs.forEach(pair => {
              const [k, v] = pair.split('=');
              if (k && v !== undefined) redirectUrlObj.searchParams.set(k, v);
            });
          } else {
            if (affId) redirectUrlObj.searchParams.set('utm_source', affId);
            if (affTag) redirectUrlObj.searchParams.set('utm_medium', affTag);
          }

          // Update normalized URL with appended params
          normalized = redirectUrlObj.toString();
        } catch (err) {
          console.warn('Affiliate param append failed (non-fatal):', err && err.message ? err.message : err);
        }
      }
    } catch (err) {
      console.warn('Affiliate handling encountered an issue (non-fatal):', err && err.message ? err.message : err);
    }

    // ---------- Handle splash screen (if present) ----------
    if (url.splashImage) {
      // Resolve splash image url if stored as object/array etc.
      const splashUrl = resolveSplashUrl(url.splashImage);

      // If splashUrl exists and looks like a valid absolute URL, show splash page
      if (splashUrl && typeof splashUrl === 'string') {
        // Increment click count BEFORE sending splash (so analytics show the impression)
        url.clicks = (url.clicks || 0) + 1;
        url.lastClicked = new Date();
        await url.save();

        // Record click data (best-effort, don't fail the splash)
        try {
          const userAgent = req.headers['user-agent'] || '';
          const uaParser = UA(userAgent);
          const ip = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || 'Unknown';
          
          const clickData = {
            urlId: url._id,
            ipAddress: ip,
            userAgent: userAgent,
            referrer: req.headers.referer || req.headers.referrer || 'Direct',
            timestamp: new Date(),
            country: getCountryFromIP(ip),
            device: detectDeviceType(userAgent),
            browser: uaParser.browser.name || 'Unknown',
            browserVersion: uaParser.browser.version || 'Unknown',
            os: uaParser.os.name || 'Unknown',
            osVersion: uaParser.os.version || 'Unknown',
            deviceModel: uaParser.device.model || 'Unknown',
            deviceVendor: uaParser.device.vendor || 'Unknown'
          };
          
          const click = new Click(clickData);
          await click.save();
        } catch (clickError) {
          console.error('Failed to record click (non-fatal):', clickError && clickError.message ? clickError.message : clickError);
          // Continue even if click record fails
        }

        // Use encodeURI to safely inject URL into meta and link (avoid simple XSS if stored weirdly)
        const safeSplash = encodeURI(splashUrl);
        const safeRedirect = encodeURI(normalized);

        const splashPage = `
          <!DOCTYPE html>
          <html lang="en">
            <head>
              <meta charset="UTF-8" />
              <meta name="viewport" content="width=device-width, initial-scale=1.0" />
              <title>Redirecting...</title>
              <meta http-equiv="refresh" content="2;url=${safeRedirect}">
              <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
                  background: #f8fafc;
                  min-height: 100vh;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  padding: 20px;
                }
                .splash-container {
                  background: white;
                  border-radius: 20px;
                  padding: 40px;
                  box-shadow: 0 20px 60px rgba(0,0,0,0.1);
                  max-width: 600px;
                  width: 100%;
                  text-align: center;
                }
                .splash-image {
                  max-width: 100%;
                  height: auto;
                  border-radius: 12px;
                  margin-bottom: 30px;
                  box-shadow: 0 10px 30px rgba(0,0,0,0.1);
                }
                h2 {
                  color: #333;
                  margin-bottom: 15px;
                  font-size: 24px;
                }
                p {
                  color: #666;
                  margin-bottom: 30px;
                  line-height: 1.6;
                }
                .loader {
                  width: 60px;
                  height: 60px;
                  border: 4px solid #f3f3f3;
                  border-top: 4px solid #667eea;
                  border-radius: 50%;
                  margin: 20px auto;
                  animation: spin 1s linear infinite;
                }
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
                .redirect-text {
                  color: #999;
                  font-size: 14px;
                  margin-top: 20px;
                }
                .manual-link {
                  margin-top: 12px;
                  display: inline-block;
                  font-size: 13px;
                  color: #667eea;
                  text-decoration: none;
                }
              </style>
            </head>
            <body>
              <div class="splash-container">
                <img src="${safeSplash}" alt="Splash" class="splash-image" onerror="this.style.display='none'">
                <h2>Redirecting you...</h2>
                <p>Please wait while we take you to the destination.</p>
                <div class="loader"></div>
                <p class="redirect-text">You will be redirected automatically in 2 seconds</p>
                <a class="manual-link" href="${safeRedirect}">Click here if you are not redirected</a>
              </div>
            </body>
          </html>
        `;

        return res.send(splashPage);
      }
      // If splash exists but can't resolve to a string URL, fall through to normal redirect behavior
    }
    
    // If no splash OR splash couldn't be resolved, continue to increment clicks, record, then redirect
    // Increment click count
    url.clicks = (url.clicks || 0) + 1;
    url.lastClicked = new Date();
    await url.save();
    
    // Record detailed click data
    try {
      const userAgent = req.headers['user-agent'] || '';
      const uaParser = UA(userAgent);
      const ip = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || 'Unknown';
      
      const clickData = {
        urlId: url._id,
        ipAddress: ip,
        userAgent: userAgent,
        referrer: req.headers.referer || req.headers.referrer || 'Direct',
        timestamp: new Date(),
        country: getCountryFromIP(ip),
        device: detectDeviceType(userAgent),
        browser: uaParser.browser.name || 'Unknown',
        browserVersion: uaParser.browser.version || 'Unknown',
        os: uaParser.os.name || 'Unknown',
        osVersion: uaParser.os.version || 'Unknown',
        deviceModel: uaParser.device.model || 'Unknown',
        deviceVendor: uaParser.device.vendor || 'Unknown'
      };
      
      const click = new Click(clickData);
      await click.save();
    } catch (clickError) {
      console.error('Failed to record click (non-fatal):', clickError && clickError.message ? clickError.message : clickError);
      // Don't fail the redirect if click recording fails
    }
    
    // Redirect to final destination (normalized)
    console.log(`\n=== Final redirect ===`);
    console.log(`Redirecting shortId=${shortId} -> ${normalized}\n`);
    return res.redirect(302, normalized);
    
  } catch (error) {
    console.error('Short URL redirect error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { error: error.message })
    });
  }
});

// Health check endpoint
app.get(['/api/health', '/health'], (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime()
  });
});

// API root endpoint
app.get(['/api', '/api/'], (req, res) => {
  res.json({
    success: true,
    message: 'URL Shortener API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /api/health',
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        logout: 'POST /api/auth/logout'
      },
      urls: {
        shorten: 'POST /api/urls/shorten',
        user_urls: 'GET /api/urls/user-urls',
        analytics: 'GET /api/urls/:id/analytics'
      },
      analytics: {
        overall: 'GET /api/analytics/overall',
        url_specific: 'GET /api/analytics/url/:id'
      }
    }
  });
});

// Authentication middleware for API routes
app.use('/api', (req, res, next) => {
  // Skip authentication for public routes
  const publicRoutes = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/health',
    '/health',
    '/',
    '/api'
  ];
  
  const isPublicRoute = publicRoutes.some(route => req.path.startsWith(route));
  
  if (isPublicRoute) {
    return next();
  }
  
  // Accept token either in Authorization header OR HttpOnly cookie (token or authToken)
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.token || req.cookies?.authToken;
  
  let token;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '').trim();
  } else if (cookieToken) {
    token = cookieToken;
  }
  
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Access denied. No token provided.'
    });
  }
  
  // Attach token to req for downstream middlewares/controllers if they want it
  req.token = token;
  next();
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/urls', urlRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/help', helpRoutes);
app.use('/api/custom-domains', customDomainRoutes);

// Serve frontend build if present
const buildPath = process.env.FRONTEND_BUILD_PATH || path.join(__dirname, 'client', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>URL Shortener API</title>
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 40px 20px;
              line-height: 1.6;
            }
            h1 { color: #333; }
            .api-link {
              background: #f5f5f5;
              padding: 15px;
              border-radius: 8px;
              margin: 10px 0;
              display: block;
              text-decoration: none;
              color: #0066cc;
              border-left: 4px solid #0066cc;
            }
            .api-link:hover {
              background: #e8e8e8;
            }
          </style>
        </head>
        <body>
          <h1>🚀 URL Shortener API</h1>
          <p>API server is running. Use the following endpoints:</p>
          <a href="/api" class="api-link">GET /api - API Documentation</a>
          <a href="/api/health" class="api-link">GET /api/health - Health Check</a>
          <p>Frontend is not built. Run <code>npm run build</code> in the client directory.</p>
        </body>
      </html>
    `);
  });
}

// 404 handler for API routes
app.use((req, res, next) => {
  if (req.path && req.path.startsWith('/api')) {
    return res.status(404).json({
      success: false,
      message: 'API endpoint not found',
      requested: req.originalUrl
    });
  }
  next();
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.message ? err.message : err, err && err.stack ? err.stack : '');

  const isApiRequest = req.path && req.path.startsWith('/api');

  if (isApiRequest) {
    return res.status(err && err.status ? err.status : 500).json({
      success: false,
      message: err && err.message ? err.message : 'Internal server error',
      ...(process.env.NODE_ENV === 'development' && { stack: err && err.stack ? err.stack : '' })
    });
  }

  // For non-API requests, send HTML error page
  res.status(err && err.status ? err.status : 500).send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Error ${err && err.status ? err.status : 500}</title>
        <style>
          body {
            font-family: sans-serif;
            text-align: center;
            padding: 50px;
          }
          h1 { color: #e74c3c; }
        </style>
      </head>
      <body>
        <h1>Error ${err && err.status ? err.status : 500}</h1>
        <p>${err && err.message ? err.message : 'Something went wrong'}</p>
        <a href="/">Go to homepage</a>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 5000;

// Graceful shutdown
const shutdown = () => {
  console.log('Shutting down gracefully...');
  mongoose.connection.close(false, () => {
    console.log('MongoDB connection closed.');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
  console.log(`🗄️  Database: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'}`);
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use.`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
  }
});

module.exports = app;