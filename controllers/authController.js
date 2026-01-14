// controllers/authController.js
const mongoose = require('mongoose');
const connectDB = require('../config/database');

const User = require('../models/User');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const crypto = require('crypto');

let sendEmail;
try {
  // optional email sender util — if missing, we log and continue
  sendEmail = require('../utils/emailService').sendEmail;
} catch (e) {
  sendEmail = null;
  console.warn('[authController] sendEmail util not found; continuing without email sending.');
}

const getSecret = () => {
  return process.env.secret_key || process.env.JWT_SECRET || process.env.SECRET_KEY || 'default_dev_secret';
};

const signToken = (payload, expiresIn = '7d') => {
  return jwt.sign(payload, getSecret(), { expiresIn });
};

const serverError = (res, err, ctx) => {
  console.error(ctx || 'Server error:', err && err.stack ? err.stack : err);
  const message = (err && err.message) ? err.message : 'Server error';
  return res.status(500).json({ success: false, message });
};

/**
 * Ensure DB is connected before running queries
 * Uses the cached connectDB() from config/database.js
 * Includes a light retry (3 attempts) with exponential backoff for transient blips
 */
const ensureDbConnected = async () => {
  // If already connected, return immediately
  if (mongoose.connection && mongoose.connection.readyState === 1) {
    return;
  }

  const maxAttempts = 3; // total attempts
  const baseDelayMs = 500; // initial wait before retry (multiplied by attempt)

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Await the shared connectDB() (it uses caching so it won't create duplicate connections)
      await connectDB();
      // connected successfully
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[authController] DB connect attempt ${attempt} failed:`, err && err.message ? err.message : err);
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * attempt; // 500ms, 1000ms, ...
        console.log(`[authController] Retrying DB connect in ${delay}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await sleep(delay);
      }
    }
  }

  // After retries, throw so caller can return an appropriate error
  throw lastErr || new Error('Unable to connect to database after retries');
};

/**
 * register
 * Body: { email, username, password, confirmPassword }
 */
exports.register = async (req, res) => {
  try {
    await ensureDbConnected();

    const { email, username, password, confirmPassword } = req.body || {};
    console.info(`[INFO] 📝 Registration attempt - Email: ${email || '<none>'}, Username: ${username || '<none>'}`);

    if (!email || !username || !password || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (!validator.isEmail(String(email))) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email' });
    }

    if (String(username).length < 3) {
      return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ success: false, message: 'Username can only contain letters, numbers, and underscores' });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }

    const hasUpper = /[A-Z]/.test(password);
    const hasLower = /[a-z]/.test(password);
    const hasNumber = /\d/.test(password);
    if (!hasUpper || !hasLower || !hasNumber) {
      return res.status(400).json({ success: false, message: 'Password must include uppercase, lowercase, and numbers' });
    }

    // check duplicates
    const existing = await User.findOne({
      $or: [{ email: String(email).toLowerCase() }, { username: String(username).toLowerCase() }]
    });

    if (existing) {
      if (existing.email && String(existing.email).toLowerCase() === String(email).toLowerCase()) {
        return res.status(400).json({ success: false, message: 'Email already registered' });
      }
      return res.status(400).json({ success: false, message: 'Username already taken' });
    }

    const user = new User({
      email: String(email).toLowerCase(),
      username: String(username).toLowerCase(),
      password: password
    });

    // Automatically verify email for now (no email sending)
    user.emailVerified = true;
    user.verificationToken = crypto.randomBytes(24).toString('hex');

    await user.save();

    // generate token
    const token = signToken({ userId: user._id, email: user.email, role: user.role });

    // remove sensitive before returning
    user.password = undefined;

    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      token: token,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        role: user.role,
        emailVerified: user.emailVerified || true
      }
    });
  } catch (err) {
    return serverError(res, err, 'Registration error');
  }
};

/**
 * login
 * Body: { emailOrUsername, password }
 */
