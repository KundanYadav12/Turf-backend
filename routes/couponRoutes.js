const express = require('express');
const router = express.Router();
const couponController = require('../controllers/couponController');

router.post('/apply', couponController.applyCoupon);
router.get('/', couponController.getCoupons);

module.exports = router;
