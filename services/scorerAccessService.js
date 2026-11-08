const db = require('../config/database');
const { getIO } = require('./socketService');

/**
 * Search users by name, email, or phone (for scorer assignment)
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
 * Get all assigned scorers for a tournament
 */
async function getTournamentScorers(tournamentId, user = null) {
  const [tournament] = await db.query(
    'SELECT id, uuid, name, created_by FROM tournaments WHERE uuid = ? OR id = ?',
    [tournamentId, isNaN(tournamentId) ? -1 : parseInt(tournamentId, 10)]
  );
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  const rows = await db.query(
    `SELECT 
       ts.id as assignment_id,
       ts.tournament_id,
       ts.user_id,
       ts.match_id,
       ts.created_at,
       u.id as user_public_id,
       u.full_name,
       u.email,
       u.phone,
       u.profile_photo as avatar_url,
       tm.uuid as match_public_id,
       tm.match_number,
       tm.category as match_category,
       ta.name as team_a_name,
       tb.name as team_b_name
     FROM tournament_scorers ts
     JOIN users u ON ts.user_id = u.id
     LEFT JOIN tournament_matches tm ON ts.match_id = tm.id
     LEFT JOIN teams ta ON tm.team_a_id = ta.id
     LEFT JOIN teams tb ON tm.team_b_id = tb.id
     WHERE ts.tournament_id = ?
     ORDER BY ts.id DESC`,
    [tournament.id]
  );

  const userRole = (user?.role || '').toUpperCase();
  const isSuperAdmin = userRole === 'ADMIN' || userRole === 'SUPER_ADMIN';
  const isOrganizer = Boolean(
    user && (
      isSuperAdmin ||
      Number(user.id) === Number(tournament.created_by) ||
      Number(user.id) === Number(tournament.creator_id)
    )
  );

  return rows.map(r => {
    const isSelf = user && Number(user.id) === Number(r.user_id);
    const canSeeContact = isOrganizer || isSelf;

    return {
      assignmentId: r.assignment_id,
      tournamentId: r.tournament_id,
      userId: r.user_id,
      userPublicId: r.user_public_id,
      fullName: r.full_name,
      email: canSeeContact ? r.email : null,
      phone: canSeeContact ? r.phone : null,
      avatarUrl: r.avatar_url,
      matchId: r.match_id,
      matchPublicId: r.match_public_id,
      matchNumber: r.match_number,
      matchCategory: r.match_category,
      teamAName: r.team_a_name,
      teamBName: r.team_b_name,
      scope: r.match_id ? `Match #${r.match_number}: ${r.team_a_name || 'Team A'} vs ${r.team_b_name || 'Team B'}` : 'All Matches (Tournament-Wide)',
      assignedAt: r.created_at
    };
  });
}

/**
 * Assign user as scorer for tournament or specific match
 */
