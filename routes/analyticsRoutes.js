const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const {
  getOverallAnalytics,
  getUrlAnalytics,
  exportAnalytics,
  getRealTimeAnalytics,
  getAnalyticsSummary
} = require('../controllers/analyticsController');

// Overall analytics
router.get('/overall', auth, getOverallAnalytics);

// URL-specific analytics
router.get('/url/:id', auth, getUrlAnalytics);

// Export analytics
router.get('/export/overall', auth, exportAnalytics);
router.get('/export/url/:id', auth, exportAnalytics);

// Real-time analytics
router.get('/realtime/overall', auth, getRealTimeAnalytics);
router.get('/realtime/url/:id', auth, getRealTimeAnalytics);

// Summary
router.get('/summary', auth, getAnalyticsSummary);

module.exports = router;