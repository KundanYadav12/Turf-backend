const express = require('express');
const router = express.Router();
const venueController = require('../controllers/venueController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');
const upload = require('../middleware/multerMiddleware');

router.get('/', venueController.getAllVenues);
router.get('/:idOrSlug', venueController.getVenueByIdOrSlug);
router.post(
  '/',
  authenticateUser,
  authorizeRoles('VENUE_OWNER', 'ADMIN'),
  upload.single('image'),
  venueController.createVenue
);

module.exports = router;
