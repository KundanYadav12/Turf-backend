const db = require('../config/database');
const { processAvatarImage } = require('../services/imageService');
const { checkUsernameAvailability, validateUsernameFormat } = require('../services/usernameService');
const {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead
} = require('../services/notificationService');

/**
 * Real-time username check with alternatives.
 */
async function checkUsername(req, res, next) {
  try {
    const { username } = req.query;
    if (!username) {
      return res.status(400).json({ success: false, message: 'username query parameter is required.' });
    }
    const excludeUserId = req.user ? req.user.id : null;
    const result = await checkUsernameAvailability(username, excludeUserId);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Search registered players/users by name, username, or phone.
 * Strict privacy: zero exposure of private phone numbers or residential addresses.
 */
async function searchUsers(req, res, next) {
  try {
    const { q = '', limit = 15 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);

    if (!q || q.trim().length < 2) {
      return res.json({ success: true, data: [] });
    }

    const cleanQ = q.trim();
    const isPhoneQuery = /^\+?[0-9]{5,15}$/.test(cleanQ);

    let sql = `
      SELECT 
        u.id, 
        u.full_name, 
        u.username, 
        u.profile_photo, 
        u.city, 
        u.primary_sport_slug, 
        u.primary_position,
        u.jersey_number,
        MAX(r.name) as role
      FROM users u
      LEFT JOIN user_roles ur ON u.id = ur.user_id
      LEFT JOIN roles r ON ur.role_id = r.id
      WHERE u.status = 'ACTIVE' 
        AND (u.deletion_status IS NULL OR u.deletion_status = 'ACTIVE') 
        AND u.deleted_at IS NULL 
        AND (
        LOWER(u.username) LIKE ? 
        OR LOWER(u.full_name) LIKE ?
        ${isPhoneQuery ? 'OR u.phone = ?' : ''}
      )
      GROUP BY u.id
      ORDER BY 
        CASE 
          WHEN LOWER(u.username) = ? THEN 1
          WHEN LOWER(u.username) LIKE ? THEN 2
          ELSE 3
        END,
        u.id DESC
      LIMIT ?
    `;

    const term = `%${cleanQ.toLowerCase()}%`;
    const exact = cleanQ.toLowerCase();
    const params = [term, term];
    if (isPhoneQuery) params.push(cleanQ);
    params.push(exact, `${exact}%`, safeLimit);

    const rows = await db.query(sql, params);

    const formatted = rows.map(r => ({
      id: r.id,
      fullName: r.full_name,
      username: r.username || `user_${r.id}`,
      profilePhoto: r.profile_photo || null,
      city: r.city || null,
      primarySport: r.primary_sport_slug || 'cricket',
      primaryPosition: r.primary_position || null,
      jerseyNumber: r.jersey_number || null,
      role: r.role || 'PLAYER'
    }));

    res.json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Upload and optimize profile photo:
 * - Compresses to WebP (512x512)
 * - Generates 128x128 thumbnail
 * - Updates users.profile_photo
 */
async function uploadProfilePhoto(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload an image file.' });
    }

    const userId = req.user.id;
    const processed = await processAvatarImage(req.file.path, `avatar-u${userId}-${Date.now()}`);

    // Update user record with optimized webp url
    await db.query(
      'UPDATE users SET profile_photo = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [processed.url, userId]
    );

    res.json({
      success: true,
      message: 'Profile photo uploaded and optimized successfully!',
      data: {
        profilePhoto: processed.url,
        thumbnailUrl: processed.thumbnailUrl,
        format: processed.format,
        sizeBytes: processed.sizeBytes
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Remove profile photo and reset to default avatar.
 */
async function removeProfilePhoto(req, res, next) {
  try {
    const userId = req.user.id;
    await db.query(
      'UPDATE users SET profile_photo = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [userId]
    );

    res.json({
      success: true,
      message: 'Profile photo removed. Default avatar will be displayed.',
      data: {
        profilePhoto: null
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update user profile details including unique username.
 */
async function updateProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const {
      fullName,
      username,
      city,
      state,
      primarySportSlug,
      battingStyle,
      bowlingStyle,
      jerseyNumber,
      primaryPosition
    } = req.body;

    const updates = [];
    const params = [];

    if (fullName && fullName.trim()) {
      updates.push('full_name = ?');
      params.push(fullName.trim());
    }

    if (username !== undefined) {
      const check = await checkUsernameAvailability(username, userId);
      if (!check.valid) {
        return res.status(400).json({ success: false, message: check.reason });
      }
      if (!check.available) {
        return res.status(409).json({
          success: false,
          message: 'This username is already taken. Please choose another username.',
          suggestions: check.suggestions
        });
      }
      updates.push('username = ?');
      params.push(check.normalized);
    }

    if (city !== undefined) {
      updates.push('city = ?');
      params.push(city);
    }
    if (state !== undefined) {
      updates.push('state = ?');
      params.push(state);
    }
    if (primarySportSlug !== undefined) {
      updates.push('primary_sport_slug = ?');
      params.push(primarySportSlug);
    }
    if (battingStyle !== undefined) {
      updates.push('batting_style = ?');
      params.push(battingStyle);
    }
    if (bowlingStyle !== undefined) {
      updates.push('bowling_style = ?');
      params.push(bowlingStyle);
    }
    if (jerseyNumber !== undefined) {
      updates.push('jersey_number = ?');
      params.push(parseInt(jerseyNumber, 10) || null);
    }
    if (primaryPosition !== undefined) {
      updates.push('primary_position = ?');
      params.push(primaryPosition);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields provided to update.' });
    }

    params.push(userId);
    await db.query(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

    const updatedUsers = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.phone, u.profile_photo, u.city, u.state, u.primary_sport_slug, r.name as role
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = ?`,
      [userId]
    );

    const u = updatedUsers[0];
    res.json({
      success: true,
      message: 'Profile updated successfully!',
      data: {
        id: u.id,
        fullName: u.full_name,
        username: u.username,
        email: u.email,
        phone: u.phone,
        profilePhoto: u.profile_photo,
        city: u.city,
        state: u.state,
        primarySport: u.primary_sport_slug,
        role: u.role
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Get in-app notifications.
 */
async function getNotifications(req, res, next) {
  try {
    const { limit, offset, unreadOnly } = req.query;
    const result = await getUserNotifications(req.user.id, {
      limit,
      offset,
      unreadOnly: unreadOnly === 'true' || unreadOnly === '1'
    });
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Mark notification as read.
 */
async function markNotificationRead(req, res, next) {
  try {
    const { id } = req.params;
    await markNotificationAsRead(id, req.user.id);
    res.json({ success: true, message: 'Notification marked as read.' });
  } catch (error) {
    next(error);
  }
}

/**
 * Mark all notifications as read.
 */
async function markAllNotificationsRead(req, res, next) {
  try {
    await markAllNotificationsAsRead(req.user.id);
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  checkUsername,
  searchUsers,
  uploadProfilePhoto,
  removeProfilePhoto,
  updateProfile,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead
};
