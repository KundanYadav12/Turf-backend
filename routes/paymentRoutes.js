const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { authenticateUser } = require('../middleware/authMiddleware');

router.post('/create-order', authenticateUser, paymentController.createOrder);
router.post('/verify', authenticateUser, paymentController.verifyPayment);

module.exports = router;
