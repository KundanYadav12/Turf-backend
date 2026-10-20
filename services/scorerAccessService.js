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
async function getTournamentScorers(tournamentId) {
  const [tournament] = await db.query(
    'SELECT id, uuid, name FROM tournaments WHERE uuid = ? OR id = ?',
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

  return rows.map(r => ({
    assignmentId: r.assignment_id,
    tournamentId: r.tournament_id,
    userId: r.user_id,
    userPublicId: r.user_public_id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    avatarUrl: r.avatar_url,
    matchId: r.match_id,
    matchPublicId: r.match_public_id,
    matchNumber: r.match_number,
    matchCategory: r.match_category,
    teamAName: r.team_a_name,
    teamBName: r.team_b_name,
    scope: r.match_id ? `Match #${r.match_number}: ${r.team_a_name || 'Team A'} vs ${r.team_b_name || 'Team B'}` : 'All Matches (Tournament-Wide)',
    assignedAt: r.created_at
  }));
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
  }

  return { success: true, message: 'Scorer access removed successfully.' };
}

/**
 * Verify if authenticated user is authorized to score a match
 */
async function checkUserCanScoreMatch({ userId, userRole, matchPublicOrInternalId }) {
  if (!userId) return false;

  const roleUpper = String(userRole || '').toUpperCase();
  if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') return true;

  // Also check database user_roles in case user token role was omitted or stale
  const adminCheck = await db.query(
    `SELECT ur.user_id FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = ? AND UPPER(r.name) IN ('ADMIN', 'SUPER_ADMIN') 
     LIMIT 1`,
    [userId]
  );
  if (adminCheck && adminCheck.length > 0) return true;

  const [match] = await db.query(
    `SELECT tm.id, tm.scorer_id, tm.venue_id, tm.tournament_id, 
            t.created_by as tournament_creator_id, 
            v.owner_id as venue_owner_id
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchPublicOrInternalId, isNaN(matchPublicOrInternalId) ? -1 : parseInt(matchPublicOrInternalId, 10)]
  );

  if (!match) return false;

  // Tournament creator or Venue owner
  if (match.tournament_creator_id === userId || match.venue_owner_id === userId) {
    return true;
  }

  // Direct match scorer_id
  if (match.scorer_id === userId) {
    return true;
  }

  // Check tournament_scorers table (tournament-wide match_id IS NULL OR match-specific match_id = match.id)
  const rows = await db.query(
    `SELECT id FROM tournament_scorers 
     WHERE tournament_id = ? AND user_id = ? AND (match_id IS NULL OR match_id = ?)`,
    [match.tournament_id, userId, match.id]
  );

  return rows.length > 0;
}

/**
 * Fetch matches assigned to current user for scoring ("My Scoring Matches" shortcut)
 */
async function getUserScoringMatches(userId) {
  if (!userId) return [];

  // Check if user is an ADMIN or SUPER_ADMIN
  const adminCheck = await db.query(
    `SELECT ur.user_id FROM user_roles ur 
     JOIN roles r ON ur.role_id = r.id 
     WHERE ur.user_id = ? AND UPPER(r.name) IN ('ADMIN', 'SUPER_ADMIN') 
     LIMIT 1`,
    [userId]
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
       v.name as venue_name
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     LEFT JOIN tournament_scorers ts ON ts.tournament_id = t.id AND (ts.match_id IS NULL OR ts.match_id = tm.id)
  `;

  let params = [];
  if (!isAdmin) {
    query += ` WHERE (tm.scorer_id = ? OR ts.user_id = ?)`;
    params = [userId, userId];
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
  getUserScoringMatches
};
