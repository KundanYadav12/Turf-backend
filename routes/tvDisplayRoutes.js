const express = require('express');
const router = express.Router();
const tvDisplayController = require('../controllers/tvDisplayController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

// ── Public TV Routes (Run on Smart TV screen without user login) ──
router.get('/display/:displayId', tvDisplayController.getDisplayData);
router.post('/pair/request-code', tvDisplayController.requestPairingCode);
router.get('/pair/check/:code', tvDisplayController.checkPairingStatus);

// ── Protected TV Management Routes (Venue Owner, Venue Staff & Admin) ──
router.get('/displays', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), tvDisplayController.listDisplays);
router.post('/displays', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), tvDisplayController.saveDisplayConfig);
router.put('/displays/:id', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), tvDisplayController.saveDisplayConfig);
router.delete('/displays/:id', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), tvDisplayController.deleteDisplay);
router.post('/pair/claim', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), tvDisplayController.claimPairingCode);

module.exports = router;
