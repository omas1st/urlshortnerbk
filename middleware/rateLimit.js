const rateLimit = require('express-rate-limit');

// Rate limit for API endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter rate limit for authentication endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'Too many authentication attempts, please try again after 15 minutes'
  }
});

// Rate limit for link creation
const createLinkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50,
  message: {
    error: 'Too many links created, please try again later'
  }
});

// Rate limit for file uploads
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: {
    error: 'Too many uploads, please try again later'
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  createLinkLimiter,
  uploadLimiter
};