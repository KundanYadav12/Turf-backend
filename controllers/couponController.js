const db = require('../config/database');

const applyCoupon = async (req, res, next) => {
  try {
    const { code, bookingAmount, venueId } = req.body;
    const amount = parseFloat(bookingAmount) || 0;

    if (!code) {
      return res.status(400).json({ success: false, message: 'Coupon code is required.' });
    }

    const today = new Date().toISOString().split('T')[0];
    const coupons = await db.query(
      `SELECT * FROM coupons 
       WHERE UPPER(code) = UPPER(?) 
         AND is_active = 1 
         AND valid_from <= ? 
         AND valid_until >= ?
         AND (venue_id IS NULL OR venue_id = ?)`,
      [code, today, today, venueId || null]
    );

    if (!coupons || coupons.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid or expired coupon code.' });
    }

    const coupon = coupons[0];

    if (amount < parseFloat(coupon.min_booking_amount)) {
      return res.status(400).json({
        success: false,
        message: `Minimum booking amount of ₹${coupon.min_booking_amount} is required to apply code ${coupon.code}.`
      });
    }

    let discountAmount = 0.00;
    if (coupon.discount_type === 'PERCENTAGE') {
      discountAmount = (amount * parseFloat(coupon.discount_value)) / 100;
      if (coupon.max_discount_amount && discountAmount > parseFloat(coupon.max_discount_amount)) {
        discountAmount = parseFloat(coupon.max_discount_amount);
      }
    } else {
      discountAmount = parseFloat(coupon.discount_value);
    }

    const finalAmount = Math.max(0, amount - discountAmount);

    res.json({
      success: true,
      message: `Coupon ${coupon.code} applied successfully!`,
      data: {
        code: coupon.code,
        discountType: coupon.discount_type,
        discountValue: parseFloat(coupon.discount_value),
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        finalAmount: parseFloat(finalAmount.toFixed(2))
      }
    });
  } catch (error) {
    next(error);
  }
};

const getCoupons = async (req, res, next) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const coupons = await db.query(
      `SELECT * FROM coupons WHERE is_active = 1 AND valid_until >= ? ORDER BY id DESC`,
      [today]
    );

    res.json({
      success: true,
      data: coupons.map(c => ({
        id: c.id,
        code: c.code,
        discountType: c.discount_type,
        discountValue: parseFloat(c.discount_value),
        minBookingAmount: parseFloat(c.min_booking_amount),
        maxDiscountAmount: c.max_discount_amount ? parseFloat(c.max_discount_amount) : null,
        validUntil: c.valid_until
      }))
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  applyCoupon,
  getCoupons
};
