const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { processAvatarImage } = require('../services/imageService');
const { checkUsernameAvailability, validateUsernameFormat } = require('../services/usernameService');
const statisticsAwardsService = require('../services/statisticsAwardsService');
const scorerAccessService = require('../services/scorerAccessService');
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
 * Get comprehensive profile of the currently logged-in user.
 * Tailored dynamically per role: Player, Turf Owner, Admin, Superadmin.
 */
async function getMyProfile(req, res, next) {
  try {
    const userId = req.user.id;

    // 1. Fetch user core record with role
    const users = await db.query(
      `SELECT u.*, r.name as role 
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE u.id = ?`,
      [userId]
    );

    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = users[0];

    // 2. Fetch player statistics, awards, teams, and match history
    let playerProfile = {};
    try {
      playerProfile = await statisticsAwardsService.getPlayerProfile(userId, req.user);
    } catch (e) {
      console.warn('Error fetching player profile stats:', e.message);
    }

    // 3. If VENUE_OWNER or ADMIN, fetch venues owned
    let venuesOwned = [];
    if (user.role === 'VENUE_OWNER' || user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      try {
        venuesOwned = await db.query(
          `SELECT v.id, v.name, v.address, v.city, v.state, v.pincode, v.status, v.created_at,
                  (SELECT COUNT(*) FROM courts c WHERE c.venue_id = v.id) as court_count,
                  (SELECT COUNT(*) FROM bookings b WHERE b.venue_id = v.id) as booking_count
           FROM venues v
           WHERE v.owner_id = ?
           ORDER BY v.id DESC`,
          [userId]
        );
      } catch (err) {
        console.warn('Error fetching venues owned:', err.message);
      }
    }

    // 4. Calculate Age if dob is provided
    let age = null;
    if (user.dob) {
      const diff = new Date() - new Date(user.dob);
      age = Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
    }

    // 5. Fetch Assigned Matches (Scoring & Streaming assignments)
    let assignedMatches = [];
    try {
      const streamPermissionService = require('../services/streamPermissionService');
      const [scoringMatches, streamingMatches] = await Promise.all([
        scorerAccessService.getUserScoringMatches(userId),
        streamPermissionService.getUserStreamingMatches(userId)
      ]);

      const matchMap = new Map();

      // Process Scoring Matches
      (scoringMatches || []).forEach(m => {
        const key = String(m.id);
        matchMap.set(key, {
          id: m.id,
          uuid: m.uuid,
          matchNumber: m.match_number,
          status: m.status,
          matchDate: m.match_date ? (typeof m.match_date === 'object' ? m.match_date.toISOString().split('T')[0] : String(m.match_date).split('T')[0]) : null,
          startTime: m.start_time,
          liveScoreSummary: m.live_score_summary,
          liveSubtext: m.live_subtext,
          category: m.category,
          tournamentId: m.tournament_id,
          tournamentUuid: m.tournament_uuid,
          tournamentName: m.tournament_name,
          sportSlug: m.sport_slug,
          sportName: m.sport_name,
          teamAName: m.team_a_name,
          teamALogo: m.team_a_logo,
          teamBName: m.team_b_name,
          teamBLogo: m.team_b_logo,
          venueName: m.venue_name,
          courtName: m.court_name,
          isAssignedScorer: true,
          isAssignedStreamer: false,
          roles: ['Scorer']
        });
      });

      // Process Streaming Matches
      (streamingMatches || []).forEach(m => {
        const key = String(m.id);
        if (matchMap.has(key)) {
          const existing = matchMap.get(key);
          existing.isAssignedStreamer = true;
          if (!existing.roles.includes('Live Streaming')) {
            existing.roles.push('Live Streaming');
          }
        } else {
          matchMap.set(key, {
            id: m.id,
            uuid: m.uuid,
            matchNumber: m.match_number,
            status: m.status,
            matchDate: m.match_date ? (typeof m.match_date === 'object' ? m.match_date.toISOString().split('T')[0] : String(m.match_date).split('T')[0]) : null,
            startTime: m.start_time,
            liveScoreSummary: m.live_score_summary,
            liveSubtext: m.live_subtext,
            category: m.category,
            tournamentId: m.tournament_id,
            tournamentUuid: m.tournament_uuid,
            tournamentName: m.tournament_name,
            sportSlug: m.sport_slug,
            sportName: m.sport_name,
            teamAName: m.team_a_name,
            teamALogo: m.team_a_logo,
            teamBName: m.team_b_name,
            teamBLogo: m.team_b_logo,
            venueName: m.venue_name,
            courtName: m.court_name,
            isAssignedScorer: false,
            isAssignedStreamer: true,
            roles: ['Live Streaming']
          });
        }
      });

      assignedMatches = Array.from(matchMap.values()).sort((a, b) => {
        // Sort LIVE first, then SCHEDULED by date/time, then COMPLETED
        const statusPriority = { LIVE: 1, SCHEDULED: 2, COMPLETED: 3 };
        const pA = statusPriority[a.status] || 4;
        const pB = statusPriority[b.status] || 4;
        if (pA !== pB) return pA - pB;
        if (a.matchDate && b.matchDate) {
          const cmp = a.matchDate.localeCompare(b.matchDate);
          if (cmp !== 0) return cmp;
        }
        return (a.startTime || '').localeCompare(b.startTime || '');
      });
    } catch (err) {
      console.warn('Error fetching assigned matches:', err.message);
    }

    // Assemble comprehensive authenticated profile
    const fullProfile = {
      id: user.id,
      fullName: user.full_name,
      username: user.username || `user_${user.id}`,
      email: user.email,
      phone: user.phone || null,
      profilePhoto: user.profile_photo || null,
      role: user.role || 'PLAYER',
      status: user.status || 'ACTIVE',
      memberSince: user.created_at,
      updatedAt: user.updated_at,
      dob: user.dob ? user.dob.toISOString().split('T')[0] : null,
      age,
      gender: user.gender || 'Not Specified',
      city: user.city || null,
      state: user.state || null,
      country: user.country || 'India',
      address: user.address || null,
      postalCode: user.postal_code || null,
      emergencyContactName: user.emergency_contact_name || null,
      emergencyContactPhone: user.emergency_contact_phone || null,
      
      // Player Details
      primarySportSlug: user.primary_sport_slug || 'cricket',
      primaryPosition: user.primary_position || null,
      jerseyNumber: user.jersey_number || null,
      battingStyle: user.batting_style || null,
      bowlingStyle: user.bowling_style || null,
      preferredHandFoot: user.preferred_hand_foot || null,
      experienceLevel: user.experience_level || 'Club',
      skillCategory: user.skill_category || 'Amateur',
      
      // Dynamic Stats, Teams, Awards
      careerStats: playerProfile.careerStats || {},
      teams: playerProfile.teams || [],
      awardsWon: playerProfile.awardsWon || [],
      matchHistory: playerProfile.matchHistory || [],
      
      // Turf Owner Details
      venuesOwned: venuesOwned || [],
      totalVenuesCount: venuesOwned.length,
      totalCourtsCount: venuesOwned.reduce((sum, v) => sum + (parseInt(v.court_count) || 0), 0),

      // Assigned Matches (Scorer & Streamer tasks)
      assignedMatches,
      assignedMatchesCount: assignedMatches.length,
      hasActiveAssignments: assignedMatches.some(m => m.status === 'LIVE' || m.status === 'SCHEDULED')
    };

    res.json({
      success: true,
      data: fullProfile
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Update user profile details including unique username, phone, and sports attributes.
 */
async function updateProfile(req, res, next) {
  try {
    const userId = req.user.id;
    const {
      fullName,
      username,
      phone,
      city,
      state,
      country,
      address,
      postalCode,
      emergencyContactName,
      emergencyContactPhone,
      dob,
      gender,
      primarySportSlug,
      battingStyle,
      bowlingStyle,
      jerseyNumber,
      primaryPosition,
      preferredHandFoot,
      experienceLevel,
      skillCategory
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

    if (phone !== undefined) {
      updates.push('phone = ?');
      params.push(phone && phone.trim() ? phone.trim() : null);
    }
    if (city !== undefined) {
      updates.push('city = ?');
      params.push(city ? city.trim() : null);
    }
    if (state !== undefined) {
      updates.push('state = ?');
      params.push(state ? state.trim() : null);
    }
    if (country !== undefined) {
      updates.push('country = ?');
      params.push(country ? country.trim() : null);
    }
    if (address !== undefined) {
      updates.push('address = ?');
      params.push(address ? address.trim() : null);
    }
    if (postalCode !== undefined) {
      updates.push('postal_code = ?');
      params.push(postalCode ? postalCode.trim() : null);
    }
    if (emergencyContactName !== undefined) {
      updates.push('emergency_contact_name = ?');
      params.push(emergencyContactName ? emergencyContactName.trim() : null);
    }
    if (emergencyContactPhone !== undefined) {
      updates.push('emergency_contact_phone = ?');
      params.push(emergencyContactPhone ? emergencyContactPhone.trim() : null);
    }
    if (dob !== undefined) {
      updates.push('dob = ?');
      params.push(dob || null);
    }
    if (gender !== undefined) {
      updates.push('gender = ?');
      params.push(gender || null);
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
    if (preferredHandFoot !== undefined) {
      updates.push('preferred_hand_foot = ?');
      params.push(preferredHandFoot);
    }
    if (experienceLevel !== undefined) {
      updates.push('experience_level = ?');
      params.push(experienceLevel);
    }
    if (skillCategory !== undefined) {
      updates.push('skill_category = ?');
      params.push(skillCategory);
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'No fields provided to update.' });
    }

    params.push(userId);
    await db.query(`UPDATE users SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

    const updatedUsers = await db.query(
      `SELECT u.*, r.name as role
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
        country: u.country,
        address: u.address,
        postalCode: u.postal_code,
        emergencyContactName: u.emergency_contact_name,
        emergencyContactPhone: u.emergency_contact_phone,
        dob: u.dob ? u.dob.toISOString().split('T')[0] : null,
        gender: u.gender,
        primarySportSlug: u.primary_sport_slug,
        primaryPosition: u.primary_position,
        jerseyNumber: u.jersey_number,
        battingStyle: u.batting_style,
        bowlingStyle: u.bowling_style,
        preferredHandFoot: u.preferred_hand_foot,
        experienceLevel: u.experience_level,
        skillCategory: u.skill_category,
        role: u.role
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Secure Password Change with current password verification.
 */
async function changePassword(req, res, next) {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long.' });
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'New password and confirmation do not match.' });
    }

    const [user] = await db.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
    }

    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    await db.query('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newHash, userId]);

    res.json({
      success: true,
      message: 'Password changed successfully!'
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
  getMyProfile,
  uploadProfilePhoto,
  removeProfilePhoto,
  updateProfile,
  changePassword,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead
};