async function assignScorer({ tournamentId, userId, matchId = null, assignedBy, assignedByRole }) {
  const [tournament] = await db.query(
    'SELECT id, uuid, name, created_by FROM tournaments WHERE uuid = ? OR id = ?',
    [tournamentId, isNaN(tournamentId) ? -1 : parseInt(tournamentId, 10)]
  );
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  // Permission check: only tournament creator or ADMIN can assign scorers
  const assignedRoleUpper = String(assignedByRole || '').toUpperCase();
  if (assignedRoleUpper !== 'ADMIN' && assignedRoleUpper !== 'SUPER_ADMIN' && tournament.created_by !== assignedBy) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can assign scorers.' };
  }

  const [targetUser] = await db.query('SELECT id, full_name, email FROM users WHERE id = ?', [userId]);
  if (!targetUser) throw { statusCode: 404, message: 'User not found' };

  let resolvedMatchId = null;
  let matchInfo = null;
  if (matchId && matchId !== 'ALL') {
    const [m] = await db.query('SELECT id, match_number, uuid FROM tournament_matches WHERE (id = ? OR uuid = ?) AND tournament_id = ?', [matchId, matchId, tournament.id]);
    if (m) {
      resolvedMatchId = m.id;
      matchInfo = m;
    }
  }

  // Prevent duplicate assignment
  const existing = await db.query(
    'SELECT id FROM tournament_scorers WHERE tournament_id = ? AND user_id = ? AND (match_id <=> ?)',
    [tournament.id, targetUser.id, resolvedMatchId]
  );
  if (existing.length > 0) {
    throw { statusCode: 400, message: 'User is already assigned to this tournament/match scope.' };
  }

  const result = await db.query(
    'INSERT INTO tournament_scorers (tournament_id, user_id, match_id, assigned_by) VALUES (?, ?, ?, ?)',
    [tournament.id, targetUser.id, resolvedMatchId, assignedBy]
  );

  // If match-specific, also update tournament_matches.scorer_id
  if (resolvedMatchId) {
    await db.query('UPDATE tournament_matches SET scorer_id = ? WHERE id = ?', [targetUser.id, resolvedMatchId]);
  }

  // Send Notification to Scorer
  const scopeText = matchInfo ? `Match #${matchInfo.match_number}` : 'all matches';
  await db.query(
    `INSERT INTO notifications (user_id, title, message, type, action_url, metadata)
     VALUES (?, ?, ?, 'TOURNAMENT', ?, ?)`,
    [
      targetUser.id,
      `Scorer Assignment: ${tournament.name}`,
      `You have been assigned as an official scorer for ${scopeText} in tournament "${tournament.name}".`,
      `/tournaments/${tournament.uuid}`,
      JSON.stringify({ tournamentId: tournament.uuid, matchId: matchInfo?.uuid || null })
    ]
  );

  // Audit trail entry
  await db.query(
    `INSERT INTO tournament_audit_logs (tournament_id, match_id, action_type, user_id, user_role, notes)
     VALUES (?, ?, 'SCORER_ASSIGNED', ?, ?, ?)`,
    [
      tournament.id,
      resolvedMatchId,
      assignedBy,
      assignedByRole || 'ORGANIZER',
      `Assigned scorer ${targetUser.full_name} (ID: ${targetUser.id}) for ${scopeText}`
    ]
  );

  // WebSocket broadcast
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:scorersUpdated', {
      tournamentId: tournament.uuid,
      scorerUserId: targetUser.id
    });
    io.to(`user:${targetUser.id}`).emit('user:scorer_assignment_updated', {
      tournamentId: tournament.uuid,
      action: 'ASSIGNED'
    });
    io.emit('scorer:assignmentChanged', {
      tournamentId: tournament.uuid,
      userId: targetUser.id,
      action: 'ASSIGNED'
    });
  }

  return {
    success: true,
    assignmentId: result.insertId,
    message: `Successfully assigned ${targetUser.full_name} as scorer.`
  };
}

/**
 * Remove scorer assignment
 */
async function removeScorer({ tournamentId, assignmentId, removedBy, removedByRole }) {
  const [tournament] = await db.query(
    'SELECT id, uuid, name, created_by FROM tournaments WHERE uuid = ? OR id = ?',
    [tournamentId, isNaN(tournamentId) ? -1 : parseInt(tournamentId, 10)]
  );
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  const removedRoleUpper = String(removedByRole || '').toUpperCase();
  if (removedRoleUpper !== 'ADMIN' && removedRoleUpper !== 'SUPER_ADMIN' && tournament.created_by !== removedBy) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can remove scorers.' };
  }

  const [assignment] = await db.query('SELECT * FROM tournament_scorers WHERE id = ? AND tournament_id = ?', [assignmentId, tournament.id]);
  if (!assignment) throw { statusCode: 404, message: 'Scorer assignment not found' };

  await db.query('DELETE FROM tournament_scorers WHERE id = ?', [assignmentId]);

  // If match-specific, clear scorer_id if it matches
  if (assignment.match_id) {
    await db.query('UPDATE tournament_matches SET scorer_id = NULL WHERE id = ? AND scorer_id = ?', [assignment.match_id, assignment.user_id]);
  }

  // Audit log
  await db.query(
    `INSERT INTO tournament_audit_logs (tournament_id, match_id, action_type, user_id, user_role, notes)
     VALUES (?, ?, 'SCORER_REMOVED', ?, ?, ?)`,
    [
      tournament.id,
      assignment.match_id,
      removedBy,
      removedByRole || 'ORGANIZER',
      `Removed scorer user ID ${assignment.user_id} assignment #${assignmentId}`
    ]
  );

  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:scorersUpdated', {
      tournamentId: tournament.uuid,
      removedAssignmentId: assignmentId
    });
    io.to(`user:${assignment.user_id}`).emit('user:scorer_assignment_updated', {
      tournamentId: tournament.uuid,
      action: 'REMOVED'
    });
    io.emit('scorer:assignmentChanged', {
      tournamentId: tournament.uuid,
      userId: assignment.user_id,
      action: 'REMOVED'
    });
  }

  return { success: true, message: 'Scorer access removed successfully.' };
}

