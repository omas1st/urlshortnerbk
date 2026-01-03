const express = require('express');
const router = express.Router();
const { optionalAuth } = require('../middleware/auth');
const {
  sendHelpMessage,
  getHelpTopics,
  submitFeedback
} = require('../controllers/helpController');

// Send help message
router.post('/message', optionalAuth, sendHelpMessage);

// Get help topics
router.get('/topics', getHelpTopics);

// Submit feedback
router.post('/feedback', optionalAuth, submitFeedback);

module.exports = router;