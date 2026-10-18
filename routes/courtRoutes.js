const express = require('express');
const router = express.Router({ mergeParams: true });
const courtController = require('../controllers/courtController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

router.get('/', courtController.getCourtsByVenue);
router.post(
  '/',
  authenticateUser,
  authorizeRoles('VENUE_OWNER', 'ADMIN'),
  courtController.createCourt
);

module.exports = router;
