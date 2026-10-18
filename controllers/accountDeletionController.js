const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

/**
 * Audit helper: Records actions in account_deletion_audits without exposing secrets.
 */
async function recordDeletionAudit({ userId, userIdentifier, requestedAt, executedBy, actionType, details }) {
  try {
    const detailsStr = details ? JSON.stringify(details) : null;
    await db.query(`
      INSERT INTO account_deletion_audits (user_id, user_identifier, requested_at, executed_by, action_type, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [userId || null, userIdentifier, requestedAt || new Date(), executedBy || null, actionType, detailsStr]);
  } catch (err) {
    console.error('Failed to write deletion audit record:', err.message);
  }
}

/**
 * 1. Public Account Deletion Request (Google Play Compliance)
 * Allows non-logged-in users (or uninstalled app users) to verify identity and trigger soft-delete.
 */
async function publicDeletionRequest(req, res, next) {
  try {
    const { identifier, password, reason } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Account identifier (email or username) and password are required.'
      });
    }

    const cleanId = String(identifier).trim().toLowerCase();

    // Find user by email or username
    const users = await db.query(`
      SELECT u.id, u.full_name, u.username, u.email, u.password_hash, u.status, u.deletion_status, r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE LOWER(u.email) = ? OR LOWER(u.username) = ?
    `, [cleanId, cleanId]);

    // Anti-enumeration: Return generic message on failure
    if (users.length === 0) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please verify your email or username and password.'
      });
    }

    const targetUser = users[0];

    // Verify password
    const isMatch = await bcrypt.compare(password, targetUser.password_hash);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials. Please verify your email or username and password.'
      });
    }

    // Check if already permanently deleted
    if (targetUser.deletion_status === 'PERMANENTLY_DELETED') {
      return res.status(400).json({
        success: false,
        message: 'This account has already been permanently deleted.'
      });
    }

    // Safeguard: Check if this user is the only active Super Admin
    if (targetUser.role === 'ADMIN') {
      const activeAdmins = await db.query(`
        SELECT COUNT(u.id) as total 
        FROM users u 
        JOIN user_roles ur ON u.id = ur.user_id 
        JOIN roles r ON ur.role_id = r.id 
        WHERE r.name = 'ADMIN' AND u.status = 'ACTIVE' AND (u.deletion_status IS NULL OR u.deletion_status = 'ACTIVE')
      `);
      if (activeAdmins[0]?.total <= 1) {
        return res.status(403).json({
          success: false,
          message: 'Cannot delete account: This user is the sole active Super Admin on the platform. Please transfer Super Admin rights before deleting.'
        });
      }
    }

    // Execute soft delete: 30 day grace period
    const cleanReason = reason ? String(reason).slice(0, 500) : 'User submitted via public web deletion page';
    await db.query(`
      UPDATE users 
      SET status = 'DELETED', 
          deletion_status = 'SOFT_DELETED', 
          deletion_requested_at = NOW(),
          deleted_at = NOW(), 
          scheduled_permanent_deletion_at = DATE_ADD(NOW(), INTERVAL 30 DAY),
          deletion_reason = ?
      WHERE id = ?
    `, [cleanReason, targetUser.id]);

    await recordDeletionAudit({
      userId: targetUser.id,
      userIdentifier: targetUser.email || targetUser.username,
      requestedAt: new Date(),
      executedBy: targetUser.id,
      actionType: 'SOFT_DELETE',
      details: { channel: 'PUBLIC_WEB_PAGE', reason: cleanReason }
    });

    res.json({
      success: true,
      message: 'Your account deletion request has been received. Your account is deactivated, and the request will be handled according to our published data retention and deletion policy.',
      data: {
        deletionStatus: 'SOFT_DELETED',
        scheduledPermanentDeletionAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 2. Authenticated Self Soft Delete
 */
async function requestSelfDeletion(req, res, next) {
  try {
    const userId = req.user.id;
    const { reason, password } = req.body;

    const users = await db.query(`
      SELECT u.id, u.email, u.username, u.password_hash, u.status, u.deletion_status, r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User account not found.' });
    }

    const user = users[0];

    // If password provided, verify it
    if (password) {
      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        return res.status(401).json({ success: false, message: 'Incorrect password provided.' });
      }
    }

    // Safeguard: Check if this user is the only active Super Admin
    if (user.role === 'ADMIN') {
      const activeAdmins = await db.query(`
        SELECT COUNT(u.id) as total 
        FROM users u 
        JOIN user_roles ur ON u.id = ur.user_id 
        JOIN roles r ON ur.role_id = r.id 
        WHERE r.name = 'ADMIN' AND u.status = 'ACTIVE' AND (u.deletion_status IS NULL OR u.deletion_status = 'ACTIVE')
      `);
      if (activeAdmins[0]?.total <= 1) {
        return res.status(403).json({
          success: false,
          message: 'Cannot delete account: You are the sole active Super Admin on this platform. Please transfer administrative ownership to another user before requesting deletion.'
        });
      }
    }

    const cleanReason = reason ? String(reason).slice(0, 500) : 'Self-service deletion requested by user';

    await db.query(`
      UPDATE users 
      SET status = 'DELETED', 
          deletion_status = 'SOFT_DELETED', 
          deletion_requested_at = NOW(),
          deleted_at = NOW(), 
          scheduled_permanent_deletion_at = DATE_ADD(NOW(), INTERVAL 30 DAY),
          deletion_reason = ?
      WHERE id = ?
    `, [cleanReason, userId]);

    await recordDeletionAudit({
      userId: user.id,
      userIdentifier: user.email || user.username,
      requestedAt: new Date(),
      executedBy: userId,
      actionType: 'SOFT_DELETE',
      details: { channel: 'SELF_SERVICE', reason: cleanReason }
    });

    res.json({
      success: true,
      message: 'Your account deletion request has been received. Your account is deactivated, and the request will be handled according to our published data retention and deletion policy.',
      data: {
        deletionStatus: 'SOFT_DELETED',
        scheduledPermanentDeletionAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 3. Authenticated User Deletion Status
 */
async function getSelfDeletionStatus(req, res, next) {
  try {
    const userId = req.user.id;
    const users = await db.query(`
      SELECT id, status, deletion_status, deletion_requested_at, deleted_at, scheduled_permanent_deletion_at, deletion_reason
      FROM users WHERE id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const u = users[0];
    res.json({
      success: true,
      data: {
        status: u.status,
        deletionStatus: u.deletion_status || 'ACTIVE',
        deletionRequestedAt: u.deletion_requested_at,
        deletedAt: u.deleted_at,
        scheduledPermanentDeletionAt: u.scheduled_permanent_deletion_at,
        deletionReason: u.deletion_reason
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 4. Super Admin: List & Filter Deletion Requests
 */
async function getAdminDeletionRequests(req, res, next) {
  try {
    const { status = 'ALL', search = '', page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    let whereConditions = [];
    let params = [];

    if (status !== 'ALL') {
      whereConditions.push('u.deletion_status = ?');
      params.push(status);
    } else {
      // Show pending or soft-deleted or permanently deleted by default, or all
      whereConditions.push("u.deletion_status IN ('PENDING_DELETION', 'SOFT_DELETED', 'PERMANENTLY_DELETED')");
    }

    if (search && search.trim()) {
      const term = `%${search.trim().toLowerCase()}%`;
      whereConditions.push('(LOWER(u.username) LIKE ? OR LOWER(u.full_name) LIKE ? OR LOWER(u.email) LIKE ? OR CAST(u.id AS CHAR) = ?)');
      params.push(term, term, term, search.trim());
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Count
    const countSql = `SELECT COUNT(u.id) as total FROM users u ${whereClause}`;
    const countRes = await db.query(countSql, params);
    const totalCount = countRes[0]?.total || 0;

    // Rows
    const dataSql = `
      SELECT u.id, u.full_name, u.username, u.email, u.phone, u.status, 
             u.deletion_status, u.deletion_requested_at, u.deleted_at, 
             u.scheduled_permanent_deletion_at, u.deletion_reason, u.created_at,
             r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      ${whereClause}
      ORDER BY 
        CASE 
          WHEN u.deletion_status = 'SOFT_DELETED' THEN 1
          WHEN u.deletion_status = 'PENDING_DELETION' THEN 2
          ELSE 3
        END,
        u.deleted_at DESC, u.id DESC
      LIMIT ? OFFSET ?
    `;

    const queryParams = [...params, limitNum, offset];
    const rows = await db.query(dataSql, queryParams);

    const formatted = rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      username: r.username,
      email: r.email,
      phone: r.phone ? `${r.phone.slice(0, 3)}****${r.phone.slice(-3)}` : null, // Masked phone for privacy
      role: r.role || 'PLAYER',
      status: r.status,
      deletionStatus: r.deletion_status || 'ACTIVE',
      deletionRequestedAt: r.deletion_requested_at,
      deletedAt: r.deleted_at,
      scheduledPermanentDeletionAt: r.scheduled_permanent_deletion_at,
      deletionReason: r.deletion_reason,
      createdAt: r.created_at
    }));

    res.json({
      success: true,
      data: {
        users: formatted,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limitNum)
        }
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 5. Super Admin: View Single Deletion Request Details
 */
async function getAdminDeletionRequestDetails(req, res, next) {
  try {
    const { userId } = req.params;

    const users = await db.query(`
      SELECT u.id, u.full_name, u.username, u.email, u.phone, u.status, 
             u.deletion_status, u.deletion_requested_at, u.deleted_at, 
             u.scheduled_permanent_deletion_at, u.deletion_reason, u.created_at,
             r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const u = users[0];

    // Fetch related audit records
    const audits = await db.query(`
      SELECT a.*, admin_u.full_name as executed_by_name
      FROM account_deletion_audits a
      LEFT JOIN users admin_u ON a.executed_by = admin_u.id
      WHERE a.user_id = ?
      ORDER BY a.created_at DESC
    `, [userId]);

    res.json({
      success: true,
      data: {
        user: {
          id: u.id,
          fullName: u.full_name,
          username: u.username,
          email: u.email,
          role: u.role || 'PLAYER',
          status: u.status,
          deletionStatus: u.deletion_status || 'ACTIVE',
          deletionRequestedAt: u.deletion_requested_at,
          deletedAt: u.deleted_at,
          scheduledPermanentDeletionAt: u.scheduled_permanent_deletion_at,
          deletionReason: u.deletion_reason,
          createdAt: u.created_at
        },
        audits: audits.map(a => ({
          id: a.id,
          actionType: a.action_type,
          requestedAt: a.requested_at,
          createdAt: a.created_at,
          executedByName: a.executed_by_name || 'System / User',
          details: a.details ? JSON.parse(a.details) : null
        }))
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 6. Super Admin: Restore Soft-Deleted Account
 */
async function restoreAccount(req, res, next) {
  try {
    const { userId } = req.params;

    const users = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];
    if (user.deletion_status === 'PERMANENTLY_DELETED') {
      return res.status(400).json({
        success: false,
        message: 'Cannot restore: This account has already been permanently deleted and anonymized.'
      });
    }

    await db.query(`
      UPDATE users
      SET status = 'ACTIVE',
          deletion_status = 'ACTIVE',
          deleted_at = NULL,
          deletion_requested_at = NULL,
          scheduled_permanent_deletion_at = NULL,
          deletion_reason = NULL
      WHERE id = ?
    `, [userId]);

    await recordDeletionAudit({
      userId: user.id,
      userIdentifier: user.email || user.username,
      requestedAt: new Date(),
      executedBy: req.user.id,
      actionType: 'RESTORE',
      details: { restoredByAdminId: req.user.id }
    });

    res.json({
      success: true,
      message: `Account for @${user.username} has been restored to ACTIVE status.`
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 7. Super Admin: Permanently Delete Account (Irreversible, Super Admin Only)
 */
async function permanentDeleteAccount(req, res, next) {
  try {
    const { userId } = req.params;
    const { confirmPhrase, reason } = req.body;

    // Strict phrase confirmation
    if (confirmPhrase !== 'DELETE PERMANENTLY') {
      return res.status(400).json({
        success: false,
        message: 'Confirmation phrase mismatch. Please enter "DELETE PERMANENTLY" to confirm irreversible permanent deletion.'
      });
    }

    const users = await db.query(`
      SELECT u.*, r.name as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.id = ?
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const targetUser = users[0];

    // Safeguard: Cannot permanently delete the sole active Super Admin
    if (targetUser.role === 'ADMIN') {
      const activeAdmins = await db.query(`
        SELECT COUNT(u.id) as total 
        FROM users u 
        JOIN user_roles ur ON u.id = ur.user_id 
        JOIN roles r ON ur.role_id = r.id 
        WHERE r.name = 'ADMIN' AND u.status = 'ACTIVE' AND (u.deletion_status IS NULL OR u.deletion_status = 'ACTIVE')
      `);
      if (activeAdmins[0]?.total <= 1) {
        return res.status(403).json({
          success: false,
          message: 'Security safeguard: Cannot delete the sole active Super Admin on this platform.'
        });
      }
    }

    // Try to remove avatar file from disk if exists
    if (targetUser.profile_photo) {
      try {
        const photoPath = path.join(__dirname, '..', targetUser.profile_photo.replace(/^\//, ''));
        if (fs.existsSync(photoPath)) {
          fs.unlinkSync(photoPath);
        }
      } catch (fileErr) {
        console.warn('Avatar deletion cleanup note:', fileErr.message);
      }
    }

    // Irreversible PII scrubbing & anonymization to preserve relational integrity with matches, tournaments, bookings
    const anonymizedUsername = `deleted_user_${targetUser.id}`;
    const anonymizedEmail = `deleted_${targetUser.id}@deleted.turfspot.local`;
    const invalidHash = '$2a$10$PERMANENTLY_DELETED_ACCOUNT_SECURITY_DUMMY_HASH';

    await db.query(`
      UPDATE users
      SET full_name = 'Deleted User',
          username = ?,
          email = ?,
          phone = NULL,
          password_hash = ?,
          profile_photo = NULL,
          dob = NULL,
          gender = NULL,
          city = NULL,
          state = NULL,
          country = NULL,
          address = NULL,
          postal_code = NULL,
          emergency_contact_name = NULL,
          emergency_contact_phone = NULL,
          status = 'DELETED',
          deletion_status = 'PERMANENTLY_DELETED',
          deleted_at = NOW(),
          scheduled_permanent_deletion_at = NULL,
          deletion_reason = ?
      WHERE id = ?
    `, [anonymizedUsername, anonymizedEmail, invalidHash, reason || 'Super Admin permanent deletion executed', targetUser.id]);

    await recordDeletionAudit({
      userId: targetUser.id,
      userIdentifier: `[DELETED] id:${targetUser.id}`,
      requestedAt: targetUser.deletion_requested_at || new Date(),
      executedBy: req.user.id,
      actionType: 'PERMANENT_DELETE',
      details: {
        executedByAdminId: req.user.id,
        reason: reason || 'Permanent deletion executed by Super Admin',
        originalRole: targetUser.role
      }
    });

    res.json({
      success: true,
      message: `Account ID ${targetUser.id} has been permanently deleted and personal data scrubbed/anonymized. Tournament and match scores remain intact.`
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 8. Super Admin: Get Deletion Audits Log
 */
async function getAdminDeletionAudits(req, res, next) {
  try {
    const audits = await db.query(`
      SELECT a.id, a.user_id, a.user_identifier, a.requested_at, a.executed_by, a.action_type, a.details, a.created_at,
             admin_u.full_name as executed_by_name
      FROM account_deletion_audits a
      LEFT JOIN users admin_u ON a.executed_by = admin_u.id
      ORDER BY a.id DESC
      LIMIT 100
    `);

    const formatted = audits.map(a => ({
      id: a.id,
      userId: a.user_id,
      userIdentifier: a.user_identifier,
      actionType: a.action_type,
      requestedAt: a.requested_at,
      createdAt: a.created_at,
      executedByName: a.executed_by_name || 'System / User',
      details: a.details ? JSON.parse(a.details) : null
    }));

    res.json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  publicDeletionRequest,
  requestSelfDeletion,
  getSelfDeletionStatus,
  getAdminDeletionRequests,
  getAdminDeletionRequestDetails,
  restoreAccount,
  permanentDeleteAccount,
  getAdminDeletionAudits
};
