const db = require('../config/database');

const getCourtsByVenue = async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const courts = await db.query(
      `SELECT c.*, s.name as sport_name 
       FROM courts c 
       JOIN sports s ON c.sport_id = s.id 
       WHERE c.venue_id = ?`,
      [venueId]
    );

    res.json({
      success: true,
      data: courts.map(c => ({
        id: c.id,
        venueId: c.venue_id,
        sportId: c.sport_id,
        sportName: c.sport_name,
        name: c.name,
        surfaceType: c.surface_type,
        slotDurationMinutes: c.slot_duration_minutes,
        basePrice: parseFloat(c.base_price_per_hour),
        status: c.status
      }))
    });
  } catch (error) {
    next(error);
  }
};

const createCourt = async (req, res, next) => {
  try {
    const { venueId } = req.params;
    const { sportId, name, surfaceType, slotDurationMinutes, basePrice } = req.body;

    if (!sportId || !name || !basePrice) {
      return res.status(400).json({ success: false, message: 'Sport, name, and base price are required.' });
    }

    const result = await db.query(
      `INSERT INTO courts (venue_id, sport_id, name, surface_type, slot_duration_minutes, base_price_per_hour, status) 
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [venueId, sportId, name, surfaceType || 'Artificial Turf', slotDurationMinutes || 60, basePrice]
    );

    const courtId = result.insertId;

    // Create default operating hours (6 AM to 11 PM for all 7 days)
    for (let day = 0; day <= 6; day++) {
      await db.query(
        `INSERT INTO court_operating_hours (court_id, day_of_week, open_time, close_time, is_closed) 
         VALUES (?, ?, '06:00:00', '23:00:00', 0)`,
        [courtId, day]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Court added successfully!',
      data: { courtId, name }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCourtsByVenue,
  createCourt
};
