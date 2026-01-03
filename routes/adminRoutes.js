const express = require('express');
const router = express.Router();
const { adminAuth } = require('../middleware/adminAuth');
const {
  getAdminStats,
  getAllUsers,
  getUserDetails,
  updateUser,
  deleteUser,
  getAllUrls,
  getUrlDetails,
  updateUrl,
  deleteUrl,
  sendMessageToUser,
  getSystemAnalytics,
  getUserUrls,
  bulkOperations
} = require('../controllers/adminController');

// Admin dashboard
router.get('/stats', adminAuth, getAdminStats);

// User management
router.get('/users', adminAuth, getAllUsers);
router.get('/users/:id', adminAuth, getUserDetails);
router.put('/users/:id', adminAuth, updateUser);
router.delete('/users/:id', adminAuth, deleteUser);
router.post('/users/:id/message', adminAuth, sendMessageToUser);
router.get('/users/:id/urls', adminAuth, getUserUrls);

// URL management
router.get('/urls', adminAuth, getAllUrls);
router.get('/urls/:id', adminAuth, getUrlDetails);
router.put('/urls/:id', adminAuth, updateUrl);
router.delete('/urls/:id', adminAuth, deleteUrl);

// System analytics
router.get('/analytics', adminAuth, getSystemAnalytics);

// Bulk operations
router.post('/bulk', adminAuth, bulkOperations);

module.exports = router;