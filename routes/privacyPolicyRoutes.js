const express = require('express');
const router = express.Router();
const privacyPolicyController = require('../controllers/privacyPolicyController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

// Public route: Get the currently published privacy policy (no auth required)
router.get('/published', privacyPolicyController.getPublishedPolicy);

// Super Admin routes: Manage drafts, publish, version history, restoration
router.get('/versions', authenticateUser, authorizeRoles('ADMIN'), privacyPolicyController.getAllPolicyVersions);
router.post('/draft', authenticateUser, authorizeRoles('ADMIN'), privacyPolicyController.savePolicyDraft);
router.post('/:id/publish', authenticateUser, authorizeRoles('ADMIN'), privacyPolicyController.publishPolicy);
router.post('/:id/restore', authenticateUser, authorizeRoles('ADMIN'), privacyPolicyController.restorePolicyVersion);

module.exports = router;
