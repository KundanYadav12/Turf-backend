const slotService = require('../services/slotService');
const db = require('../config/database');

const getCourtSlotsForDate = async (req, res, next) => {
  try {
    const { courtId } = req.params;
    const { date } = req.query;

    const targetDate = date || new Date().toISOString().split('T')[0];
    const slots = await slotService.getCourtSlots(courtId, targetDate);

    res.json({
      success: true,
      data: slots
    });
  } catch (error) {
    next(error);
  }
};

const toggleBlockSlot = async (req, res, next) => {
  try {
    const { courtId } = req.params;
    const { date, startTime, endTime, isBlocked } = req.body;

    if (!date || !startTime || !endTime) {
      return res.status(400).json({ success: false, message: 'Date, start time, and end time are required.' });
    }

    const newStatus = isBlocked ? 'BLOCKED' : 'AVAILABLE';

    // Check existing slot
    const existing = await db.query(
      `SELECT id FROM slots WHERE court_id = ? AND date = ? AND start_time = ? AND end_time = ?`,
      [courtId, date, startTime, endTime]
    );

    if (existing.length > 0) {
      await db.query(`UPDATE slots SET status = ? WHERE id = ?`, [newStatus, existing[0].id]);
    } else {
      // Get base price of court
      const courts = await db.query(`SELECT base_price_per_hour FROM courts WHERE id = ?`, [courtId]);
      const price = courts.length > 0 ? parseFloat(courts[0].base_price_per_hour) : 1000.00;

      await db.query(
        `INSERT INTO slots (court_id, date, start_time, end_time, price, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [courtId, date, startTime, endTime, price, newStatus]
      );
    }

    res.json({
      success: true,
      message: `Slot has been ${isBlocked ? 'blocked' : 'unblocked'} successfully.`
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getCourtSlotsForDate,
  toggleBlockSlot
};
