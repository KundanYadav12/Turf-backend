const express = require('express');
const router = express.Router({ mergeParams: true });
const slotController = require('../controllers/slotController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

router.get('/', slotController.getCourtSlotsForDate);
router.post(
  '/block',
  authenticateUser,
  authorizeRoles('VENUE_OWNER', 'ADMIN'),
  slotController.toggleBlockSlot
);

module.exports = router;
