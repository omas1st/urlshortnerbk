// middleware/adminAuth.js
const jwt = require('jsonwebtoken');

const adminAuth = async (req, res, next) => {
  try {
    // Accept token from cookie (HttpOnly) OR Authorization header
    // Cookie names commonly used: 'token', 'authToken'
    let token;
    if (req.cookies && (req.cookies.token || req.cookies.authToken)) {
      token = req.cookies.token || req.cookies.authToken;
    }

    // Fallback to Authorization header
    if (!token) {
      const header = req.header('Authorization') || req.header('authorization');
      if (header && header.startsWith('Bearer ')) {
        token = header.replace('Bearer ', '').trim();
      }
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Admin authentication required (token missing)' });
    }

    // Try verifying against a common env key. Accept either process.env.secret_key or process.env.JWT_SECRET
    const secret = process.env.secret_key || process.env.JWT_SECRET;
    if (!secret) {
      console.error('JWT secret is not configured in environment variables');
      return res.status(500).json({ success: false, message: 'Server misconfiguration' });
    }

    const decoded = jwt.verify(token, secret);

    // Require admin role
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    // DON'T require decoded.email to equal ADMIN_USERNAME here.
    // Accept any token that has role: 'admin'. If you still want to allow only a single super-admin,
    // add an additional check but keep it optional.

    // Attach admin info to request for downstream controllers
    req.admin = decoded;

    next();
  } catch (error) {
    console.error('adminAuth error:', error.message || error);
    return res.status(401).json({ success: false, message: 'Admin authentication required' });
  }
};

// Direct admin login (for admin panel)
const directAdminAuth = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    // Check against environment variables - ensure your .env has ADMIN_USERNAME and ADMIN_PASSWORD
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      const secret = process.env.secret_key || process.env.JWT_SECRET;
      if (!secret) {
        console.error('JWT secret is not configured in environment variables');
        return res.status(500).json({ success: false, message: 'Server misconfiguration' });
      }

      const token = jwt.sign(
        { userId: 'admin', email: username, role: 'admin' },
        secret,
        { expiresIn: '24h' }
      );

      req.adminToken = token;
      next();
    } else {
      return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
    }
  } catch (error) {
    console.error('directAdminAuth error:', error);
    res.status(500).json({ success: false, message: 'Server error during admin authentication' });
  }
};

const hasAdminPermission = (...permissions) => {
  return (req, res, next) => {
    if (!req.admin) {
      return res.status(401).json({ success: false, message: 'Admin authentication required' });
    }
    // Implement permission checks here if you have permissions stored on the token
    // For now just pass through
    next();
  };
};

const logAdminAction = (action) => {
  return async (req, res, next) => {
    try {
      const AdminLog = require('../models/AdminLog');
      const log = new AdminLog({
        adminId: req.admin?.userId || 'system',
        action: action,
        resource: req.originalUrl,
        method: req.method,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        metadata: {
          params: req.params,
          query: req.query,
          body: req.method === 'GET' ? null : req.body
        }
      });
      await log.save();
      next();
    } catch (error) {
      console.error('Failed to log admin action:', error);
      // don't block the request if logging fails
      next();
    }
  };
};

// ADMIN RATE LIMIT - currently disabled (pass-through middleware)
const adminRateLimit = (limit, windowMs) => {
  return (req, res, next) => next();
};

// validateAdminInput unchanged
const validateAdminInput = (validationRules) => {
  return async (req, res, next) => {
    try {
      const errors = [];
      for (const rule of validationRules) {
        const { field, required, type, min, max, pattern } = rule;
        const value = req.body[field];

        if (required && (value === undefined || value === null || value === '')) {
          errors.push(`${field} is required`);
          continue;
        }

        if (value !== undefined && value !== null && value !== '') {
          if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            errors.push(`${field} must be a valid email`);
          }
          if (type === 'number') {
            const numValue = Number(value);
            if (isNaN(numValue)) {
              errors.push(`${field} must be a number`);
            } else {
              if (min !== undefined && numValue < min) errors.push(`${field} must be at least ${min}`);
              if (max !== undefined && numValue > max) errors.push(`${field} cannot exceed ${max}`);
            }
          }
          if (type === 'array' && !Array.isArray(value)) errors.push(`${field} must be an array`);
          if (pattern && !pattern.test(value)) errors.push(`${field} format is invalid`);
        }
      }

      if (errors.length > 0) {
        return res.status(400).json({ success: false, message: 'Admin validation failed', errors });
      }

      next();
    } catch (error) {
      console.error('validateAdminInput error:', error);
      res.status(500).json({ success: false, message: 'Admin validation error' });
    }
  };
};

module.exports = {
  adminAuth,
  directAdminAuth,
  hasAdminPermission,
  logAdminAction,
  adminRateLimit,
  validateAdminInput
};
