const db = require('../config/database');
const cricketScorerService = require('./cricketScorerService');
const footballScorerService = require('./footballScorerService');
const badmintonScorerService = require('./badmintonScorerService');
const pickleballService = require('./pickleballService');
const { getIO } = require('./socketService');

/**
 * Resolves match entity and identified sport slug.
 */
async function resolveMatch(matchPublicId) {
  const isNumeric = /^\d+$/.test(String(matchPublicId).trim());
  const rows = await db.query(
    `SELECT tm.*, s.slug as sport_slug, s.name as sport_name,
            t.name as tournament_name, t.uuid as tournament_uuid,
            ta.name as team_a_name, tb.name as team_b_name
     FROM tournament_matches tm
     LEFT JOIN tournaments t ON tm.tournament_id = t.id
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN teams ta ON tm.team_a_id = ta.id
     LEFT JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchPublicId, isNumeric ? parseInt(matchPublicId, 10) : -1]
  );

  if (!rows || rows.length === 0) return null;
  return rows[0];
}

/**
 * Validates whether user is authorized to perform scoring / undo actions.
 */
async function checkScorerAuth(match, user) {
  if (!user) return false;
  const roleUpper = String(user.role || '').toUpperCase();
  if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') return true;

  const { checkUserCanScoreMatch } = require('./scorerAccessService');
  return await checkUserCanScoreMatch({ userId: user.id, userRole: user.role, matchPublicOrInternalId: match.id });
}

/**
 * 1. GET Last Reversible Action across any sport.
 */
async function getLastAction(matchPublicId) {
  const match = await resolveMatch(matchPublicId);
  if (!match) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  const sportSlug = (match.sport_slug || 'cricket').toLowerCase();

  // CRICKET
  if (sportSlug === 'cricket') {
    const balls = await db.query(
      `SELECT cb.*, 
              u_bat.full_name as striker_name,
              u_bowl.full_name as bowler_name
       FROM cricket_balls cb
       LEFT JOIN users u_bat ON cb.striker_id = u_bat.id
       LEFT JOIN users u_bowl ON cb.bowler_id = u_bowl.id
       WHERE cb.match_id = ?
       ORDER BY cb.id DESC LIMIT 1`,
      [match.id]
    );

    if (!balls || balls.length === 0) {
      return {
        canUndo: false,
        sport: 'cricket',
        lastAction: 'No deliveries recorded yet'
      };
    }

    const b = balls[0];
    let desc = `${b.runs_scored} runs`;
    if (b.is_wicket) desc = `Wicket (${b.wicket_type || 'OUT'})`;
    else if (b.is_wide) desc = `Wide (+${b.extra_runs || 1} extra)`;
    else if (b.is_no_ball) desc = `No Ball (+${b.extra_runs || 1} extra)`;
    else if (b.runs_scored === 4) desc = `FOUR (4 runs)`;
    else if (b.runs_scored === 6) desc = `SIX (6 runs)`;
    else if (b.runs_scored === 0) desc = `Dot Ball (0 runs)`;

    const batterStr = b.striker_name ? ` by ${b.striker_name}` : '';
    const bowlerStr = b.bowler_name ? ` (Bowler: ${b.bowler_name})` : '';

    return {
      canUndo: true,
      sport: 'cricket',
      lastAction: `${desc}${batterStr}${bowlerStr}`,
      eventType: b.is_wicket ? 'WICKET' : (b.runs_scored >= 4 ? 'BOUNDARY' : 'DELIVERY'),
      ballId: b.id,
      timestamp: b.created_at
    };
  }

  // FOOTBALL
  if (sportSlug === 'football') {
    const events = await db.query(
      `SELECT sme.*, u.full_name as player_name, tm.name as team_name
       FROM sport_match_events sme
       LEFT JOIN users u ON sme.player_id = u.id
       LEFT JOIN teams tm ON sme.team_id = tm.id
       WHERE sme.match_id = ?
       ORDER BY sme.id DESC LIMIT 1`,
      [match.id]
    );

    if (!events || events.length === 0) {
      return {
        canUndo: false,
        sport: 'football',
        lastAction: 'No match events recorded yet'
      };
    }

    const ev = events[0];
    let actionDesc = ev.commentary || `${ev.event_type} at ${ev.minute || 0}'`;
    if (ev.event_type === 'GOAL') {
      actionDesc = `Goal by ${ev.player_name || 'Player'} (${ev.minute || 0}') [${ev.team_name || ''}]`;
    } else if (ev.event_type === 'CARD') {
      actionDesc = `Card to ${ev.player_name || 'Player'} (${ev.minute || 0}')`;
    }

    return {
      canUndo: true,
      sport: 'football',
      lastAction: actionDesc,
      eventType: ev.event_type,
      eventId: ev.id,
      timestamp: ev.created_at
    };
  }

  // BADMINTON
  if (sportSlug === 'badminton') {
    const points = await db.query(
      `SELECT sme.*, tm.name as team_name
       FROM sport_match_events sme
       LEFT JOIN teams tm ON sme.team_id = tm.id
       WHERE sme.match_id = ? AND sme.event_type = 'POINT'
       ORDER BY sme.id DESC LIMIT 1`,
      [match.id]
    );

    if (!points || points.length === 0) {
      return {
        canUndo: false,
        sport: 'badminton',
        lastAction: 'No points recorded yet'
      };
    }

    const p = points[0];
    return {
      canUndo: true,
      sport: 'badminton',
      lastAction: `Point awarded to ${p.team_name || (p.period || 'Player')}`,
      eventType: 'POINT',
      eventId: p.id,
      timestamp: p.created_at
    };
  }

  // PICKLEBALL
  if (sportSlug === 'pickleball') {
    let state = {};
    try {
      state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
    } catch (e) {}

    const hasPoints = (match.team_a_score > 0 || match.team_b_score > 0 || (state.history && state.history.length > 0));
    return {
      canUndo: Boolean(hasPoints),
      sport: 'pickleball',
      lastAction: hasPoints ? `Point in Game ${state.currentGame || 1} (${match.team_a_score || 0} - ${match.team_b_score || 0})` : 'No points scored yet',
      eventType: 'POINT'
    };
  }

  return {
    canUndo: false,
    sport: sportSlug,
    lastAction: 'Undo not supported for this sport format'
  };
}

