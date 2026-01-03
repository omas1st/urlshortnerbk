// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    validate: [validator.isEmail, 'Please provide a valid email']
  },
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    lowercase: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username cannot exceed 30 characters'],
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isActive: { type: Boolean, default: true },
  emailVerified: { type: Boolean, default: false },
  verificationToken: String,
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  lastLogin: Date,
  loginAttempts: { type: Number, default: 0 },
  lockUntil: Date,
  profile: {
    avatar: String,
    bio: String,
    website: String
  },
  settings: {
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true }
    },
    privacy: {
      showInPublic: { type: Boolean, default: true },
      analyticsSharing: { type: Boolean, default: false }
    }
  },
  stats: {
    totalUrls: { type: Number, default: 0 },
    totalClicks: { type: Number, default: 0 },
    lastActive: Date
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for user's URLs
userSchema.virtual('urls', {
  ref: 'Url',
  localField: '_id',
  foreignField: 'user'
});

// Index definitions
// NOTE: email and username are already declared with `unique: true` above.
// Removing duplicate explicit index declarations to avoid conflicts with existing DB indexes.
userSchema.index({ 'stats.lastActive': -1 });
userSchema.index({ createdAt: -1 });

/**
 * Pre-save hook: hash password if modified.
 * IMPORTANT: Use an async function WITHOUT the `next` param so Mongoose
 * treats it as a Promise-returning middleware. Do NOT call next().
 */
userSchema.pre('save', async function () {
  // `this` is the document
  if (!this.isModified('password')) return;

  // If password is falsy (shouldn't happen due to validators) skip hashing
  if (!this.password) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to compare candidate password with stored hash
userSchema.methods.comparePassword = async function (candidatePassword) {
  // password field was selected using .select('+password') when needed
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to check if account is locked
userSchema.methods.isLocked = function () {
  return !!(this.lockUntil && this.lockUntil > Date.now());
};

// Method to increment login attempts
userSchema.methods.incLoginAttempts = async function () {
  // If lockUntil has passed, restart loginAttempts
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return await this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 }
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  // Lock the account if max attempts reached and not already locked
  if ((this.loginAttempts || 0) + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockUntil: Date.now() + (2 * 60 * 60 * 1000) }; // lock for 2 hours
  }

  return await this.updateOne(updates);
};

// Reset login attempts on successful login
userSchema.methods.resetLoginAttempts = async function () {
  return await this.updateOne({
    $set: { loginAttempts: 0 },
    $unset: { lockUntil: 1 }
  });
};

// Generate JWT token
userSchema.methods.generateAuthToken = function () {
  const jwt = require('jsonwebtoken');
  const secret = process.env.secret_key || process.env.JWT_SECRET || process.env.SECRET_KEY || 'dev_secret';
  return jwt.sign(
    {
      userId: this._id,
      email: this.email,
      role: this.role
    },
    secret,
    { expiresIn: '7d' }
  );
};

// Update last active timestamp
userSchema.methods.updateLastActive = async function () {
  this.stats = this.stats || {};
  this.stats.lastActive = new Date();
  await this.save();
};

// Static helper: find by email or username (returns document with password selected)
userSchema.statics.findByEmailOrUsername = function (identifier) {
  const id = String(identifier || '').toLowerCase();
  return this.findOne({
    $or: [
      { email: id },
      { username: id }
    ]
  }).select('+password');
};

// Static helper: register (uses schema pre-save to hash password)
userSchema.statics.register = async function (userData) {
  const user = new this(userData);
  await user.save();
  return user;
};

const User = mongoose.model('User', userSchema);

module.exports = User;
