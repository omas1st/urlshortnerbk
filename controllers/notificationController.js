const Notification = require('../models/Notification');

// Get user notifications
const getNotifications = async (req, res) => {
  try {
    const { limit = 50, skip = 0, unreadOnly = false } = req.query;
    
    const notifications = await Notification.getUserNotifications(req.user._id, {
      limit: parseInt(limit),
      skip: parseInt(skip),
      unreadOnly: unreadOnly === 'true'
    });
    
    const unreadCount = await Notification.getUnreadCount(req.user._id);
    
    res.json({
      success: true,
      notifications: notifications.map(n => ({
        id: n._id,
        title: n.title,
        message: n.message,
        type: n.type,
        read: n.read,
        priority: n.priority,
        actionUrl: n.actionUrl,
        actionText: n.actionText,
        sender: n.sender,
        senderType: n.senderType,
        createdAt: n.createdAt,
        formattedTime: new Date(n.createdAt).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      })),
      unreadCount,
      total: notifications.length
    });
    
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get notifications'
    });
  }
};

// Mark notification as read
const markAsRead = async (req, res) => {
  try {
    const { id } = req.params;
    
    const notification = await Notification.findOne({
      _id: id,
      user: req.user._id
    });
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    await notification.markAsRead();
    
    res.json({
      success: true,
      message: 'Notification marked as read'
    });
    
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark notification as read'
    });
  }
};

// Mark all notifications as read
const markAllAsRead = async (req, res) => {
  try {
    await Notification.markAllAsRead(req.user._id);
    
    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
    
  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark all notifications as read'
    });
  }
};

// Delete notification
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    
    const notification = await Notification.findOne({
      _id: id,
      user: req.user._id
    });
    
    if (!notification) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }
    
    await notification.deleteOne();
    
    res.json({
      success: true,
      message: 'Notification deleted'
    });
    
  } catch (error) {
    console.error('Delete notification error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete notification'
    });
  }
};

// Clear all notifications
const clearAllNotifications = async (req, res) => {
  try {
    await Notification.deleteMany({ user: req.user._id });
    
    res.json({
      success: true,
      message: 'All notifications cleared'
    });
    
  } catch (error) {
    console.error('Clear all notifications error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear notifications'
    });
  }
};

// Get notification settings
const getNotificationSettings = async (req, res) => {
  try {
    const user = req.user;
    
    res.json({
      success: true,
      settings: user.settings.notifications
    });
    
  } catch (error) {
    console.error('Get notification settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get notification settings'
    });
  }
};

// Update notification settings
const updateNotificationSettings = async (req, res) => {
  try {
    const { email, push } = req.body;
    
    const user = req.user;
    
    if (email !== undefined) {
      user.settings.notifications.email = email;
    }
    
    if (push !== undefined) {
      user.settings.notifications.push = push;
    }
    
    await user.save();
    
    res.json({
      success: true,
      message: 'Notification settings updated',
      settings: user.settings.notifications
    });
    
  } catch (error) {
    console.error('Update notification settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update notification settings'
    });
  }
};

// Create notification (for internal use)
const createNotification = async (userId, notificationData) => {
  try {
    const notification = await Notification.createForUser(userId, notificationData);
    return notification;
  } catch (error) {
    console.error('Create notification error:', error);
    return null;
  }
};

// Send URL expiration notifications
const sendExpirationNotifications = async () => {
  try {
    const Url = require('../models/Url');
    const now = new Date();
    const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    
    // Find URLs expiring in the next 3 days
    const expiringUrls = await Url.find({
      expirationDate: {
        $gte: now,
        $lte: threeDaysFromNow
      },
      isActive: true
    }).populate('user');
    
    for (const url of expiringUrls) {
      // Calculate days until expiration
      const daysUntilExpiration = Math.ceil(
        (url.expirationDate - now) / (1000 * 60 * 60 * 24)
      );
      
      await createNotification(url.user._id, {
        type: 'warning',
        title: 'URL Expiring Soon',
        message: `Your short URL ${url.shortId} will expire in ${daysUntilExpiration} day(s).`,
        data: {
          urlId: url._id,
          shortId: url.shortId,
          expirationDate: url.expirationDate,
          daysUntilExpiration
        },
        actionUrl: `/urls/${url._id}`,
        actionText: 'Manage URL',
        priority: 2
      });
    }
    
    console.log(`Sent ${expiringUrls.length} expiration notifications`);
  } catch (error) {
    console.error('Send expiration notifications error:', error);
  }
};

// Send URL disabled notifications
const sendDisabledNotification = async (urlId, reason) => {
  try {
    const Url = require('../models/Url');
    const url = await Url.findById(urlId).populate('user');
    
    if (!url || !url.user) {
      return;
    }
    
    await createNotification(url.user._id, {
      type: 'error',
      title: 'URL Disabled',
      message: `Your short URL ${url.shortId} has been ${reason}.`,
      data: {
        urlId: url._id,
        shortId: url.shortId,
        reason
      },
      actionUrl: `/urls/${url._id}`,
      actionText: 'View Details',
      priority: 3
    });
  } catch (error) {
    console.error('Send disabled notification error:', error);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  getNotificationSettings,
  updateNotificationSettings,
  createNotification,
  sendExpirationNotifications,
  sendDisabledNotification
};