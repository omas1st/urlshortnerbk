// routes/redirect.js
const express = require('express');
const router = express.Router();
const redirectController = require('../controllers/redirectController');

// Accept GET (show password form / splash / redirect) and POST (password submission)
router.get('/s/:shortId', redirectController.handleRedirect);
router.post('/s/:shortId', express.urlencoded({ extended: false }), redirectController.handleRedirect);

module.exports = router;
