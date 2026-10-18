const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');

router.post('/', authenticateUser, bookingController.createBooking);
router.post('/offline-walkin', authenticateUser, authorizeRoles('VENUE_OWNER', 'VENUE_STAFF', 'ADMIN'), bookingController.createOfflineWalkinBooking);
router.get('/my', authenticateUser, bookingController.getMyBookings);
router.get('/:id', authenticateUser, bookingController.getBookingDetails);
router.post('/:id/cancel', authenticateUser, bookingController.cancelBooking);

module.exports = router;
