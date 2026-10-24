const crypto = require('crypto');
const db = require('../config/database');
const { getIO } = require('./socketService');

/**
 * Search registered users by name, email, or phone for streaming delegation
 */
async function searchUsers(query) {
  if (!query || String(query).trim().length < 2) return [];
  const searchTerm = `%${String(query).trim()}%`;
  const rows = await db.query(
    `SELECT u.id, u.full_name, u.email, u.phone, u.profile_photo as avatar_url, r.name as role
     FROM users u
     LEFT JOIN user_roles ur ON u.id = ur.user_id
     LEFT JOIN roles r ON ur.role_id = r.id
     WHERE (u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)
     LIMIT 15`,
    [searchTerm, searchTerm, searchTerm]
  );
  return rows;
}

/**
 * Helper to fetch authoritative tournament record
 */
async function getAuthoritativeTournament(tournamentPublicOrInternalId) {
  const isNum = /^\d+$/.test(String(tournamentPublicOrInternalId).trim());
  const rows = await db.query(
    `SELECT t.id, t.uuid, t.name, t.created_by, t.sport_id, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [String(tournamentPublicOrInternalId), isNum ? parseInt(tournamentPublicOrInternalId, 10) : -1]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Authoritative check if user is Creator / Owner or Superadmin
 */
function isTournamentOwnerOrAdmin(user, tournament) {
  if (!user || !user.id || !tournament) return false;
  const role = String(user.role || '').toUpperCase();
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') return true;

  const userId = Number(user.id);
  if (tournament.created_by && Number(tournament.created_by) === userId) return true;
  if (tournament.venue_owner_id && Number(tournament.venue_owner_id) === userId) return true;

  return false;
}

/**
 * Authoritatively check if a user has active streaming permission for a tournament/match
 */
async function checkUserStreamPermission(userId, tournamentId, matchId = null) {
  if (!userId) {
    return { hasPermission: false, reason: 'UNAUTHENTICATED' };
  }

  const tournament = await getAuthoritativeTournament(tournamentId);
  if (!tournament) {
    return { hasPermission: false, reason: 'TOURNAMENT_NOT_FOUND' };
  }

  // 1 & 2. Check Superadmin and Tournament Creator / Venue Owner
  const uid = Number(userId);
  const [userRow] = await db.query(
    `SELECT u.id, r.name as role_name 
     FROM users u 
     LEFT JOIN user_roles ur ON u.id = ur.user_id 
     LEFT JOIN roles r ON ur.role_id = r.id 
     WHERE u.id = ?`,
    [uid]
  );
  const roleName = String(userRow?.role_name || '').toUpperCase();
  const isSuperAdmin = roleName === 'ADMIN' || roleName === 'SUPER_ADMIN';
  const isCreator = Boolean(
    (tournament.created_by && Number(tournament.created_by) === uid) ||
    (tournament.venue_owner_id && Number(tournament.venue_owner_id) === uid)
  );

  if (isSuperAdmin || isCreator) {
    return {
      hasPermission: true,
      role: isSuperAdmin ? 'SUPER_ADMIN' : 'CREATOR',
      scope: 'ALL',
      isSuperAdmin,
      isCreator,
      isDelegated: false,
      tournament
    };
  }

  // 3. Check Delegated Active Permission in tournament_stream_permissions
  let resolvedMatchId = null;
  if (matchId) {
    const isNum = /^\d+$/.test(String(matchId).trim());
    const [m] = await db.query(
      `SELECT id, tournament_id FROM tournament_matches WHERE (uuid = ? OR id = ?) AND tournament_id = ?`,
      [String(matchId), isNum ? parseInt(matchId, 10) : -1, tournament.id]
    );
    if (m) resolvedMatchId = m.id;
  }

  // Match can match specific matchId OR tournament-wide (match_id IS NULL)
  const rows = await db.query(
    `SELECT tsp.*, u.full_name as granter_name
     FROM tournament_stream_permissions tsp
     LEFT JOIN users u ON tsp.granted_by = u.id
     WHERE tsp.tournament_id = ? 
       AND tsp.user_id = ? 
       AND tsp.status = 'ACTIVE'
       AND (tsp.expires_at IS NULL OR tsp.expires_at > NOW())
       AND (tsp.match_id IS NULL ${resolvedMatchId ? 'OR tsp.match_id = ?' : ''})
     ORDER BY tsp.id DESC
     LIMIT 1`,
    resolvedMatchId ? [tournament.id, uid, resolvedMatchId] : [tournament.id, uid]
  );

  if (rows && rows.length > 0) {
    const perm = rows[0];
    return {
      hasPermission: true,
      role: 'DELEGATED_STREAMER',
      scope: perm.scope,
      matchId: perm.match_id,
      isSuperAdmin: false,
      isCreator: false,
      isDelegated: true,
      permission: perm,
      tournament
    };
  }

  return {
    hasPermission: false,
    reason: 'NO_STREAMING_PERMISSION',
    isSuperAdmin: false,
    isCreator: false,
    isDelegated: false,
    tournament
  };
}

/**
 * Get all streaming permissions for a tournament (Admin / Creator view)
 */
async function getTournamentStreamPermissions(tournamentId, user = null) {
  const tournament = await getAuthoritativeTournament(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  const isOwnerOrAdmin = isTournamentOwnerOrAdmin(user, tournament);
  const currentUserId = user?.id ? Number(user.id) : null;

  // If not owner/admin, only return permissions belonging to the requesting user
  let query = `
    SELECT 
      tsp.id as permission_id,
      tsp.uuid as permission_uuid,
      tsp.tournament_id,
      tsp.user_id,
      tsp.match_id,
      tsp.granted_by,
      tsp.scope,
      tsp.status,
      tsp.expires_at,
      tsp.revoked_at,
      tsp.notes,
      tsp.created_at,
      tsp.updated_at,
      u.full_name as user_full_name,
      u.email as user_email,
      u.phone as user_phone,
      u.profile_photo as user_avatar,
      g.full_name as granter_name,
      g.email as granter_email,
      tm.uuid as match_public_id,
      tm.match_number,
      tm.status as match_status,
      ta.name as team_a_name,
      tb.name as team_b_name
    FROM tournament_stream_permissions tsp
    JOIN users u ON tsp.user_id = u.id
    LEFT JOIN users g ON tsp.granted_by = g.id
    LEFT JOIN tournament_matches tm ON tsp.match_id = tm.id
    LEFT JOIN teams ta ON tm.team_a_id = ta.id
    LEFT JOIN teams tb ON tm.team_b_id = tb.id
    WHERE tsp.tournament_id = ?
  `;
  const params = [tournament.id];

  if (!isOwnerOrAdmin) {
    if (!currentUserId) {
      return [];
    }
    query += ` AND tsp.user_id = ?`;
    params.push(currentUserId);
  }

  query += ` ORDER BY tsp.status ASC, tsp.id DESC`;

  const rows = await db.query(query, params);

  return rows.map(r => {
    const isSelf = currentUserId && Number(currentUserId) === Number(r.user_id);
    const canSeeContact = isOwnerOrAdmin || isSelf;

    let scopeLabel = 'All Matches (Tournament-Wide)';
    if (r.scope === 'MATCH' && r.match_number) {
      scopeLabel = `Match #${r.match_number}: ${r.team_a_name || 'Team A'} vs ${r.team_b_name || 'Team B'}`;
    }

    return {
      id: r.permission_id,
      uuid: r.permission_uuid,
      tournamentId: tournament.uuid,
      tournamentName: tournament.name,
      userId: r.user_id,
      fullName: r.user_full_name,
      email: canSeeContact ? r.user_email : null,
      phone: canSeeContact ? r.user_phone : null,
      avatarUrl: r.user_avatar,
      scope: r.scope,
      scopeLabel,
      matchId: r.match_id,
      matchPublicId: r.match_public_id,
      matchNumber: r.match_number,
      matchStatus: r.match_status,
      teamAName: r.team_a_name,
      teamBName: r.team_b_name,
      status: r.status,
      isActive: r.status === 'ACTIVE' && (!r.expires_at || new Date(r.expires_at) > new Date()),
      grantedBy: r.granted_by,
      granterName: r.granter_name,
      notes: r.notes,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  });
}

