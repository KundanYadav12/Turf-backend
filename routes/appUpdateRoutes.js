const express = require('express');
const router = express.Router();
const appUpdateController = require('../controllers/appUpdateController');
const { optionalAuthenticateUser } = require('../middleware/authMiddleware');

// 1. Mobile Client: Check available update (authenticated or anonymous device)
router.get('/check', optionalAuthenticateUser, appUpdateController.checkUpdate);

// 2. Mobile Client: Expo Updates Manifest
router.get('/manifest', appUpdateController.getManifest);

// 3. Mobile Client: Telemetry / Adoption Logging
router.post('/adoption', optionalAuthenticateUser, appUpdateController.recordAdoption);

module.exports = router;

