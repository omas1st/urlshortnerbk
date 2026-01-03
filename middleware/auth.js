// middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const getSecret = () => {
  return process.env.secret_key || process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_dev_secret';
};

// Auth middleware - requires valid token
const auth = async (req, res, next) => {
  try {
    const raw = req.header('Authorization') || req.headers.authorization || '';
    const token = String(raw).replace('Bearer ', '').trim();
    if (!token) {
      return res.status(401).json({ success: false, message: 'Please authenticate' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, getSecret());
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }

    const user = await User.findById(decoded.userId || decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    if (user.isActive === false) {
      return res.status(401).json({ success: false, message: 'Account is deactivated' });
    }

    if (typeof user.isLocked === 'function' && user.isLocked()) {
      return res.status(401).json({ success: false, message: 'Account temporarily locked' });
    }

    req.user = user;
    req.token = token;

    try {
      if (typeof user.updateLastActive === 'function') {
        await user.updateLastActive();
      }
    } catch (e) {
      // ignore
    }

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(401).json({ success: false, message: 'Please authenticate' });
  }
};

// Optional auth - attach user if token present, otherwise continue
const optionalAuth = async (req, res, next) => {
  try {
    const raw = req.header('Authorization') || req.headers.authorization || '';
    const token = String(raw).replace('Bearer ', '').trim();
    if (!token) return next();

    let decoded;
    try {
      decoded = jwt.verify(token, getSecret());
    } catch (err) {
      return next();
    }

    const user = await User.findById(decoded.userId || decoded.id);
    if (!user) return next();

    if (user.isActive === false) return next();
    if (typeof user.isLocked === 'function' && user.isLocked()) return next();

    req.user = user;
    req.token = token;
    try {
      if (typeof user.updateLastActive === 'function') {
        await user.updateLastActive();
      }
    } catch (e) { /* ignore */ }

    return next();
  } catch (err) {
    console.error('optionalAuth error:', err);
    return next();
  }
};

// Authorization: require roles
const hasRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ success: false, message: 'Insufficient permissions' });
    return next();
  };
};

// isOwner helper - checks resource user id vs req.user
const isOwner = (resourceUserIdField = 'user') => {
  return (req, res, next) => {
    try {
      const resourceUserId = req[resourceUserIdField] || (req.params && req.params[resourceUserIdField]) || (req.body && req.body[resourceUserIdField]);
      if (!resourceUserId) {
        return res.status(400).json({ success: false, message: 'Resource user ID not found' });
      }
      if (String(resourceUserId) !== String(req.user._id) && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'You do not have permission to access this resource' });
      }
      return next();
    } catch (err) {
      console.error('isOwner error:', err);
      return res.status(500).json({ success: false, message: 'Server error' });
    }
  };
};

// Rate limiter factory - returns middleware. If express-rate-limit is not installed or RATE_LIMIT_MAX unset, returns no-op.
const userRateLimit = (limit, windowMs) => {
  try {
    const rateLimit = require('express-rate-limit');
    const max = (limit || parseInt(process.env.RATE_LIMIT_MAX, 10) || 0);
    const win = (windowMs || (parseInt(process.env.RATE_LIMIT_WINDOW, 10) || 0)) * 60 * 1000;
    if (!max || !win) {
      return (req, res, next) => next();
    }
    return rateLimit({
      windowMs: win,
      max: max,
      keyGenerator: (req) => (req.user ? String(req.user._id) : req.ip),
      handler: (req, res) => {
        res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
      }
    });
  } catch (e) {
    // express-rate-limit not installed or other error - return no-op
    return (req, res, next) => next();
  }
};

// Basic validation factory
const validateUserInput = (rules) => {
  return async (req, res, next) => {
    try {
      const errors = [];
      for (const rule of (rules || [])) {
        const { field, required, type, minLength, maxLength, pattern, custom } = rule;
        const value = req.body ? req.body[field] : undefined;
        if (required && (value === undefined || value === null || value === '')) {
          errors.push(`${field} is required`);
          continue;
        }
        if (value !== undefined && value !== null && value !== '') {
          if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.push(`${field} must be a valid email`);
          }
          if (type === 'number' && isNaN(Number(value))) {
            errors.push(`${field} must be a number`);
          }
          if (minLength && String(value).length < minLength) {
            errors.push(`${field} must be at least ${minLength} characters`);
          }
          if (maxLength && String(value).length > maxLength) {
            errors.push(`${field} cannot exceed ${maxLength} characters`);
          }
          if (pattern && !pattern.test(value)) {
            errors.push(`${field} format is invalid`);
          }
          if (typeof custom === 'function') {
            const customErr = await custom(value, req);
            if (customErr) errors.push(customErr);
          }
        }
      }
      if (errors.length) {
        return res.status(400).json({ success: false, message: 'Validation failed', errors });
      }
      return next();
    } catch (err) {
      console.error('validateUserInput error:', err);
      return res.status(500).json({ success: false, message: 'Validation error' });
    }
  };
};

// Sanitize input - shallow sanitize strings
const sanitizeInput = (req, res, next) => {
  try {
    const sanitizeString = (s) => {
      if (typeof s !== 'string') return s;
      return s.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
              .replace(/javascript:/gi, '')
              .replace(/on\w+="[^"]*"/gi, '')
              .replace(/on\w+='[^']*'/gi, '')
              .trim();
    };
    const sanitizeObject = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const out = Array.isArray(obj) ? [] : {};
      for (const k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = obj[k];
        if (typeof v === 'string') out[k] = sanitizeString(v);
        else if (v && typeof v === 'object') out[k] = sanitizeObject(v);
        else out[k] = v;
      }
      return out;
    };
    if (req.body) req.body = sanitizeObject(req.body);
    if (req.query) req.query = sanitizeObject(req.query);
    if (req.params) req.params = sanitizeObject(req.params);
    return next();
  } catch (err) {
    console.error('sanitizeInput error:', err);
    return next();
  }
};

module.exports = {
  auth,
  optionalAuth,
  hasRole,
  isOwner,
  userRateLimit,
  validateUserInput,
  sanitizeInput
};