/**
 * Grant live streaming permission to another registered user
 */
async function grantStreamPermission({
  tournamentId,
  userId,
  matchId = null,
  scope = 'TOURNAMENT',
  expiresAt = null,
  notes = null,
  grantedBy,
  grantedByRole
}) {
  const tournament = await getAuthoritativeTournament(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  // Permission check: only tournament creator, venue owner, or Superadmin
  const roleUpper = String(grantedByRole || '').toUpperCase();
  const isSuperAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN';
  const isCreator = Boolean(
    Number(tournament.created_by) === Number(grantedBy) ||
    Number(tournament.venue_owner_id) === Number(grantedBy)
  );

  if (!isSuperAdmin && !isCreator) {
    throw {
      statusCode: 403,
      message: 'Unauthorized. Only the tournament creator, venue owner, or Superadmin can grant streaming permissions.'
    };
  }

  // Validate target user exists
  const [targetUser] = await db.query(
    'SELECT id, full_name, email, phone FROM users WHERE id = ?',
    [userId]
  );
  if (!targetUser) {
    throw { statusCode: 404, message: 'Selected user account was not found.' };
  }

  // Prevent redundant grant to tournament creator
  if (Number(targetUser.id) === Number(tournament.created_by)) {
    throw {
      statusCode: 400,
      message: 'This user is the tournament creator and already possesses full streaming access.'
    };
  }

  // Resolve match if scope is MATCH
  let resolvedMatchId = null;
  let matchInfo = null;
  const isMatchScope = scope === 'MATCH' || (matchId && matchId !== 'ALL');

  if (isMatchScope) {
    if (!matchId || matchId === 'ALL') {
      throw { statusCode: 400, message: 'A specific match must be selected when scope is MATCH.' };
    }
    const isNum = /^\d+$/.test(String(matchId).trim());
    const [m] = await db.query(
      `SELECT id, uuid, match_number, status, team_a_id, team_b_id 
       FROM tournament_matches 
       WHERE (id = ? OR uuid = ?) AND tournament_id = ?`,
      [isNum ? parseInt(matchId, 10) : -1, String(matchId), tournament.id]
    );
    if (!m) {
      throw { statusCode: 404, message: 'Selected match does not belong to this tournament.' };
    }
    resolvedMatchId = m.id;
    matchInfo = m;
  }

  // Prevent duplicate active permission for the exact same user, tournament, and scope
  const existingActive = await db.query(
    `SELECT id FROM tournament_stream_permissions 
     WHERE tournament_id = ? 
       AND user_id = ? 
       AND status = 'ACTIVE' 
       AND (match_id <=> ?)
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tournament.id, targetUser.id, resolvedMatchId]
  );

  if (existingActive.length > 0) {
    throw {
      statusCode: 400,
      message: `User '${targetUser.full_name}' already has an active live streaming permission for this scope.`
    };
  }

  const permissionUuid = `tsp_${crypto.randomUUID()}`;
  const effectiveScope = resolvedMatchId ? 'MATCH' : 'TOURNAMENT';

  const result = await db.query(
    `INSERT INTO tournament_stream_permissions 
       (uuid, tournament_id, user_id, match_id, granted_by, scope, status, expires_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      permissionUuid,
      tournament.id,
      targetUser.id,
      resolvedMatchId,
      grantedBy,
      effectiveScope,
      expiresAt ? new Date(expiresAt) : null,
      notes ? String(notes).trim().slice(0, 255) : null
    ]
  );

  const scopeText = matchInfo
    ? `Match #${matchInfo.match_number}`
    : 'all tournament matches';

  // Send in-app notification to the delegated streamer
  try {
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, action_url, metadata)
       VALUES (?, ?, ?, 'TOURNAMENT', ?, ?)`,
      [
        targetUser.id,
        `Live Streaming Access Granted: ${tournament.name}`,
        `You have been authorized to live stream ${scopeText} for tournament "${tournament.name}".`,
        `/tournaments/${tournament.uuid}`,
        JSON.stringify({
          tournamentId: tournament.uuid,
          matchId: matchInfo?.uuid || null,
          permissionUuid
        })
      ]
    );
  } catch (err) {
    console.warn('Notification insert non-fatal warning:', err.message);
  }

  // Record audit log
  try {
    await db.query(
      `INSERT INTO tournament_audit_logs 
         (tournament_id, match_id, action_type, user_id, user_role, notes)
       VALUES (?, ?, 'STREAM_PERMISSION_GRANTED', ?, ?, ?)`,
      [
        tournament.id,
        resolvedMatchId,
        grantedBy,
        roleUpper || 'ORGANIZER',
        `Granted live streaming permission to ${targetUser.full_name} (User ID: ${targetUser.id}) for ${scopeText}`
      ]
    );
  } catch (err) {
    console.warn('Audit log insert non-fatal warning:', err.message);
  }

  // Socket.IO real-time emission
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:stream_permissions_updated', {
      tournamentId: tournament.uuid,
      permissionUuid,
      userId: targetUser.id,
      action: 'GRANTED',
      scope: effectiveScope
    });
    io.to(`user:${targetUser.id}`).emit('user:stream_permission_granted', {
      tournamentId: tournament.uuid,
      tournamentName: tournament.name,
      scope: effectiveScope,
      matchId: matchInfo?.uuid || null
    });
  }

  return {
    success: true,
    permissionId: result.insertId,
    uuid: permissionUuid,
    message: `Successfully granted live streaming permission to ${targetUser.full_name}.`
  };
}

/**
 * Revoke live streaming permission
 */
async function revokeStreamPermission({
  tournamentId,
  permissionIdOrUuid,
  revokedBy,
  revokedByRole
}) {
  const tournament = await getAuthoritativeTournament(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  // Permission check
  const roleUpper = String(revokedByRole || '').toUpperCase();
  const isSuperAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN';
  const isCreator = Boolean(
    Number(tournament.created_by) === Number(revokedBy) ||
    Number(tournament.venue_owner_id) === Number(revokedBy)
  );

  if (!isSuperAdmin && !isCreator) {
    throw {
      statusCode: 403,
      message: 'Unauthorized. Only the tournament creator, venue owner, or Superadmin can revoke streaming permissions.'
    };
  }

  const isNum = /^\d+$/.test(String(permissionIdOrUuid).trim());
  const [perm] = await db.query(
    `SELECT tsp.*, u.full_name, u.email 
     FROM tournament_stream_permissions tsp
     JOIN users u ON tsp.user_id = u.id
     WHERE (tsp.id = ? OR tsp.uuid = ?) AND tsp.tournament_id = ?`,
    [isNum ? parseInt(permissionIdOrUuid, 10) : -1, String(permissionIdOrUuid), tournament.id]
  );

  if (!perm) {
    throw { statusCode: 404, message: 'Streaming permission record not found.' };
  }

  if (perm.status === 'REVOKED') {
    return {
      success: true,
      message: 'Streaming permission is already revoked.'
    };
  }

  // Update status to REVOKED
  await db.query(
    `UPDATE tournament_stream_permissions 
     SET status = 'REVOKED', revoked_at = NOW(), revoked_by = ? 
     WHERE id = ?`,
    [revokedBy, perm.id]
  );

  // Send notification to user
  try {
    await db.query(
      `INSERT INTO notifications (user_id, title, message, type, action_url, metadata)
       VALUES (?, ?, ?, 'TOURNAMENT', ?, ?)`,
      [
        perm.user_id,
        `Live Streaming Access Revoked: ${tournament.name}`,
        `Your live streaming authorization for tournament "${tournament.name}" has been revoked by the organizer.`,
        `/tournaments/${tournament.uuid}`,
        JSON.stringify({ tournamentId: tournament.uuid, permissionId: perm.id })
      ]
    );
  } catch (err) {
    console.warn('Notification non-fatal warning:', err.message);
  }

  // Audit log
  try {
    await db.query(
      `INSERT INTO tournament_audit_logs 
         (tournament_id, match_id, action_type, user_id, user_role, notes)
       VALUES (?, ?, 'STREAM_PERMISSION_REVOKED', ?, ?, ?)`,
      [
        tournament.id,
        perm.match_id,
        revokedBy,
        roleUpper || 'ORGANIZER',
        `Revoked live streaming permission for ${perm.full_name} (User ID: ${perm.user_id})`
      ]
    );
  } catch (err) {
    console.warn('Audit log non-fatal warning:', err.message);
  }

  // Real-time broadcast
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:stream_permissions_updated', {
      tournamentId: tournament.uuid,
      permissionId: perm.id,
      permissionUuid: perm.uuid,
      userId: perm.user_id,
      action: 'REVOKED'
    });
    io.to(`user:${perm.user_id}`).emit('user:stream_permission_revoked', {
      tournamentId: tournament.uuid,
      permissionId: perm.id
    });
  }

  return {
    success: true,
    message: `Live streaming permission for ${perm.full_name} has been revoked.`
  };
}

/**
 * Fetch all streaming permissions / assignments for a specific user (for mobile / streamer dashboard)
 */
async function getUserStreamingAssignments(userId) {
  if (!userId) return [];
  const uid = Number(userId);

  // 1. Tournaments created by user (owner has implicit access to all matches)
  const ownedTournaments = await db.query(
    `SELECT t.id, t.uuid, t.name, t.city, t.status, s.slug as sport_slug, s.name as sport_name
     FROM tournaments t
     JOIN sports s ON t.sport_id = s.id
     WHERE t.created_by = ?`,
    [uid]
  );

  // 2. Active delegated permissions
  const delegated = await db.query(
    `SELECT 
       tsp.id as permission_id,
       tsp.uuid as permission_uuid,
       tsp.tournament_id,
       tsp.scope,
       tsp.match_id,
       tsp.expires_at,
       tsp.created_at,
       t.uuid as tournament_uuid,
       t.name as tournament_name,
       t.city,
       s.slug as sport_slug,
       s.name as sport_name,
       tm.uuid as match_public_id,
       tm.match_number,
       tm.status as match_status,
       ta.name as team_a_name,
       tb.name as team_b_name
     FROM tournament_stream_permissions tsp
     JOIN tournaments t ON tsp.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN tournament_matches tm ON tsp.match_id = tm.id
     LEFT JOIN teams ta ON tm.team_a_id = ta.id
     LEFT JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tsp.user_id = ? 
       AND tsp.status = 'ACTIVE' 
       AND (tsp.expires_at IS NULL OR tsp.expires_at > NOW())
     ORDER BY tsp.id DESC`,
    [uid]
  );

  return {
    ownedTournaments: ownedTournaments.map(t => ({
      tournamentId: t.uuid,
      tournamentName: t.name,
      city: t.city,
      status: t.status,
      sportSlug: t.sport_slug,
      sportName: t.sport_name,
      role: 'CREATOR',
      scope: 'ALL'
    })),
    delegatedAssignments: delegated.map(d => ({
      permissionId: d.permission_id,
      permissionUuid: d.permission_uuid,
      tournamentId: d.tournament_uuid,
      tournamentName: d.tournament_name,
      city: d.city,
      sportSlug: d.sport_slug,
      sportName: d.sport_name,
      role: 'DELEGATED_STREAMER',
      scope: d.scope,
      matchId: d.match_public_id,
      matchNumber: d.match_number,
      matchStatus: d.match_status,
      teamAName: d.team_a_name,
      teamBName: d.team_b_name,
      assignedAt: d.created_at,
      expiresAt: d.expires_at
    }))
  };
}

/**
 * Fetch streaming overview across all matches of a tournament
 */
async function getTournamentStreamingOverview(tournamentId, user = null) {
  const tournament = await getAuthoritativeTournament(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  const matches = await db.query(
    `SELECT 
       tm.id as internal_id,
       tm.uuid as match_id,
       tm.match_number,
       tm.status as match_status,
       tm.court_id,
       tm.has_live_stream,
       ta.name as team_a_name,
       ta.logo_url as team_a_logo,
       tb.name as team_b_name,
       tb.logo_url as team_b_logo,
       ms.uuid as stream_uuid,
       ms.streaming_method,
       ms.status as stream_status,
       ms.viewer_count,
       ms.title as stream_title,
       ms.actual_start,
       u.full_name as streamer_name
     FROM tournament_matches tm
     LEFT JOIN teams ta ON tm.team_a_id = ta.id
     LEFT JOIN teams tb ON tm.team_b_id = tb.id
     LEFT JOIN match_streams ms ON tm.id = ms.match_id
     LEFT JOIN users u ON ms.user_id = u.id
     WHERE tm.tournament_id = ?
     ORDER BY tm.match_number ASC`,
    [tournament.id]
  );

  // Determine user permission per match
  let isSuperAdmin = false;
  let isCreator = false;
  if (user && user.id) {
    const roleUpper = String(user.role || '').toUpperCase();
    isSuperAdmin = roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN';
    isCreator = Number(tournament.created_by) === Number(user.id) || Number(tournament.venue_owner_id) === Number(user.id);
  }

  // Pre-fetch active delegated permissions for this user if logged in
  const userDelegatedMatchIds = new Set();
  let hasTournamentWideDelegation = false;
  if (user && user.id && !isSuperAdmin && !isCreator) {
    const perms = await db.query(
      `SELECT match_id, scope FROM tournament_stream_permissions 
       WHERE tournament_id = ? AND user_id = ? AND status = 'ACTIVE' 
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [tournament.id, Number(user.id)]
    );
    for (const p of perms) {
      if (p.scope === 'TOURNAMENT' || p.match_id === null) {
        hasTournamentWideDelegation = true;
      } else if (p.match_id) {
        userDelegatedMatchIds.add(Number(p.match_id));
      }
    }
  }

  return matches.map(m => {
    const canManageThisMatch = Boolean(
      isSuperAdmin ||
      isCreator ||
      hasTournamentWideDelegation ||
      userDelegatedMatchIds.has(Number(m.internal_id))
    );

    return {
      matchId: m.match_id,
      matchNumber: m.match_number,
      matchStatus: m.match_status,
      teamAName: m.team_a_name,
      teamALogo: m.team_a_logo,
      teamBName: m.team_b_name,
      teamBLogo: m.team_b_logo,
      hasLiveStream: Boolean(m.has_live_stream || m.stream_status === 'LIVE'),
      stream: m.stream_uuid ? {
        id: m.stream_uuid,
        streamingMethod: m.streaming_method,
        status: m.stream_status || 'IDLE',
        isLive: m.stream_status === 'LIVE',
        viewerCount: m.viewer_count || 0,
        title: m.stream_title,
        streamerName: m.streamer_name,
        actualStart: m.actual_start
      } : null,
      canManageStream: canManageThisMatch
    };
  });
}

module.exports = {
  searchUsers,
  getAuthoritativeTournament,
  isTournamentOwnerOrAdmin,
  checkUserStreamPermission,
  getTournamentStreamPermissions,
  grantStreamPermission,
  revokeStreamPermission,
  getUserStreamingAssignments,
  getTournamentStreamingOverview
};