exports.login = async (req, res) => {
  try {
    await ensureDbConnected();

    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) {
      return res.status(400).json({ success: false, message: 'Email/Username and password are required' });
    }

    const identifier = String(emailOrUsername).toLowerCase();

    // First check if it's admin credentials from env
    const envUser = process.env.ADMIN_USERNAME;
    const envPass = process.env.ADMIN_PASSWORD;
    
    if (envUser && envPass && identifier === envUser.toLowerCase() && password === envPass) {
      console.log('[INFO] Admin login via env credentials');
      
      // Check if admin user exists in DB, create if not
      let adminUser = await User.findOne({ 
        $or: [{ email: envUser.toLowerCase() }, { username: envUser.toLowerCase() }]
      });
      
      if (!adminUser) {
        // Create admin user if doesn't exist
        adminUser = new User({
          email: process.env.ADMIN_EMAIL || 'admin@example.com',
          username: envUser.toLowerCase(),
          password: envPass,
          role: 'admin',
          emailVerified: true,
          isActive: true
        });
        await adminUser.save();
        console.log('[INFO] Admin user created in database');
      } else if (adminUser.role !== 'admin') {
        // Update existing user to admin
        adminUser.role = 'admin';
        await adminUser.save();
      }
      
      const token = signToken({ 
        userId: adminUser._id, 
        email: adminUser.email, 
        role: 'admin' 
      }, '24h');
      
      adminUser.password = undefined;
      
      return res.json({
        success: true,
        message: 'Admin login successful',
        token: token,
        user: {
          id: adminUser._id,
          email: adminUser.email,
          username: adminUser.username,
          role: 'admin',
          emailVerified: true
        }
      });
    }

    const user = await User.findOne({
      $or: [{ email: identifier }, { username: identifier }]
    }).select('+password');

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (typeof user.isLocked === 'function' && user.isLocked()) {
      return res.status(401).json({ success: false, message: 'Account is temporarily locked' });
    }

    const valid = await user.comparePassword(password);
    if (!valid) {
      try {
        if (typeof user.incLoginAttempts === 'function') {
          await user.incLoginAttempts();
        }
      } catch (e) { /* ignore increment errors */ }
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    try {
      if (typeof user.resetLoginAttempts === 'function') {
        await user.resetLoginAttempts();
      }
    } catch (e) { /* ignore */ }

    user.lastLogin = new Date();
    await user.save().catch(() => {});

    const token = signToken({ userId: user._id, email: user.email, role: user.role });

    user.password = undefined;

    return res.json({
      success: true,
      message: 'Login successful',
      token: token,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        role: user.role,
        emailVerified: user.emailVerified || false,
        profile: user.profile || {},
        settings: user.settings || {}
      }
    });
  } catch (err) {
    return serverError(res, err, 'Login error');
  }
};

/**
 * verifyIdentity - NEW FUNCTION
 * Body: { email, username }
 * Verifies that email and username match a user in database
 */
exports.verifyIdentity = async (req, res) => {
  try {
    await ensureDbConnected();

    const { email, username } = req.body || {};
    
    if (!email || !username) {
      return res.status(400).json({ success: false, message: 'Email and username are required' });
    }

    if (!validator.isEmail(String(email))) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email' });
    }

    const user = await User.findOne({ 
      email: String(email).toLowerCase(), 
      username: String(username).toLowerCase() 
    });

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'Email and username do not match. Please contact admin for password recovery.' 
      });
    }

    if (!user.isActive) {
      return res.status(403).json({ 
        success: false, 
        message: 'Account is deactivated. Please contact admin.' 
      });
    }

    // Generate a temporary verification token (not for reset, just for verification)
    const verifyToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = verifyToken;
    user.resetPasswordExpires = Date.now() + 900000; // 15 minutes
    await user.save();

    return res.json({ 
      success: true, 
      message: 'Identity verified successfully',
      verifyToken 
    });
  } catch (err) {
    return serverError(res, err, 'Verify identity error');
  }
};

/**
 * resetPasswordViaIdentity - NEW FUNCTION
 * Body: { email, username, newPassword, confirmPassword }
 * Resets password after identity verification
 */
