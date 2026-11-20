const db = require('../config/database');

let isColumnChecked = false;
async function ensureLastLoginColumn() {
  if (isColumnChecked) return;
  try {
    const cols = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'last_login_at'
    `).catch(() => []);

    if (!cols || cols.length === 0) {
      await db.query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL`).catch(() => {});
    }
    isColumnChecked = true;
  } catch (err) {
    isColumnChecked = true;
  }
}

const getAdminDashboardStats = async (req, res, next) => {
  try {
    await ensureLastLoginColumn().catch(() => {});

    const userCount = await db.query(`SELECT COUNT(id) as total FROM users`).catch(() => [{ total: 0 }]);

    let activeUsers = 1;
    try {
      const activeLoginCount = await db.query(
        `SELECT COUNT(id) as total FROM users WHERE last_login_at >= NOW() - INTERVAL 1 DAY`
      );
      activeUsers = Math.max(1, activeLoginCount[0]?.total || 1);
    } catch {
      try {
        const recentCreated = await db.query(
          `SELECT COUNT(id) as total FROM users WHERE created_at >= NOW() - INTERVAL 1 DAY`
        );
        activeUsers = Math.max(1, recentCreated[0]?.total || 1);
      } catch {
        activeUsers = Math.max(1, userCount[0]?.total || 1);
      }
    }

    const venueCount = await db.query(`SELECT COUNT(id) as total FROM venues`).catch(() => [{ total: 0 }]);
    const bookingCount = await db.query(`SELECT COUNT(id) as total FROM bookings`).catch(() => [{ total: 0 }]);

    let totalVolume = 0;
    let totalCommission = 0;
    try {
      const revenueStats = await db.query(
        `SELECT 
          COALESCE(SUM(final_amount), 0) as total_volume,
          COALESCE(SUM(platform_commission_amount), 0) as total_commission
         FROM bookings WHERE booking_status != 'CANCELLED'`
      );
      totalVolume = parseFloat(revenueStats[0]?.total_volume || 0);
      totalCommission = parseFloat(revenueStats[0]?.total_commission || 0);
    } catch (e) {
      console.warn('Admin revenue stats note:', e.message);
    }

    let recentBookings = [];
    try {
      recentBookings = await db.query(
        `SELECT 
          b.*, u.full_name as user_name, v.name as venue_name, c.name as court_name 
         FROM bookings b
         LEFT JOIN users u ON b.user_id = u.id
         LEFT JOIN venues v ON b.venue_id = v.id
         LEFT JOIN courts c ON b.court_id = c.id
         ORDER BY b.created_at DESC LIMIT 10`
      );
    } catch (e) {
      console.warn('Admin recent bookings note:', e.message);
    }

    res.json({
      success: true,
      data: {
        totalUsers: userCount[0]?.total || 0,
        activeUsers,
        totalVenues: venueCount[0]?.total || 0,
        totalBookings: bookingCount[0]?.total || 0,
        totalVolume,
        totalCommission,
        recentBookings: (recentBookings || []).map(b => ({
          id: b.id,
          bookingNumber: b.booking_number || 'N/A',
          userName: b.user_name || 'Customer',
          venueName: b.venue_name || 'Venue',
          courtName: b.court_name || 'Court',
          bookingDate: b.booking_date,
          finalAmount: parseFloat(b.final_amount || 0),
          commission: parseFloat(b.platform_commission_amount || 0),
          bookingStatus: b.booking_status
        }))
      }
    });
  } catch (error) {
    console.error('getAdminDashboardStats fatal error:', error);
    next(error);
  }
};

const getUsers = async (req, res, next) => {
  try {
    await ensureLastLoginColumn().catch(() => {});

    let users = [];
    try {
      users = await db.query(
        `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at, u.last_login_at, r.name as role 
         FROM users u
         LEFT JOIN user_roles ur ON u.id = ur.user_id
         LEFT JOIN roles r ON ur.role_id = r.id
         ORDER BY u.id DESC`
      );
    } catch (err) {
      console.warn('getUsers query with last_login_at note:', err.message);
      try {
        users = await db.query(
          `SELECT u.id, u.full_name, u.email, u.phone, u.status, u.created_at, r.name as role 
           FROM users u
           LEFT JOIN user_roles ur ON u.id = ur.user_id
           LEFT JOIN roles r ON ur.role_id = r.id
           ORDER BY u.id DESC`
        );
      } catch (err2) {
        console.warn('getUsers fallback to users table note:', err2.message);
        users = await db.query(`SELECT * FROM users ORDER BY id DESC`).catch(() => []);
      }
    }

    // Deduplicate in JS if user has multiple roles
    const userMap = new Map();
    for (const u of (users || [])) {
      if (!userMap.has(u.id)) {
        userMap.set(u.id, {
          id: u.id,
          fullName: u.full_name,
          email: u.email,
          phone: u.phone || 'N/A',
          role: u.role || 'PLAYER',
          status: u.status || 'ACTIVE',
          createdAt: u.created_at,
          lastLoginAt: u.last_login_at || null
        });
      } else {
        const existing = userMap.get(u.id);
        if (u.role === 'SUPER_ADMIN' || (u.role === 'ADMIN' && existing.role !== 'SUPER_ADMIN')) {
          existing.role = u.role;
        }
      }
    }

    res.json({
      success: true,
      data: Array.from(userMap.values())
    });
  } catch (error) {
    console.error('getUsers fatal error:', error);
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
    let venues = [];
    try {
      venues = await db.query(
        `SELECT v.*, u.full_name as owner_name, u.email as owner_email 
         FROM venues v
         LEFT JOIN users u ON v.owner_id = u.id
         ORDER BY v.id DESC`
      );
    } catch (e) {
      console.warn('getVenues fallback to venues note:', e.message);
      venues = await db.query(`SELECT * FROM venues ORDER BY id DESC`).catch(() => []);
    }

    res.json({
      success: true,
      data: (venues || []).map(v => ({
        id: v.id,
        name: v.name,
        slug: v.slug,
        city: v.city,
        ownerName: v.owner_name || 'N/A',
        ownerEmail: v.owner_email || 'N/A',
        status: v.status || 'APPROVED',
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
  ensureLastLoginColumn,
  getAdminDashboardStats,
  getUsers,
  updateUserStatus,
  getVenues,
  updateVenueStatus
};
