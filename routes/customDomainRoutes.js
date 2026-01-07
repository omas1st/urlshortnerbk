const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const controller = require('../controllers/customDomainController');

// Add custom domain
router.post('/add', auth, controller.addCustomDomain);

// Verify domain DNS
router.post('/:domainId/verify', auth, controller.verifyDomain);

// Get user's domains
router.get('/', auth, controller.getUserDomains);

// Get specific domain
router.get('/:domainId', auth, controller.getDomainById);

// Delete domain
router.delete('/:domainId', auth, controller.deleteDomain);

// Get URLs available for branding
router.get('/urls/brandable', auth, controller.getBrandableUrls);

module.exports = router;