exports.resetPasswordViaIdentity = async (req, res) => {
  try {
    await ensureDbConnected();

    const { email, username, newPassword, confirmPassword, verifyToken } = req.body || {};
    
    if (!email || !username || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    if (!validator.isEmail(String(email))) {
      return res.status(400).json({ success: false, message: 'Please provide a valid email' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const hasUpper = /[A-Z]/.test(newPassword);
    const hasLower = /[a-z]/.test(newPassword);
    const hasNumber = /\d/.test(newPassword);
    if (!hasUpper || !hasLower || !hasNumber) {
      return res.status(400).json({ success: false, message: 'Password must include uppercase, lowercase, and numbers' });
    }

    // Find user by email and username
    const user = await User.findOne({ 
      email: String(email).toLowerCase(), 
      username: String(username).toLowerCase() 
    }).select('+password');

    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found. Please contact admin for password recovery.' 
      });
    }

    // If verifyToken is provided, check it
    if (verifyToken) {
      if (!user.resetPasswordToken || user.resetPasswordToken !== verifyToken) {
        return res.status(400).json({ 
          success: false, 
          message: 'Verification token is invalid or expired' 
        });
      }

      if (!user.resetPasswordExpires || user.resetPasswordExpires < Date.now()) {
        return res.status(400).json({ 
          success: false, 
          message: 'Verification token has expired. Please start the process again.' 
        });
      }
    }

    if (!user.isActive) {
      return res.status(403).json({ 
        success: false, 
        message: 'Account is deactivated. Please contact admin.' 
      });
    }

    // Check if new password is same as old password
    const isSamePassword = await user.comparePassword(newPassword);
    if (isSamePassword) {
      return res.status(400).json({ 
        success: false, 
        message: 'New password cannot be the same as the old password' 
      });
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    user.loginAttempts = 0; // Reset login attempts
    user.lockUntil = undefined; // Unlock account if locked
    await user.save();

    // Send notification email if available
    if (sendEmail) {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Password Reset Successful',
          html: `<p>Your password has been successfully reset. If you did not initiate this reset, please contact admin immediately.</p>`
        });
      } catch (emailErr) {
        console.warn('[authController] Password reset notification email failed:', emailErr);
      }
    }

    return res.json({ 
      success: true, 
      message: 'Password reset successfully. You can now log in with your new password.' 
    });
  } catch (err) {
    return serverError(res, err, 'Reset password via identity error');
  }
};

/**
 * getCurrentUser
 * Protected route (expects auth middleware to attach req.user)
 */
exports.getCurrentUser = async (req, res) => {
  try {
    await ensureDbConnected();

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const user = await User.findById(req.user._id).select('-password -verificationToken -resetPasswordToken -resetPasswordExpires');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.json({ success: true, user });
  } catch (err) {
    return serverError(res, err, 'Get current user error');
  }
};

/**
 * updateProfile
 */
exports.updateProfile = async (req, res) => {
  try {
    await ensureDbConnected();

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { username, profile, settings } = req.body || {};

    if (username && username !== user.username) {
      if (String(username).length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters' });
      }
      if (!/^[a-zA-Z0-9_]+$/.test(username)) {
        return res.status(400).json({ success: false, message: 'Username can only contain letters, numbers, and underscores' });
      }
      const exists = await User.findOne({ username: String(username).toLowerCase(), _id: { $ne: user._id } });
      if (exists) {
        return res.status(400).json({ success: false, message: 'Username already taken' });
      }
      user.username = String(username).toLowerCase();
    }

    if (profile && typeof profile === 'object') {
      user.profile = { ...user.profile, ...profile };
    }

    if (settings && typeof settings === 'object') {
      user.settings = { ...user.settings, ...settings };
    }

    await user.save();

    user.password = undefined;

    return res.json({
      success: true,
      message: 'Profile updated successfully',
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        profile: user.profile,
        settings: user.settings
      }
    });
  } catch (err) {
    return serverError(res, err, 'Update profile error');
  }
};

/**
 * changePassword
 */
exports.changePassword = async (req, res) => {
  try {
    await ensureDbConnected();

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All password fields are required' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'New passwords do not match' });
    }
    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: 'New password must be at least 8 characters' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const isValid = await user.comparePassword(currentPassword);
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    return serverError(res, err, 'Change password error');
  }
};

/**
 * forgotPassword
 */
exports.forgotPassword = async (req, res) => {
  try {
    await ensureDbConnected();

    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ success: false, message: 'Email is required' });
    }
    if (!validator.isEmail(String(email))) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      // security: do not reveal non-existence
      return res.json({ success: true, message: 'If an account exists with this email, you will receive a password reset link' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    (async () => {
      try {
        if (typeof sendEmail === 'function') {
          await sendEmail({
            to: user.email,
            subject: 'Reset your password',
            html: `<p>Reset link: ${process.env.FRONTEND_URL || ''}/reset-password?token=${resetToken}</p>`
          });
        }
      } catch (emailErr) {
        console.warn('[authController] reset email failed:', emailErr && emailErr.message ? emailErr.message : emailErr);
      }
    })();

    return res.json({ success: true, message: 'Password reset link sent to your email' });
  } catch (err) {
    return serverError(res, err, 'Forgot password error');
  }
};

/**
 * resetPassword
 */
