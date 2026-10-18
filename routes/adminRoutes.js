const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

router.use(authenticateUser, authorizeRoles('ADMIN'));

router.get('/dashboard', adminController.getAdminDashboardStats);
router.get('/users', adminController.getUsers);
router.patch('/users/:id/status', adminController.updateUserStatus);
router.get('/venues', adminController.getVenues);
router.patch('/venues/:id/status', adminController.updateVenueStatus);

// Privacy Policy Super Admin Management
const privacyPolicyController = require('../controllers/privacyPolicyController');
router.get('/privacy-policy/versions', privacyPolicyController.getAllPolicyVersions);
router.post('/privacy-policy/draft', privacyPolicyController.savePolicyDraft);
router.post('/privacy-policy/:id/publish', privacyPolicyController.publishPolicy);
router.post('/privacy-policy/:id/restore', privacyPolicyController.restorePolicyVersion);

// Account Deletion Super Admin Management
const accountDeletionController = require('../controllers/accountDeletionController');
router.get('/account-deletions', accountDeletionController.getAdminDeletionRequests);
router.get('/account-deletions/audits', accountDeletionController.getAdminDeletionAudits);
router.get('/account-deletions/:userId', accountDeletionController.getAdminDeletionRequestDetails);
router.post('/account-deletions/:userId/restore', accountDeletionController.restoreAccount);
router.post('/account-deletions/:userId/permanent-delete', accountDeletionController.permanentDeleteAccount);

module.exports = router;
