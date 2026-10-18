const jwt = require('jsonwebtoken');
const db = require('../config/database');

const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please login.'
      });
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
    
    const decoded = jwt.verify(token, secret);

    // Ensure user has not been deactivated, soft-deleted or permanently deleted
    const users = await db.query('SELECT status, deletion_status, deleted_at FROM users WHERE id = ?', [decoded.id]);
    if (!users || users.length === 0 || users[0].status !== 'ACTIVE' || users[0].deletion_status === 'SOFT_DELETED' || users[0].deletion_status === 'PERMANENTLY_DELETED' || users[0].deleted_at) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated or scheduled for deletion.'
      });
    }

    req.user = decoded; // { id, email, role, full_name }
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired session token. Please login again.'
    });
  }
};

const optionalAuthenticateUser = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
      const decoded = jwt.verify(token, secret);
      req.user = decoded;
    }
  } catch (error) {
    // Ignore invalid tokens for optional auth
  }
  next();
};

module.exports = {
  authenticateUser,
  optionalAuthenticateUser
};