exports.resetPassword = async (req, res) => {
  try {
    await ensureDbConnected();

    const { token, password, confirmPassword } = req.body || {};
    if (!token || !password || !confirmPassword) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Passwords do not match' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    }

    const user = await User.findOne({ resetPasswordToken: token, resetPasswordExpires: { $gt: Date.now() } });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });
    }

    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    return res.json({ success: true, message: 'Password reset successful. You can now log in.' });
  } catch (err) {
    return serverError(res, err, 'Reset password error');
  }
};

/**
 * verifyEmail
 */
exports.verifyEmail = async (req, res) => {
  try {
    await ensureDbConnected();

    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: 'Verification token is required' });
    }

    const user = await User.findOne({ verificationToken: token });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Invalid verification token' });
    }

    user.emailVerified = true;
    user.verificationToken = undefined;
    await user.save();

    const authToken = signToken({ userId: user._id, email: user.email, role: user.role });

    return res.json({
      success: true,
      message: 'Email verified successfully',
      token: authToken,
      user: {
        id: user._id,
        email: user.email,
        username: user.username,
        role: user.role,
        emailVerified: user.emailVerified
      }
    });
  } catch (err) {
    return serverError(res, err, 'Verify email error');
  }
};

/**
 * resendVerification
 */
exports.resendVerification = async (req, res) => {
  try {
    await ensureDbConnected();

    if (!req.user || !req.user._id) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (user.emailVerified) {
      return res.status(400).json({ success: false, message: 'Email is already verified' });
    }

    user.verificationToken = crypto.randomBytes(24).toString('hex');
    await user.save();

    (async () => {
      try {
        if (typeof sendEmail === 'function') {
          await sendEmail({
            to: user.email,
            subject: 'Verify your email',
            html: `<p>Verify: ${process.env.FRONTEND_URL || ''}/verify-email?token=${user.verificationToken}</p>`
          });
        }
      } catch (emailErr) {
        console.warn('[authController] resend verification email failed:', emailErr);
      }
    })();

    return res.json({ success: true, message: 'Verification email sent' });
  } catch (err) {
    return serverError(res, err, 'Resend verification error');
  }
};

/**
 * adminLogin
 * Body: { username, password }
 */
exports.adminLogin = async (req, res) => {
  try {
    await ensureDbConnected();

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }

    const envUser = process.env.ADMIN_USERNAME;
    const envPass = process.env.ADMIN_PASSWORD;
    if (envUser && envPass && username === envUser && password === envPass) {
      // Check if admin user exists in DB, create if not
      let adminUser = await User.findOne({ 
        $or: [{ email: envUser.toLowerCase() }, { username: envUser.toLowerCase() }]
      });
      
      if (!adminUser) {
        // Create admin user if doesn't exist
        adminUser = new User({
          email: process.env.ADMIN_EMAIL || 'admin@example.com',
          username: envUser.toLowerCase(),
          password: envPass,
          role: 'admin',
          emailVerified: true,
          isActive: true
        });
        await adminUser.save();
        console.log('[INFO] Admin user created in database');
      } else if (adminUser.role !== 'admin') {
        // Update existing user to admin
        adminUser.role = 'admin';
        await adminUser.save();
      }
      
      const token = signToken({ 
        userId: adminUser._id, 
        email: adminUser.email, 
        role: 'admin' 
      }, '24h');
      
      adminUser.password = undefined;
      
      return res.json({ 
        success: true, 
        message: 'Admin login successful', 
        token, 
        user: {
          id: adminUser._id,
          email: adminUser.email,
          username: adminUser.username,
          role: 'admin',
          emailVerified: true
        }
      });
    }

    // fallback: try database admin user
    const user = await User.findOne({
      $or: [{ email: String(username).toLowerCase() }, { username: String(username).toLowerCase() }]
    }).select('+password');

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    if (user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const valid = await user.comparePassword(password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = signToken({ userId: user._id, email: user.email, role: user.role }, '24h');
    user.password = undefined;
    return res.json({ 
      success: true, 
      message: 'Admin login successful', 
      token, 
      user: { 
        id: user._id, 
        email: user.email, 
        username: user.username, 
        role: user.role,
        emailVerified: true
      }
    });
  } catch (err) {
    return serverError(res, err, 'Admin login error');
  }
};

/**
 * logout
 */
exports.logout = async (req, res) => {
  try {
    await ensureDbConnected();
    // Invalidate token via blacklist in production; here we just return success
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    return serverError(res, err, 'Logout error');
  }
};
