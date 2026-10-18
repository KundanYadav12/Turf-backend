const express = require('express');
const router = express.Router();
const ownerController = require('../controllers/ownerController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

router.use(authenticateUser, authorizeRoles('VENUE_OWNER', 'ADMIN'));

router.get('/dashboard', ownerController.getOwnerDashboardStats);
router.get('/calendar', ownerController.getOwnerCalendarGrid);
router.get('/tournament-summary', ownerController.getOrganizerTournamentSummary);

module.exports = router;
