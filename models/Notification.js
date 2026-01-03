const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  senderType: {
    type: String,
    enum: ['system', 'admin', 'user'],
    default: 'system'
  },
  type: {
    type: String,
    enum: [
      'info',
      'warning',
      'success',
      'error',
      'message',
      'url_expired',
      'url_disabled',
      'admin_message',
      'system_alert'
    ],
    default: 'info'
  },
  title: {
    type: String,
    required: true,
    maxlength: [100, 'Title cannot exceed 100 characters']
  },
  message: {
    type: String,
    required: true,
    maxlength: [500, 'Message cannot exceed 500 characters']
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  read: {
    type: Boolean,
    default: false,
    index: true
  },
  priority: {
    type: Number,
    enum: [1, 2, 3], // 1: Low, 2: Medium, 3: High
    default: 2
  },
  actionUrl: String,
  actionText: String,
  expiresAt: Date,
  metadata: {
    ipAddress: String,
    userAgent: String,
    location: String
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
notificationSchema.index({ senderType: 1 });
notificationSchema.index({ priority: 1 });

// Pre-save middleware
notificationSchema.pre('save', function(next) {
  // Set default expiration (30 days from creation)
  if (!this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  }
  
  // Set default title based on type if not provided
  if (!this.title) {
    switch (this.type) {
      case 'warning':
        this.title = 'Warning';
        break;
      case 'success':
        this.title = 'Success';
        break;
      case 'error':
        this.title = 'Error';
        break;
      case 'url_expired':
        this.title = 'URL Expired';
        break;
      case 'url_disabled':
        this.title = 'URL Disabled';
        break;
      case 'admin_message':
        this.title = 'Admin Message';
        break;
      default:
        this.title = 'Notification';
    }
  }
  
  next();
});

// Static methods
notificationSchema.statics.createForUser = async function(userId, notificationData) {
  const notification = new this({
    user: userId,
    ...notificationData
  });
  await notification.save();
  return notification;
};

notificationSchema.statics.createForMultipleUsers = async function(userIds, notificationData) {
  const notifications = userIds.map(userId => ({
    user: userId,
    ...notificationData
  }));
  
  return await this.insertMany(notifications);
};

notificationSchema.statics.createSystemNotification = async function(userId, message, data = {}) {
  return await this.createForUser(userId, {
    senderType: 'system',
    type: 'info',
    title: 'System Notification',
    message,
    data,
    priority: 2
  });
};

notificationSchema.statics.createAdminMessage = async function(userId, message, adminId) {
  return await this.createForUser(userId, {
    sender: adminId,
    senderType: 'admin',
    type: 'admin_message',
    title: 'Message from Admin',
    message,
    priority: 3
  });
};

notificationSchema.statics.markAllAsRead = async function(userId) {
  return await this.updateMany(
    { user: userId, read: false },
    { $set: { read: true } }
  );
};

notificationSchema.statics.getUnreadCount = async function(userId) {
  return await this.countDocuments({ 
    user: userId, 
    read: false,
    expiresAt: { $gt: new Date() }
  });
};

notificationSchema.statics.getUserNotifications = async function(userId, options = {}) {
  const { limit = 50, skip = 0, unreadOnly = false } = options;
  
  const query = { 
    user: userId,
    expiresAt: { $gt: new Date() }
  };
  
  if (unreadOnly) {
    query.read = false;
  }
  
  return await this.find(query)
    .sort({ priority: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .populate('sender', 'username email')
    .lean();
};

// Instance methods
notificationSchema.methods.markAsRead = async function() {
  this.read = true;
  await this.save();
  return this;
};

notificationSchema.methods.markAsUnread = async function() {
  this.read = false;
  await this.save();
  return this;
};

notificationSchema.methods.getFormattedTime = function() {
  const now = new Date();
  const diff = now - this.createdAt;
  const diffMinutes = Math.floor(diff / 60000);
  const diffHours = Math.floor(diff / 3600000);
  const diffDays = Math.floor(diff / 86400000);
  
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return this.createdAt.toLocaleDateString();
};

notificationSchema.methods.toClientFormat = function() {
  return {
    id: this._id,
    title: this.title,
    message: this.message,
    type: this.type,
    read: this.read,
    priority: this.priority,
    actionUrl: this.actionUrl,
    actionText: this.actionText,
    sender: this.sender,
    senderType: this.senderType,
    createdAt: this.createdAt,
    formattedTime: this.getFormattedTime(),
    data: this.data
  };
};

const Notification = mongoose.model('Notification', notificationSchema);

module.exports = Notification;