/**
 * 2. Perform Universal Undo across any sport.
 */
async function performUndo(matchPublicId, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuth(match, user);
  if (!isAuth) throw { statusCode: 403, message: 'Forbidden. You do not have permission to score or undo this match.' };

  const sportSlug = (match.sport_slug || 'cricket').toLowerCase();
  const previousState = match.sport_state;
  const previousScoreSummary = match.live_score_summary || '';

  let result = null;
  let undoneType = 'ACTION';
  let undoneDesc = '';

  // 1. Dispatch sport-specific undo
  if (sportSlug === 'cricket') {
    const lastActionInfo = await getLastAction(matchPublicId);
    undoneType = lastActionInfo.eventType || 'DELIVERY';
    undoneDesc = lastActionInfo.lastAction || 'Cricket Delivery';

    result = await cricketScorerService.undoLastDelivery({
      matchPublicId,
      userId: user.id,
      userRole: user.role
    });
  } else if (sportSlug === 'football') {
    const lastActionInfo = await getLastAction(matchPublicId);
    undoneType = lastActionInfo.eventType || 'EVENT';
    undoneDesc = lastActionInfo.lastAction || 'Football Event';

    result = await footballScorerService.undoLastEvent(matchPublicId, user);
  } else if (sportSlug === 'badminton') {
    const lastActionInfo = await getLastAction(matchPublicId);
    undoneType = 'POINT';
    undoneDesc = lastActionInfo.lastAction || 'Badminton Point';

    result = await badmintonScorerService.undoPoint(matchPublicId, user);
  } else if (sportSlug === 'pickleball') {
    undoneType = 'POINT';
    undoneDesc = 'Pickleball Point';

    result = await pickleballService.undoPoint(match.id, user);
  } else {
    throw { statusCode: 400, message: `Undo is not supported for ${sportSlug}.` };
  }

  // 2. Fetch updated match record after undo
  const [updatedMatch] = await db.query(
    `SELECT live_score_summary, sport_state, status FROM tournament_matches WHERE id = ?`,
    [match.id]
  );

  // 3. Persistent Audit Trail in scoring_undo_audit
  await db.query(
    `INSERT INTO scoring_undo_audit (
      match_id, sport_slug, undone_event_type, event_description,
      previous_state, restored_state, performed_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      match.id,
      sportSlug,
      undoneType,
      undoneDesc,
      typeof previousState === 'string' ? previousState : JSON.stringify(previousState),
      typeof updatedMatch.sport_state === 'string' ? updatedMatch.sport_state : JSON.stringify(updatedMatch.sport_state),
      user.id
    ]
  );

  // 4. Fetch the new last action
  const nextLastAction = await getLastAction(matchPublicId);

  // 5. Authoritative WebSocket broadcast
  const io = getIO();
  if (io) {
    const eventPayload = {
      matchId: match.uuid,
      sportSlug,
      undoneAction: undoneDesc,
      liveScoreSummary: updatedMatch.live_score_summary,
      status: updatedMatch.status,
      state: typeof updatedMatch.sport_state === 'string' ? JSON.parse(updatedMatch.sport_state) : updatedMatch.sport_state,
      canUndo: nextLastAction.canUndo,
      lastAction: nextLastAction.lastAction
    };

    io.to(`match:${match.uuid}`).emit('match:undone', eventPayload);
    if (match.tournament_uuid) {
      io.to(`tournament:${match.tournament_uuid}`).emit('tournament:matchUpdated', eventPayload);
    }
  }

  return {
    success: true,
    message: `Successfully undone: ${undoneDesc}`,
    sport: sportSlug,
    scoreSummary: updatedMatch.live_score_summary,
    status: updatedMatch.status,
    state: typeof updatedMatch.sport_state === 'string' ? JSON.parse(updatedMatch.sport_state) : updatedMatch.sport_state,
    canUndo: nextLastAction.canUndo,
    lastAction: nextLastAction.lastAction
  };
}

/**
 * 3. GET Undo Audit History for a Match.
 */
async function getUndoHistory(matchPublicId) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const rows = await db.query(
    `SELECT sua.*, u.full_name as performed_by_name
     FROM scoring_undo_audit sua
     LEFT JOIN users u ON sua.performed_by_id = u.id
     WHERE sua.match_id = ?
     ORDER BY sua.id DESC LIMIT 30`,
    [match.id]
  );

  return rows.map(r => ({
    id: r.id,
    undoneEventType: r.undone_event_type,
    eventDescription: r.event_description,
    performedByName: r.performed_by_name || 'Authorized Scorer',
    createdAt: r.created_at
  }));
}

module.exports = {
  resolveMatch,
  getLastAction,
  performUndo,
  getUndoHistory
};
