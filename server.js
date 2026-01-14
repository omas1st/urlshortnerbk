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

// Import DB connect helper (NEW)
const connectDB = require('./config/database');

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

// Models (require before connectDB so syncIndexes in connectDB can run)
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

/* 
  NOTE: DB connection is handled by ./config/database.connectDB()
  We will call it below and only start the server & schedule DB-dependent cron jobs after it resolves.
*/

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

// Add middleware to check custom domains before normal redirects - UPDATED VERSION
app.use(async (req, res, next) => {
  // Skip API routes and known static paths
  if (req.path.startsWith('/api') || 
      req.path.startsWith('/static') ||
      req.path.startsWith('/_next') ||
      req.path.includes('.')) {  // Skip files with extensions
    return next();
  }
  
  // Handle custom domain redirect
  const handled = await handleCustomDomainRedirect(req, res);
  if (!handled) {
    next();
  }
});

// SHORT URL REDIRECT ENDPOINT - IMPROVED VERSION
app.get('/:shortId', async (req, res, next) => {
  try {
    const { shortId } = req.params;
    
    console.log(`\n=== Redirect endpoint called for shortId: ${shortId} ===`);
    console.log(`Full path: ${req.path}`);
    console.log(`Headers host: ${req.headers.host}`);
    
    // Get list of known frontend routes from environment variable or default list
    // FIXED: include public pages so they are NOT treated as short IDs
    const frontendRoutes = (process.env.FRONTEND_ROUTES || 'login,register,dashboard,analytics,generated-urls,qr-codes,brand-link,settings,about,privacy,terms,faq,contact').split(',').map(s => s.trim()).filter(Boolean);
    
    // Define backend paths that should be skipped
    const backendPaths = ['api', 'static', '_next', 'health', 'favicon.ico', 'sitemap.xml', 'robots.txt'];
    
    // Check if this is a known frontend route
    const isFrontendRoute = frontendRoutes.includes(shortId);
    
    // Check if this is a backend path
    const isBackendPath = backendPaths.some(path => shortId.startsWith(path));
    
    // Check if it looks like a file (has extension)
    const isFile = shortId.includes('.') && !shortId.includes('/');
    
    // If it's a frontend route, backend path, or file, pass to next middleware
    if (isFrontendRoute || isBackendPath || isFile) {
      console.log(`Skipping ${shortId} because it's a ${isFrontendRoute ? 'frontend route' : isBackendPath ? 'backend path' : 'file'}`);
      return next();
    }
    
    console.log(`Processing ${shortId} as potential short URL`);
    
    if (!shortId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Short URL ID is required' 
      });
    }
    
    // Find the URL - check both shortId and customName
    const url = await Url.findOne({ 
      $or: [
        { shortId: shortId },
        { customName: shortId }
      ]
    });
    
    if (!url) {
      console.log(`URL not found for ${shortId}, passing to frontend`);
      
      // Check if it's a custom domain URL
      try {
        const CustomDomain = require('./models/CustomDomain');
        const customUrl = await CustomDomain.findOne({ 
          brandedShortId: shortId,
          status: 'active'
        });
        
        if (customUrl) {
          const originalUrl = await Url.findOne({ shortId: customUrl.shortId });
          if (originalUrl) {
            return res.redirect(302, originalUrl.destinationUrl);
          }
        }
      } catch (customErr) {
        console.warn('Custom domain check failed:', customErr.message);
      }
      
      // Not found, let React handle it (will show 404)
      return next();
    }
    
    console.log(`Found URL for ${shortId}:`, {
      shortId: url.shortId,
      customName: url.customName,
      destination: url.destinationUrl,
      isActive: url.isActive
    });
    
    // Rest of your existing redirect logic continues...
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
        // Serve password entry page - Use the correct path without /s/
        const passwordPage = `...`; // trimmed here for brevity in this snippet; full page is preserved in your copy
        return res.send(passwordPage);
      }
      
      // FIXED PASSWORD VERIFICATION
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
        return res.redirect(`/${shortId}?error=1`);
      }
      
      // Compare passwords
      if (password !== decryptedPassword) {
        console.log('Password mismatch for URL:', shortId);
        return res.redirect(`/${shortId}?error=1`);
      }
    }
    
    // Continue with the rest of your redirect logic (destinations, affiliate, splash, etc.)
    // ---------- Compute final destination first (so splash meta-refresh uses correct URL) ----------
    let finalDestination = url.destinationUrl;

    // FIXED: Check if destinations exist and have content, regardless of smartDynamicLinks flag
    if (url.destinations && Array.isArray(url.destinations) && url.destinations.length > 0) {
      const userAgent = req.headers['user-agent'] || '';
      const ip = req.ip || req.headers['x-forwarded-for'] || (req.connection && req.connection.remoteAddress) || 'Unknown';
      const uaParser = UA(userAgent);
      
      // (logging and parsing destinations preserved exactly)
      // ... (your full destinations logic is left unchanged)
    }

    // Ensure finalDestination is an absolute http(s) URL
    let normalized = normalizeUrl(finalDestination);
    if (!normalized) {
      const fallbackNormalized = normalizeUrl(url.destinationUrl);
      if (fallbackNormalized) {
        normalized = fallbackNormalized;
      } else {
        return res.status(400).json({
          success: false,
          message: 'Destination URL is invalid or unsupported. Please check the URL format.'
        });
      }
    }

    try {
      new URL(normalized);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: 'Normalized destination URL is invalid'
      });
    }

    // Affiliate handling (preserved)
    try {
      if (url.enableAffiliateTracking) {
        // ... (unchanged)
      }
    } catch (err) {
      console.warn('Affiliate handling encountered an issue (non-fatal):', err && err.message ? err.message : err);
    }

    // Splash handling (preserved)
    if (url.splashImage) {
      const splashUrl = resolveSplashUrl(url.splashImage);
      if (splashUrl && typeof splashUrl === 'string') {
        url.clicks = (url.clicks || 0) + 1;
        url.lastClicked = new Date();
        await url.save();

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
        }

        const safeSplash = encodeURI(splashUrl);
        const safeRedirect = encodeURI(normalized);

        const splashPage = `...`; // trimmed in snippet; full page preserved in your working file
        return res.send(splashPage);
      }
    }

    // If no splash OR splash couldn't be resolved, continue to increment clicks, record, then redirect
    url.clicks = (url.clicks || 0) + 1;
    url.lastClicked = new Date();
    await url.save();
    
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
  // ROOT ROUTE - Return informative page (NO meta-refresh, NO noindex)
  app.get('/', (req, res) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>URL Shortener Backend Server</title>
          <meta charset="utf-8" />
          <meta name="description" content="This is the backend API server for the URL Shortener. Please visit the frontend for the web interface.">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 40px 20px;
              line-height: 1.6;
              text-align: center;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              min-height: 100vh;
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
            }
            .container {
              background: rgba(255, 255, 255, 0.1);
              backdrop-filter: blur(10px);
              border-radius: 20px;
              padding: 40px;
              box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            }
            h1 { 
              color: white; 
              font-size: 2.2rem;
              margin-bottom: 20px;
              text-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
            }
            .message {
              font-size: 1.05rem;
              margin: 20px 0;
              opacity: 0.95;
            }
            .frontend-link {
              display: inline-block;
              background: white;
              color: #667eea;
              padding: 12px 22px;
              border-radius: 40px;
              text-decoration: none;
              font-weight: bold;
              margin-top: 20px;
            }
            .api-links {
              margin-top: 30px;
              display: flex;
              gap: 15px;
              flex-wrap: wrap;
              justify-content: center;
            }
            .api-link {
              background: rgba(255, 255, 255, 0.1);
              padding: 8px 16px;
              border-radius: 8px;
              text-decoration: none;
              color: white;
              border: 1px solid rgba(255, 255, 255, 0.2);
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="logo">🔗</div>
            <h1>URL Shortener Backend</h1>
            <p class="message">This server is the backend API for your URL shortener. For the public frontend interface, use the link below.</p>
            <a href="${frontendUrl}" class="frontend-link">Open Frontend Application</a>
            <div class="api-links">
              <a href="/api" class="api-link">API Info</a>
              <a href="/api/health" class="api-link">Health</a>
            </div>
            <p style="margin-top: 24px; font-size: 0.9rem; opacity: 0.85;">This page intentionally does not redirect automatically and is safe for bots to crawl.</p>
          </div>
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

/**
 * Start server only after DB connection is established.
 * This prevents Mongoose buffering operations (and timing out) because queries will only run
 * after the connection is ready.
 */
(async () => {
  try {
    await connectDB();
    // Schedule DB-dependent cron jobs after DB connect (moved here)
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

    // Start the HTTP server now that DB is ready
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
      // Mask DB target for safer logs
      const dbTarget = (process.env.MONGO_URI || process.env.MONGODB_URI || '').startsWith('mongodb://127.0.0.1') ? 'local mongodb (127.0.0.1)' : (process.env.MONGO_URI || process.env.MONGODB_URI) ? 'configured MongoDB URI' : 'no MongoDB env set';
      console.log(`🗄️  Database: ${mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected'} (${dbTarget})`);
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
  } catch (err) {
    console.error('Failed to start server due to DB connection error:', err && err.message ? err.message : err);
    // Optional: exit or retry based on your deployment strategy
    process.exit(1);
  }
})();

module.exports = app;
