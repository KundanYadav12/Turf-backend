const db = require('../config/database');
const { calculatePlatformCommission } = require('./commissionService');
const crypto = require('crypto');

/**
 * Creates a booking with explicit Database Transaction Locking (SELECT FOR UPDATE)
 * to prevent race conditions & double bookings.
 */
const createBookingWithLock = async ({
  userId,
  venueId,
  courtId,
  sportId,
  bookingDate,
  startTime,
  endTime,
  appliedCouponCode = null,
  bookingType = 'ONLINE',
  notes = ''
}) => {
  return await db.transaction(async (connection) => {
    // 1. Fetch court to verify validity & pricing
    const [courts] = await connection.query(
      `SELECT c.*, v.name as venue_name 
       FROM courts c 
       JOIN venues v ON c.venue_id = v.id 
       WHERE c.id = ? AND c.venue_id = ?`,
      [courtId, venueId]
    );

    if (!courts || courts.length === 0) {
      throw { statusCode: 404, message: 'Court or Venue not found.' };
    }

    const court = courts[0];
    const basePrice = parseFloat(court.base_price_per_hour);

    // 2. Lock matching slots with FOR UPDATE to prevent simultaneous double booking
    const [existingSlots] = await connection.query(
      `SELECT * FROM slots 
       WHERE court_id = ? AND date = ? AND start_time < ? AND end_time > ? 
       FOR UPDATE`,
      [courtId, bookingDate, endTime, startTime]
    );

    // Check if any slot is already booked or blocked
    const conflictingSlot = existingSlots.find(s => 
      s.status === 'BOOKED' || s.status === 'BLOCKED' || s.status === 'OFFLINE_BOOKED'
    );

    if (conflictingSlot) {
      throw { 
        statusCode: 409, 
        message: 'Selected slot is no longer available. It was just booked by another user.' 
      };
    }

    // 3. Calculate price & discounts
    let subtotal = basePrice;
    let discountAmount = 0.00;

    if (appliedCouponCode) {
      const [coupons] = await connection.query(
        `SELECT * FROM coupons WHERE code = ? AND is_active = 1 AND valid_from <= ? AND valid_until >= ?`,
        [appliedCouponCode, bookingDate, bookingDate]
      );
      
      if (coupons && coupons.length > 0) {
        const coupon = coupons[0];
        if (coupon.discount_type === 'PERCENTAGE') {
          discountAmount = (subtotal * parseFloat(coupon.discount_value)) / 100;
          if (coupon.max_discount_amount && discountAmount > parseFloat(coupon.max_discount_amount)) {
            discountAmount = parseFloat(coupon.max_discount_amount);
          }
        } else {
          discountAmount = parseFloat(coupon.discount_value);
        }
      }
    }

    const finalAmount = Math.max(0, subtotal - discountAmount);
    const platformCommission = calculatePlatformCommission(finalAmount);

    // 4. Upsert slot entry to lock state to 'BOOKED' / 'OFFLINE_BOOKED'
    const newStatus = bookingType.startsWith('OFFLINE') ? 'OFFLINE_BOOKED' : 'BOOKED';
    let slotId = null;

    if (existingSlots.length > 0) {
      slotId = existingSlots[0].id;
      await connection.query(
        `UPDATE slots SET status = ? WHERE id = ?`,
        [newStatus, slotId]
      );
    } else {
      const [insertSlotResult] = await connection.query(
        `INSERT INTO slots (court_id, date, start_time, end_time, price, status) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [courtId, bookingDate, startTime, endTime, basePrice, newStatus]
      );
      slotId = insertSlotResult.insertId;
    }

    // 5. Generate Unique Booking Ticket Code & QR Token
    const dateFormatted = bookingDate.replace(/-/g, '');
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const bookingNumber = `BK-${dateFormatted}-${randomHex}`;
    const qrCodeToken = `QR_${bookingNumber}_${Date.now()}`;

    // 6. Insert Booking Record
    const [bookingResult] = await connection.query(
      `INSERT INTO bookings 
       (booking_number, user_id, venue_id, court_id, sport_id, booking_date, start_time, end_time, subtotal_amount, discount_amount, tax_amount, final_amount, platform_commission_amount, booking_type, booking_status, payment_status, qr_code_token, notes) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.00, ?, ?, ?, 'CONFIRMED', 'PAID', ?, ?)`,
      [
        bookingNumber,
        userId,
        venueId,
        courtId,
        sportId,
        bookingDate,
        startTime,
        endTime,
        subtotal,
        discountAmount,
        finalAmount,
        platformCommission,
        bookingType,
        qrCodeToken,
        notes
      ]
    );

    const bookingId = bookingResult.insertId;

    // 7. Insert mapping into booking_slots
    await connection.query(
      `INSERT INTO booking_slots (booking_id, slot_id) VALUES (?, ?)`,
      [bookingId, slotId]
    );

    const txRef = `TXN_${bookingNumber}_${Date.now()}`;
    const paymentMethod = bookingType.startsWith('OFFLINE') ? 'CASH' : 'UPI';
    await connection.query(
      `INSERT INTO payments (booking_id, transaction_reference, gateway_name, amount, currency, payment_method, status) 
       VALUES (?, ?, 'RAZORPAY_MOCK', ?, 'INR', ?, 'SUCCESS')`,
      [bookingId, txRef, finalAmount, paymentMethod]
    );

    // Return created booking payload
    return {
      bookingId,
      bookingNumber,
      venueName: court.venue_name,
      courtName: court.name,
      bookingDate,
      startTime,
      endTime,
      finalAmount,
      bookingStatus: 'CONFIRMED',
      paymentStatus: 'PAID',
      qrCodeToken
    };
  });
};

module.exports = {
  createBookingWithLock
};
