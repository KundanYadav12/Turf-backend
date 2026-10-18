const db = require('../config/database');

const getAdminDashboardStats = async (req, res, next) => {
  try {
    const userCount = await db.query(`SELECT COUNT(id) as total FROM users`);
    const venueCount = await db.query(`SELECT COUNT(id) as total FROM venues`);
    const bookingCount = await db.query(`SELECT COUNT(id) as total FROM bookings`);
    const revenueStats = await db.query(
      `SELECT 
        COALESCE(SUM(final_amount), 0) as total_volume,
        COALESCE(SUM(platform_commission_amount), 0) as total_commission
       FROM bookings WHERE booking_status != 'CANCELLED'`
    );

    const recentBookings = await db.query(
      `SELECT 
        b.*, u.full_name as user_name, v.name as venue_name, c.name as court_name 
       FROM bookings b
       JOIN users u ON b.user_id = u.id
       JOIN venues v ON b.venue_id = v.id
       JOIN courts c ON b.court_id = c.id
       ORDER BY b.created_at DESC LIMIT 10`
    );

    res.json({
      success: true,
      data: {
        totalUsers: userCount[0]?.total || 0,
        totalVenues: venueCount[0]?.total || 0,
        totalBookings: bookingCount[0]?.total || 0,
        totalVolume: parseFloat(revenueStats[0]?.total_volume || 0),
        totalCommission: parseFloat(revenueStats[0]?.total_commission || 0),
        recentBookings: recentBookings.map(b => ({
          id: b.id,
          bookingNumber: b.booking_number,
          userName: b.user_name,
          venueName: b.venue_name,
          courtName: b.court_name,
          bookingDate: b.booking_date,
          finalAmount: parseFloat(b.final_amount),
          commission: parseFloat(b.platform_commission_amount),
          bookingStatus: b.booking_status
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    const users = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at, r.name as role 
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       ORDER BY u.id DESC`
    );

    res.json({
      success: true,
      data: users.map(u => ({
        id: u.id,
        fullName: u.full_name,
        email: u.email,
        phone: u.phone,
        role: u.role || 'PLAYER',
        status: u.status,
        createdAt: u.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
};

const updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status.' });
    }

    await db.query(`UPDATE users SET status = ? WHERE id = ?`, [status, id]);
    res.json({ success: true, message: `User status updated to ${status}.` });
  } catch (error) {
    next(error);
  }
};

const getVenues = async (req, res, next) => {
  try {
    const venues = await db.query(
      `SELECT v.*, u.full_name as owner_name, u.email as owner_email 
       FROM venues v
       JOIN users u ON v.owner_id = u.id
       ORDER BY v.id DESC`
    );

    res.json({
      success: true,
      data: venues.map(v => ({
        id: v.id,
        name: v.name,
        slug: v.slug,
        city: v.city,
        ownerName: v.owner_name,
        ownerEmail: v.owner_email,
        status: v.status,
        createdAt: v.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
};

const updateVenueStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['PENDING', 'APPROVED', 'REJECTED', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid venue status.' });
    }

    await db.query(`UPDATE venues SET status = ? WHERE id = ?`, [status, id]);
    res.json({ success: true, message: `Venue status updated to ${status}.` });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAdminDashboardStats,
  getUsers,
  updateUserStatus,
  getVenues,
  updateVenueStatus
};
