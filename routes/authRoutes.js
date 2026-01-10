// routes/authRoutes.js
const express = require('express');
const router = express.Router();

const authController = require('../controllers/authController');
const authMiddleware = require('../middleware/auth');

// Safety wrapper to ensure we only pass functions to router methods
const safe = (maybeFn, name) => {
  if (typeof maybeFn === 'function') return maybeFn;
  console.error(`[authRoutes] Handler "${name}" is not a function. Check controllers/authController.js exports.`);
  return (req, res) => {
    res.status(500).json({
      success: false,
      message: `Server misconfiguration: handler "${name}" not available`
    });
  };
};

const auth = authMiddleware && typeof authMiddleware.auth === 'function' ? authMiddleware.auth : (req, res, next) => {
  // fallback: no-op auth that denies access (safer than silently allowing)
  return res.status(500).json({ success: false, message: 'Auth middleware not configured' });
};
const optionalAuth = authMiddleware && typeof authMiddleware.optionalAuth === 'function' ? authMiddleware.optionalAuth : (req, res, next) => next();

// Public routes
router.post('/register', safe(authController.register, 'register'));
router.post('/login', safe(authController.login, 'login'));
router.post('/admin-login', safe(authController.adminLogin, 'adminLogin'));
router.post('/forgot-password', safe(authController.forgotPassword, 'forgotPassword'));
router.post('/reset-password', safe(authController.resetPassword, 'resetPassword'));
router.post('/verify-email', safe(authController.verifyEmail, 'verifyEmail'));

// NEW ROUTES FOR FORGOT PASSWORD FLOW
router.post('/verify-identity', safe(authController.verifyIdentity, 'verifyIdentity'));
router.post('/reset-password-via-identity', safe(authController.resetPasswordViaIdentity, 'resetPasswordViaIdentity'));

// Protected routes (require authentication)
router.get('/me', auth, safe(authController.getCurrentUser, 'getCurrentUser'));
router.put('/profile', auth, safe(authController.updateProfile, 'updateProfile'));
router.put('/change-password', auth, safe(authController.changePassword, 'changePassword'));
router.post('/resend-verification', auth, safe(authController.resendVerification, 'resendVerification'));
router.post('/logout', auth, safe(authController.logout, 'logout'));

// Optional auth check
router.get('/check', optionalAuth, (req, res) => {
  res.json({
    success: true,
    isAuthenticated: !!req.user,
    user: req.user ? {
      id: req.user._id,
      email: req.user.email,
      username: req.user.username,
      role: req.user.role
    } : null
  });
});

module.exports = router;