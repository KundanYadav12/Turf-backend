const jwt = require('jsonwebtoken');
const db = require('../config/database');

/**
 * Universal token extractor supporting headers, cookies, and query params
 */
const extractToken = (req) => {
  // 1. Authorization header (Bearer or raw)
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && typeof authHeader === 'string') {
    if (authHeader.startsWith('Bearer ')) {
      const t = authHeader.slice(7).trim();
      if (t && t !== 'null' && t !== 'undefined') return t;
    } else {
      const t = authHeader.trim();
      if (t && t !== 'null' && t !== 'undefined') return t;
    }
  }

  // 2. Custom header aliases
  const xToken = req.headers['x-access-token'] || req.headers['x-auth-token'];
  if (xToken && typeof xToken === 'string' && xToken !== 'null' && xToken !== 'undefined') {
    return xToken.trim();
  }

  // 3. Cookie store (if cookie-parser is installed/used)
  if (req.cookies) {
    const cToken = req.cookies.turf_token || req.cookies.token;
    if (cToken && typeof cToken === 'string' && cToken !== 'null' && cToken !== 'undefined') {
      return cToken.trim();
    }
  }

  // 4. Query parameter (useful for TV displays, direct downloads, or websockets)
  if (req.query && req.query.token && typeof req.query.token === 'string') {
    const qToken = req.query.token.trim();
    if (qToken && qToken !== 'null' && qToken !== 'undefined') {
      return qToken;
    }
  }

  return null;
};

const authenticateUser = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please login.',
        code: 'AUTH_REQUIRED'
      });
    }

    const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
    let decoded;

    try {
      decoded = jwt.verify(token, secret);
    } catch (jwtErr) {
      const isExpired = jwtErr.name === 'TokenExpiredError';
      return res.status(401).json({
        success: false,
        message: isExpired
          ? 'Authentication session expired. Please login again.'
          : 'Invalid or malformed session token. Please login again.',
        code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'
      });
    }

    // Ensure user exists and has not been deactivated, soft-deleted or permanently deleted
    const users = await db.query(
      'SELECT id, email, full_name, status, deletion_status, deleted_at FROM users WHERE id = ?',
      [decoded.id]
    );

    if (
      !users ||
      users.length === 0 ||
      users[0].status !== 'ACTIVE' ||
      users[0].deletion_status === 'SOFT_DELETED' ||
      users[0].deletion_status === 'PERMANENTLY_DELETED' ||
      users[0].deleted_at
    ) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated or scheduled for deletion.',
        code: 'ACCOUNT_DEACTIVATED'
      });
    }

    // Fetch primary role from user_roles if not already populated or if updated
    if (!decoded.role) {
      const userRoles = await db.query(
        'SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = ? LIMIT 1',
        [decoded.id]
      );
      if (userRoles.length > 0) {
        decoded.role = userRoles[0].name;
      }
    }

    req.user = decoded; // { id, email, role, full_name }
    next();
  } catch (error) {
    console.error('[authenticateUser] Unexpected error:', error);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed. Please login again.',
      code: 'AUTH_FAILED'
    });
  }
};

const optionalAuthenticateUser = (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
      const decoded = jwt.verify(token, secret);
      req.user = decoded;
    }
  } catch (error) {
    // Ignore invalid or expired tokens for optional auth without failing
  }
  next();
};

module.exports = {
  extractToken,
  authenticateUser,
  optionalAuthenticateUser
};
