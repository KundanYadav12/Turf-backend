const db = require('../config/database');

/**
 * Computes slot schedule for a given court and date
 */
const getCourtSlots = async (courtId, dateString) => {
  // 1. Fetch Court details & Venue details
  const courts = await db.query(
    `SELECT c.*, v.name as venue_name 
     FROM courts c 
     JOIN venues v ON c.venue_id = v.id 
     WHERE c.id = ?`,
    [courtId]
  );

  if (!courts || courts.length === 0) {
    throw new Error('Court not found');
  }

  const court = courts[0];
  const duration = court.slot_duration_minutes || 60;
  const basePrice = parseFloat(court.base_price_per_hour);

  // 2. Fetch operating hours for the given day of week
  const dateObj = new Date(dateString);
  const dayOfWeek = dateObj.getDay(); // 0 = Sunday, 1 = Monday...

  const operatingHours = await db.query(
    `SELECT * FROM court_operating_hours WHERE court_id = ? AND day_of_week = ?`,
    [courtId, dayOfWeek]
  );

  let openTime = '06:00:00';
  let closeTime = '23:00:00';
  let isClosed = false;

  if (operatingHours && operatingHours.length > 0) {
    if (operatingHours[0].is_closed) isClosed = true;
    openTime = operatingHours[0].open_time;
    closeTime = operatingHours[0].close_time;
  }

  if (isClosed) {
    return [];
  }

  // 3. Fetch existing explicit slot overrides/records from database
  const existingSlots = await db.query(
    `SELECT * FROM slots WHERE court_id = ? AND date = ?`,
    [courtId, dateString]
  );

  const slotMap = new Map();
  existingSlots.forEach(s => {
    slotMap.set(`${s.start_time}_${s.end_time}`, s);
  });

  // 4. Generate slot intervals from openTime to closeTime
  const generatedSlots = [];
  const openHour = parseInt(openTime.split(':')[0], 10);
  const closeHour = parseInt(closeTime.split(':')[0], 10);

  for (let h = openHour; h < closeHour; h += (duration / 60)) {
    const startHourStr = String(Math.floor(h)).padStart(2, '0');
    const startMinStr = String((h % 1) * 60).padStart(2, '0');
    const startTime = `${startHourStr}:${startMinStr}:00`;

    const endH = h + (duration / 60);
    const endHourStr = String(Math.floor(endH)).padStart(2, '0');
    const endMinStr = String((endH % 1) * 60).padStart(2, '0');
    const endTime = `${endHourStr}:${endMinStr}:00`;

    const key = `${startTime}_${endTime}`;
    const existing = slotMap.get(key);

    if (existing) {
      generatedSlots.push({
        id: existing.id,
        courtId: courtId,
        date: dateString,
        startTime: startTime,
        endTime: endTime,
        price: parseFloat(existing.price),
        status: existing.status
      });
    } else {
      generatedSlots.push({
        id: null,
        courtId: courtId,
        date: dateString,
        startTime: startTime,
        endTime: endTime,
        price: basePrice,
        status: 'AVAILABLE'
      });
    }
  }

  return generatedSlots;
};

module.exports = {
  getCourtSlots
};
