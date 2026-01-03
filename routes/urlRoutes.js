const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { uploadSingle } = require('../middleware/upload');

const controller = require('../controllers/urlController');

// Dashboard endpoints
router.get('/dashboard-stats', auth, controller.getDashboardStats);
router.get('/recent-urls', auth, controller.getRecentUrls);

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

// Analytics
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

module.exports = router;