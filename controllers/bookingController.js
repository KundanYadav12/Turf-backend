const bookingService = require('../services/bookingService');
const db = require('../config/database');
const { sendBookingConfirmation } = require('../services/emailService');

const createBooking = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      venueId,
      courtId,
      sportId,
      bookingDate,
      startTime,
      endTime,
      couponCode,
      notes
    } = req.body;

    if (!venueId || !courtId || !sportId || !bookingDate || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Venue, court, sport, date, start time, and end time are required.'
      });
    }

    const bookingPayload = await bookingService.createBookingWithLock({
      userId,
      venueId,
      courtId,
      sportId,
      bookingDate,
      startTime,
      endTime,
      appliedCouponCode: couponCode,
      bookingType: 'ONLINE',
      notes: notes || ''
    });

    // Send confirmation email asynchronously (non-blocking)
    setImmediate(async () => {
      try {
        let userEmail = req.user?.email;
        let userName = req.user?.full_name || req.user?.username;

        if (!userEmail) {
          const userRows = await db.query('SELECT email, full_name, username FROM users WHERE id = ?', [userId]);
          if (userRows.length > 0) {
            userEmail = userRows[0].email;
            userName = userRows[0].full_name || userRows[0].username;
          }
        }

        if (userEmail) {
          await sendBookingConfirmation({
            email: userEmail,
            fullName: userName,
            bookingNumber: bookingPayload.bookingNumber,
            venueName: bookingPayload.venueName,
            courtName: bookingPayload.courtName,
            bookingDate: bookingPayload.bookingDate,
            startTime: bookingPayload.startTime,
            endTime: bookingPayload.endTime,
            finalAmount: bookingPayload.finalAmount,
            qrCodeToken: bookingPayload.qrCodeToken
          });
        }
      } catch (mailErr) {
        console.warn('[Booking] Confirmation email error:', mailErr.message);
      }
    });

    res.status(201).json({
      success: true,
      message: 'Slot booked successfully!',
      data: bookingPayload
    });
  } catch (error) {
    next(error);
  }
};

const createOfflineWalkinBooking = async (req, res, next) => {
  try {
    const {
      venueId,
      courtId,
      sportId,
      bookingDate,
      startTime,
      endTime,
      customerName,
      customerPhone,
      notes
    } = req.body;

    if (!venueId || !courtId || !sportId || !bookingDate || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'Venue, court, sport, date, start time, and end time are required.'
      });
    }

    // Assign to owner/system user or create offline customer tag
    const userId = req.user.id;
    const notesWithCustomer = `Offline Walkin Customer: ${customerName || 'Walkin'} (${customerPhone || 'N/A'}). ${notes || ''}`;

    const bookingPayload = await bookingService.createBookingWithLock({
      userId,
      venueId,
      courtId,
      sportId,
      bookingDate,
      startTime,
      endTime,
      bookingType: 'OFFLINE_WALKIN',
      notes: notesWithCustomer
    });

    res.status(201).json({
      success: true,
      message: 'Offline walk-in booking created and slot blocked successfully!',
      data: bookingPayload
    });
  } catch (error) {
    next(error);
  }
};

const getMyBookings = async (req, res, next) => {
  try {
    const userId = req.user.id;

    const bookings = await db.query(
      `SELECT 
        b.*,
        v.name as venue_name,
        v.address as venue_address,
        v.city as venue_city,
        c.name as court_name,
        s.name as sport_name,
        s.icon as sport_icon,
        (SELECT image_url FROM venue_images WHERE venue_id = v.id ORDER BY is_primary DESC LIMIT 1) as venue_image
       FROM bookings b
       JOIN venues v ON b.venue_id = v.id
       JOIN courts c ON b.court_id = c.id
       JOIN sports s ON b.sport_id = s.id
       WHERE b.user_id = ?
       ORDER BY b.booking_date DESC, b.start_time DESC`,
      [userId]
    );

    const formatted = bookings.map(b => ({
      id: b.id,
      bookingNumber: b.booking_number,
      venueName: b.venue_name,
      venueAddress: `${b.venue_address}, ${b.venue_city}`,
      venueImage: b.venue_image || 'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80',
      courtName: b.court_name,
      sportName: b.sport_name,
      sportIcon: b.sport_icon,
      bookingDate: b.booking_date,
      startTime: b.start_time,
      endTime: b.end_time,
      finalAmount: parseFloat(b.final_amount),
      bookingStatus: b.booking_status,
      paymentStatus: b.payment_status,
      qrCodeToken: b.qr_code_token,
      createdAt: b.created_at
    }));

    res.json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
};

const getBookingDetails = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const bookings = await db.query(
      `SELECT 
        b.*,
        v.name as venue_name,
        v.address as venue_address,
        v.city as venue_city,
        v.state as venue_state,
        v.pincode as venue_pincode,
        v.cancellation_policy,
        c.name as court_name,
        s.name as sport_name
       FROM bookings b
       JOIN venues v ON b.venue_id = v.id
       JOIN courts c ON b.court_id = c.id
       JOIN sports s ON b.sport_id = s.id
       WHERE b.id = ? AND (b.user_id = ? OR ? = 'ADMIN' OR ? = 'VENUE_OWNER')`,
      [id, userId, req.user.role, req.user.role]
    );

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const b = bookings[0];

    res.json({
      success: true,
      data: {
        id: b.id,
        bookingNumber: b.booking_number,
        venueId: b.venue_id,
        venueName: b.venue_name,
        venueAddress: `${b.venue_address}, ${b.venue_city}, ${b.venue_state} - ${b.venue_pincode}`,
        cancellationPolicy: b.cancellation_policy,
        courtName: b.court_name,
        sportName: b.sport_name,
        bookingDate: b.booking_date,
        startTime: b.start_time,
        endTime: b.end_time,
        subtotalAmount: parseFloat(b.subtotal_amount),
        discountAmount: parseFloat(b.discount_amount),
        finalAmount: parseFloat(b.final_amount),
        bookingStatus: b.booking_status,
        paymentStatus: b.payment_status,
        bookingType: b.booking_type,
        qrCodeToken: b.qr_code_token,
        notes: b.notes,
        createdAt: b.created_at
      }
    });
  } catch (error) {
    next(error);
  }
};

const cancelBooking = async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const bookings = await db.query(
      `SELECT * FROM bookings WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const booking = bookings[0];

    if (booking.booking_status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Booking is already cancelled.' });
    }

    // Update booking status to CANCELLED
    await db.query(`UPDATE bookings SET booking_status = 'CANCELLED' WHERE id = ?`, [id]);

    // Free locked slots
    await db.query(
      `UPDATE slots SET status = 'AVAILABLE' WHERE court_id = ? AND date = ? AND start_time = ? AND end_time = ?`,
      [booking.court_id, booking.booking_date, booking.start_time, booking.end_time]
    );

    res.json({
      success: true,
      message: 'Booking cancelled successfully.'
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createBooking,
  createOfflineWalkinBooking,
  getMyBookings,
  getBookingDetails,
  cancelBooking
};
