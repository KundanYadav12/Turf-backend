const db = require('../config/database');

const createReview = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const { bookingId, rating, comment, groundQualityRating, cleanlinessRating, staffRating, facilitiesRating } = req.body;

    if (!bookingId || !rating) {
      return res.status(400).json({ success: false, message: 'Booking ID and rating (1-5) are required.' });
    }

    // Verify user completed this booking
    const bookings = await db.query(
      `SELECT * FROM bookings WHERE id = ? AND user_id = ? AND booking_status IN ('CONFIRMED', 'COMPLETED')`,
      [bookingId, userId]
    );

    if (!bookings || bookings.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'You can only review venues for completed or valid bookings.'
      });
    }

    const booking = bookings[0];

    // Check if already reviewed
    const existing = await db.query(`SELECT id FROM reviews WHERE booking_id = ?`, [bookingId]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'You have already submitted a review for this booking.' });
    }

    const result = await db.query(
      `INSERT INTO reviews (booking_id, venue_id, user_id, rating, ground_quality_rating, cleanliness_rating, staff_rating, facilities_rating, comment) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bookingId,
        booking.venue_id,
        userId,
        parseInt(rating),
        parseInt(groundQualityRating || 5),
        parseInt(cleanlinessRating || 5),
        parseInt(staffRating || 5),
        parseInt(facilitiesRating || 5),
        comment || ''
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Thank you for your feedback! Review published.',
      data: { reviewId: result.insertId }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createReview
};
