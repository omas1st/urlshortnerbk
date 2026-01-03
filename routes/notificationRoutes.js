const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAllNotifications,
  getNotificationSettings,
  updateNotificationSettings
} = require('../controllers/notificationController');

// Get notifications
router.get('/', auth, getNotifications);

// Mark as read
router.put('/:id/read', auth, markAsRead);
router.put('/read-all', auth, markAllAsRead);

// Delete notification
router.delete('/:id', auth, deleteNotification);
router.delete('/', auth, clearAllNotifications);

// Settings
router.get('/settings', auth, getNotificationSettings);
router.put('/settings', auth, updateNotificationSettings);

module.exports = router;