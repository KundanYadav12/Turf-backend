const express = require('express');
const router = express.Router();
const accountDeletionController = require('../controllers/accountDeletionController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

// Public route: Google Play compliant web deletion request
router.post('/public-deletion-request', accountDeletionController.publicDeletionRequest);

// Authenticated user routes: Self soft-deletion and status
router.post('/me/delete-request', authenticateUser, accountDeletionController.requestSelfDeletion);
router.get('/me/deletion-status', authenticateUser, accountDeletionController.getSelfDeletionStatus);

// Super Admin routes: Review, filter, restore, permanent deletion, and audits
router.get('/admin/requests', authenticateUser, authorizeRoles('ADMIN'), accountDeletionController.getAdminDeletionRequests);
router.get('/admin/requests/:userId', authenticateUser, authorizeRoles('ADMIN'), accountDeletionController.getAdminDeletionRequestDetails);
router.post('/admin/requests/:userId/restore', authenticateUser, authorizeRoles('ADMIN'), accountDeletionController.restoreAccount);
router.post('/admin/requests/:userId/permanent-delete', authenticateUser, authorizeRoles('ADMIN'), accountDeletionController.permanentDeleteAccount);
router.get('/admin/audits', authenticateUser, authorizeRoles('ADMIN'), accountDeletionController.getAdminDeletionAudits);

module.exports = router;
