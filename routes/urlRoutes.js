const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');

const controller = require('../controllers/urlController');
const analyticsController = require('../controllers/analyticsController'); // Import analytics controller

// Dashboard endpoints - use analytics controller for overall analytics
router.get('/dashboard-stats', auth, controller.getDashboardStats);
router.get('/recent-urls', auth, controller.getRecentUrls);

// Overall analytics endpoint
router.get('/overall-analytics', auth, analyticsController.getOverallAnalytics);

// Core operations
router.post('/shorten', auth, controller.shortenUrl);
router.post('/smart-generate', auth, controller.smartGenerate);
router.get('/user-urls', auth, controller.getUserUrls);
router.post('/bulk', auth, controller.bulkOperations);

// URL status management
router.put('/:id/status', auth, controller.updateUrlStatus);

// URL specific operations
router.get('/:id', auth, controller.getUrl);
router.put('/:id', auth, controller.updateUrl);
router.delete('/:id', auth, controller.deleteUrl);

// Analytics - Use the updated function from urlController
router.get('/:id/analytics', auth, controller.getUrlAnalytics);
router.get('/:id/export', auth, controller.exportUrlAnalytics);

// Version management
router.get('/:id/versions', auth, controller.getUrlVersions);
router.post('/:id/rollback/:versionId', auth, controller.rollbackToVersion);

// A/B Testing
router.post('/:id/ab-testing', auth, controller.enableABTesting);
router.delete('/:id/ab-testing', auth, controller.disableABTesting);

// Image upload
router.post('/:id/upload-image', auth, uploadSingle('image'), controller.uploadImage);

// QR Code
router.get('/:shortId/qr', controller.getQRCode);

// Public URL info
router.get('/public/:shortId', controller.getUrlByShortId);

// QR Codes endpoints
router.get('/qr-codes', auth, controller.getUserQRCodes); // Add this line

// Overall analytics endpoint
router.get('/overall-analytics', auth, analyticsController.getOverallAnalytics);

module.exports = router;