/**
 * Verify if authenticated user is authorized to score a match
 * Permitted:
 * a) Superadmin (ADMIN, SUPER_ADMIN)
 * b) Organizer: Creator/owner of THAT tournament
 * c) Assigned Scorer: Explicitly assigned in tournament_scorers (tournament-wide or match-specific) or tournament_matches.scorer_id
 * Denied: All other users (guests, players, turf owners, team owners, unrelated organizers)
 */
async function checkUserCanScoreMatch({ userId, userRole, matchPublicOrInternalId }) {
  if (!userId) return false;
  const uid = Number(userId);

  // 1. Superadmin check (role or DB check)
  const roleUpper = String(userRole || '').toUpperCase();
  if (roleUpper === 'SUPER_ADMIN' || roleUpper === 'ADMIN') return true;

  const adminCheck = await db.query(
    `SELECT ur.user_id FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = ? AND UPPER(r.name) IN ('ADMIN', 'SUPER_ADMIN') 
     LIMIT 1`,
    [uid]
  );
  if (adminCheck && adminCheck.length > 0) return true;

  // 2. Fetch match and its parent tournament
  const [match] = await db.query(
    `SELECT tm.id, tm.scorer_id, tm.tournament_id, 
            t.created_by as tournament_creator_id
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchPublicOrInternalId, isNaN(matchPublicOrInternalId) ? -1 : parseInt(matchPublicOrInternalId, 10)]
  );

  if (!match) return false;

  // 3. Organizer of THAT tournament only
  if (match.tournament_creator_id && Number(match.tournament_creator_id) === uid) {
    return true;
  }

  // 4. Direct match scorer_id
  if (match.scorer_id && Number(match.scorer_id) === uid) {
    return true;
  }

  // 5. Check tournament_scorers table (tournament-wide match_id IS NULL OR match-specific match_id = match.id)
  const rows = await db.query(
    `SELECT id FROM tournament_scorers 
     WHERE tournament_id = ? AND user_id = ? AND (match_id IS NULL OR match_id = ?)`,
    [match.tournament_id, uid, match.id]
  );

  return Boolean(rows && rows.length > 0);
}

/**
 * Check a user's scoring access scope for a tournament
 * Returns: { canScoreAny: boolean, isSuperAdmin: boolean, isOrganizer: boolean, isAssignedScorer: boolean, assignedMatchIds: number[] | 'ALL' }
 */
async function getTournamentScorerAccess({ userId, userRole, tournamentId }) {
  if (!userId) {
    return {
      canScoreAny: false,
      isSuperAdmin: false,
      isOrganizer: false,
      isAssignedScorer: false,
      assignedMatchIds: []
    };
  }
  const uid = Number(userId);

  // 1. Superadmin check
  const roleUpper = String(userRole || '').toUpperCase();
  if (roleUpper === 'SUPER_ADMIN' || roleUpper === 'ADMIN') {
    return {
      canScoreAny: true,
      isSuperAdmin: true,
      isOrganizer: true,
      isAssignedScorer: true,
      assignedMatchIds: 'ALL'
    };
  }

  const adminCheck = await db.query(
    `SELECT ur.user_id FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = ? AND UPPER(r.name) IN ('ADMIN', 'SUPER_ADMIN') 
     LIMIT 1`,
    [uid]
  );
  if (adminCheck && adminCheck.length > 0) {
    return {
      canScoreAny: true,
      isSuperAdmin: true,
      isOrganizer: true,
      isAssignedScorer: true,
      assignedMatchIds: 'ALL'
    };
  }

  // 2. Fetch tournament
  const isTournNum = /^\d+$/.test(String(tournamentId).trim());
  const [tournament] = await db.query(
    'SELECT id, uuid, created_by FROM tournaments WHERE uuid = ? OR id = ?',
    [tournamentId, isTournNum ? parseInt(tournamentId, 10) : -1]
  );
  if (!tournament) {
    return {
      canScoreAny: false,
      isSuperAdmin: false,
      isOrganizer: false,
      isAssignedScorer: false,
      assignedMatchIds: []
    };
  }

  // 3. Organizer of THAT tournament
  if (tournament.created_by && Number(tournament.created_by) === uid) {
    return {
      canScoreAny: true,
      isSuperAdmin: false,
      isOrganizer: true,
      isAssignedScorer: false,
      assignedMatchIds: 'ALL'
    };
  }

  // 4. Check tournament_scorers assignments
  const assignments = await db.query(
    'SELECT match_id FROM tournament_scorers WHERE tournament_id = ? AND user_id = ?',
    [tournament.id, uid]
  );

  // Also check direct match scorer_id
  const directMatches = await db.query(
    'SELECT id FROM tournament_matches WHERE tournament_id = ? AND scorer_id = ?',
    [tournament.id, uid]
  );

  const hasTournamentWide = assignments.some(a => a.match_id === null);
  if (hasTournamentWide) {
    return {
      canScoreAny: true,
      isSuperAdmin: false,
      isOrganizer: false,
      isAssignedScorer: true,
      assignedMatchIds: 'ALL'
    };
  }

  const matchIdsSet = new Set();
  assignments.forEach(a => { if (a.match_id) matchIdsSet.add(a.match_id); });
  directMatches.forEach(m => { if (m.id) matchIdsSet.add(m.id); });

  const assignedMatchIds = Array.from(matchIdsSet);
  const canScoreAny = assignedMatchIds.length > 0;

  return {
    canScoreAny,
    isSuperAdmin: false,
    isOrganizer: false,
    isAssignedScorer: canScoreAny,
    assignedMatchIds
  };
}

/**
 * Fetch matches assigned to current user for scoring ("My Scoring Matches" shortcut)
 */
async function getUserScoringMatches(userId) {
  if (!userId) return [];
  const uid = Number(userId);

  // Check if user is an ADMIN or SUPER_ADMIN
  const adminCheck = await db.query(
    `SELECT ur.user_id FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = ? AND UPPER(r.name) IN ('ADMIN', 'SUPER_ADMIN') 
     LIMIT 1`,
    [uid]
  );
  const isAdmin = adminCheck && adminCheck.length > 0;

  let query = `
    SELECT DISTINCT
       tm.id, tm.uuid, tm.match_number, tm.status, tm.match_date, tm.start_time,
       tm.live_score_summary, tm.live_subtext, tm.category,
       t.id as tournament_id, t.uuid as tournament_uuid, t.name as tournament_name,
       s.slug as sport_slug, s.name as sport_name,
       ta.name as team_a_name, ta.logo_url as team_a_logo,
       tb.name as team_b_name, tb.logo_url as team_b_logo,
       v.name as venue_name,
       c.name as court_name
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     LEFT JOIN courts c ON tm.court_id = c.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     LEFT JOIN tournament_scorers ts ON ts.tournament_id = t.id AND (ts.match_id IS NULL OR ts.match_id = tm.id)
  `;

  let params = [];
  if (!isAdmin) {
    query += ` WHERE (tm.scorer_id = ? OR ts.user_id = ?)`;
    params = [uid, uid];
  }

  query += `
     ORDER BY 
       CASE tm.status 
         WHEN 'LIVE' THEN 1 
         WHEN 'SCHEDULED' THEN 2 
         ELSE 3 
       END, 
       tm.match_date ASC, tm.start_time ASC`;

  const rows = await db.query(query, params);
  return rows;
}

module.exports = {
  searchUsers,
  getTournamentScorers,
  assignScorer,
  removeScorer,
  checkUserCanScoreMatch,
  getTournamentScorerAccess,
  getUserScoringMatches
};
