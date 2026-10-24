const db = require('../config/database');
const { broadcastTournamentMatchUpdate, getIO } = require('./socketService');
const { recalculateStandings, advanceKnockoutWinner } = require('./tournamentEngineService');

/**
 * Football Match Scoring and Management Service
 * Full-featured match engine for football tournaments:
 * - Lineups (Starting XI + Subs)
 * - Clock / Timer & Match Periods (1st Half, Halftime, 2nd Half, Extra Time, Shootout)
 * - Goal & Assist attribution, Own Goals, Penalties
 * - Cards (Yellow & Red)
 * - Substitutions
 * - Event Timeline & Statistics
 * - Standings recalculation & Knockout progression
 * - Undo & Corrections
 */

/**
 * Helper to resolve match by UUID or ID.
 */
async function resolveMatch(matchId) {
  const rows = await db.query(
    `SELECT tm.*, 
            t.uuid as tournament_public_id, t.name as tournament_name,
            s.slug as sport_slug,
            c.name as court_name, v.name as venue_name,
            ta.uuid as team_a_public_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
            tb.uuid as team_b_public_id, tb.name as team_b_name, tb.logo_url as team_b_logo
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN courts c ON tm.court_id = c.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchId, isNaN(matchId) ? -1 : parseInt(matchId, 10)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 1. Get full football scorer console state.
 */
async function getScorerState(matchPublicId) {
  const match = await resolveMatch(matchPublicId);
  if (!match) return null;

  // Parse sport_state JSON
  let state = {
    period: 'NOT_STARTED', // NOT_STARTED, 1ST_HALF, HALF_TIME, 2ND_HALF, EXTRA_TIME_1, EXTRA_TIME_2, PENALTIES, FULL_TIME
    minute: 0,
    stoppageMinutes: 0,
    teamAScore: match.team_a_score != null ? match.team_a_score : 0,
    teamBScore: match.team_b_score != null ? match.team_b_score : 0,
    penaltiesA: 0,
    penaltiesB: 0,
    teamALineup: { starting: [], substitutes: [] },
    teamBLineup: { starting: [], substitutes: [] },
    stats: {
      teamA: { shots: 0, yellowCards: 0, redCards: 0, fouls: 0, substitutions: 0 },
      teamB: { shots: 0, yellowCards: 0, redCards: 0, fouls: 0, substitutions: 0 }
    }
  };

  if (match.sport_state) {
    try {
      const parsed = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : match.sport_state;
      state = { ...state, ...parsed };
    } catch (e) {}
  }

  // Fetch full squads from team_members for Lineup selection
  const teamAPlayers = await db.query(
    `SELECT tm.id as member_id, tm.jersey_number, tm.role, 
            COALESCE(u.full_name, tm.player_name, 'Player') as name,
            u.id as user_id
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [match.team_a_id]
  );

  const teamBPlayers = await db.query(
    `SELECT tm.id as member_id, tm.jersey_number, tm.role, 
            COALESCE(u.full_name, tm.player_name, 'Player') as name,
            u.id as user_id
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [match.team_b_id]
  );

  // Fetch chronological event timeline from sport_match_events
  const events = await db.query(
    `SELECT e.*, 
            p.full_name as player_name,
            ap.full_name as assist_player_name,
            poff.full_name as player_off_name,
            pon.full_name as player_on_name
     FROM sport_match_events e
     LEFT JOIN users p ON e.player_id = p.id
     LEFT JOIN users ap ON e.assist_player_id = ap.id
     LEFT JOIN users poff ON e.player_off_id = poff.id
     LEFT JOIN users pon ON e.player_on_id = pon.id
     WHERE e.match_id = ?
     ORDER BY e.id DESC`,
    [match.id]
  );

  return {
    match: {
      id: match.uuid,
      internalId: match.id,
      matchNumber: match.match_number,
      status: match.status,
      stage: match.stage || 'GROUP',
      groupName: match.group_name,
      courtName: match.court_name || 'Main Turf',
      venueName: match.venue_name || 'Sports Arena',
      teamA: {
        id: match.team_a_public_id,
        internalId: match.team_a_id,
        name: match.team_a_name,
        logo: match.team_a_logo,
        squad: teamAPlayers
      },
      teamB: {
        id: match.team_b_public_id,
        internalId: match.team_b_id,
        name: match.team_b_name,
        logo: match.team_b_logo,
        squad: teamBPlayers
      },
      tournament: {
        id: match.tournament_public_id,
        name: match.tournament_name
      }
    },
    state,
    events
  };
}

/**
 * 2. Set Starting XI and Substitutes for both teams.
 */
async function setLineups(matchPublicId, { teamALineup, teamBLineup }, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  state.teamALineup = teamALineup || state.teamALineup || { starting: [], substitutes: [] };
  state.teamBLineup = teamBLineup || state.teamBLineup || { starting: [], substitutes: [] };

  await db.query(
    `UPDATE tournament_matches 
     SET sport_state = ?, team_a_lineup = ?, team_b_lineup = ?
     WHERE id = ?`,
    [
      JSON.stringify(state),
      JSON.stringify(state.teamALineup),
      JSON.stringify(state.teamBLineup),
      match.id
    ]
  );

  return { success: true, message: 'Lineups updated successfully.', state };
}

/**
 * 3. Start Match or change period (1ST_HALF, HALF_TIME, 2ND_HALF, etc.).
 */
async function updatePeriod(matchPublicId, { period, minute, stoppageMinutes = 0 }, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  state.period = period;
  if (minute !== undefined) state.minute = minute;
  state.stoppageMinutes = stoppageMinutes;

  let newStatus = match.status;
  if (['1ST_HALF', '2ND_HALF', 'EXTRA_TIME_1', 'EXTRA_TIME_2', 'PENALTIES'].includes(period)) {
    newStatus = 'LIVE';
  } else if (period === 'HALF_TIME') {
    newStatus = 'PAUSED';
  } else if (period === 'FULL_TIME') {
    newStatus = 'COMPLETED';
  }

  const scoreSummary = `${state.teamAScore || 0} - ${state.teamBScore || 0}`;
  const liveSubtext = period === 'HALF_TIME' ? 'Half Time' : (period === 'FULL_TIME' ? 'Full Time' : `${period.replace('_', ' ')} (${state.minute}')`);

  await db.query(
    `UPDATE tournament_matches 
     SET status = ?, period_state = ?, sport_state = ?,
         live_score_summary = ?, live_subtext = ?
     WHERE id = ?`,
    [newStatus, period, JSON.stringify(state), scoreSummary, liveSubtext, match.id]
  );

  // Broadcast to Socket.IO
  broadcastFootballEvent(match, {
    type: 'PERIOD_CHANGE',
    period,
    minute: state.minute,
    scoreSummary,
    status: newStatus
  });

  return { success: true, state, status: newStatus };
}

/**
 * 4. Record Goal (Open Play, Penalty, Own Goal).
 */
async function recordGoal(matchPublicId, {
  teamId,
  scorerId,
  scorerName,
  assistId = null,
  assistName = null,
  minute = 1,
  isPenalty = false,
  isOwnGoal = false,
  commentary = null
}, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  state.teamAScore = state.teamAScore || 0;
  state.teamBScore = state.teamBScore || 0;

  const isTeamA = Number(teamId) === Number(match.team_a_id);
  if (isTeamA) {
    state.teamAScore++;
  } else {
    state.teamBScore++;
  }

  const teamName = isTeamA ? match.team_a_name : match.team_b_name;
  const desc = commentary || `⚽ GOAL! ${scorerName || 'Player'} scores for ${teamName} (${minute}')!`;

  // Insert event
  const insertRes = await db.query(
    `INSERT INTO sport_match_events (
      match_id, sport_slug, event_type, period, minute, team_id,
      player_id, assist_player_id, commentary, payload
    ) VALUES (?, 'football', 'GOAL', ?, ?, ?, ?, ?, ?, ?)`,
    [
      match.id,
      state.period || '1ST_HALF',
      minute,
      teamId,
      scorerId || null,
      assistId || null,
      desc,
      JSON.stringify({ isPenalty, isOwnGoal, scorerName, assistName })
    ]
  );

  const scoreSummary = `${state.teamAScore} - ${state.teamBScore}`;
  const liveSubtext = `${desc}`;

  await db.query(
    `UPDATE tournament_matches 
     SET team_a_score = ?, team_b_score = ?,
         live_score_summary = ?, live_subtext = ?,
         sport_state = ?
     WHERE id = ?`,
    [state.teamAScore, state.teamBScore, scoreSummary, liveSubtext, JSON.stringify(state), match.id]
  );

  // Broadcast goal celebration to match room, tournament room, and digital signage
  broadcastFootballEvent(match, {
    type: 'GOAL',
    eventId: insertRes.insertId,
    teamId,
    teamName,
    scorerName,
    assistName,
    minute,
    scoreSummary,
    celebration: 'GOAL'
  });

  return { success: true, state, scoreSummary, eventId: insertRes.insertId };
}

/**
 * 5. Record Card (Yellow or Red).
 */
async function recordCard(matchPublicId, {
  teamId,
  playerId,
  playerName,
  cardType = 'YELLOW', // YELLOW | RED
  minute = 1,
  reason = 'Foul'
}, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const isTeamA = Number(teamId) === Number(match.team_a_id);
  const teamName = isTeamA ? match.team_a_name : match.team_b_name;
  const desc = cardType === 'RED'
    ? `🟥 RED CARD! ${playerName || 'Player'} (${teamName}) is sent off (${minute}')!`
    : `🟨 YELLOW CARD! ${playerName || 'Player'} (${teamName}) booked (${minute}')!`;

  const insertRes = await db.query(
    `INSERT INTO sport_match_events (
      match_id, sport_slug, event_type, period, minute, team_id,
      player_id, commentary, payload
    ) VALUES (?, 'football', ?, 'MATCH', ?, ?, ?, ?, ?)`,
    [
      match.id,
      cardType === 'RED' ? 'RED_CARD' : 'YELLOW_CARD',
      minute,
      teamId,
      playerId || null,
      desc,
      JSON.stringify({ playerName, reason, cardType })
    ]
  );

  broadcastFootballEvent(match, {
    type: cardType === 'RED' ? 'RED_CARD' : 'YELLOW_CARD',
    playerId,
    playerName,
    cardType,
    minute,
    commentary: desc
  });

  return { success: true, eventId: insertRes.insertId, commentary: desc };
}

/**
 * 6. Record Substitution.
 */
async function recordSubstitution(matchPublicId, {
  teamId,
  playerOffId,
  playerOffName,
  playerOnId,
  playerOnName,
  minute = 1
}, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const isTeamA = Number(teamId) === Number(match.team_a_id);
  const teamName = isTeamA ? match.team_a_name : match.team_b_name;
  const desc = `🔄 Substitution for ${teamName}: ${playerOnName} ON 🔼, ${playerOffName} OFF 🔽 (${minute}')`;

  const insertRes = await db.query(
    `INSERT INTO sport_match_events (
      match_id, sport_slug, event_type, period, minute, team_id,
      player_off_id, player_on_id, commentary, payload
    ) VALUES (?, 'football', 'SUBSTITUTION', 'MATCH', ?, ?, ?, ?, ?, ?)`,
    [
      match.id,
      minute,
      teamId,
      playerOffId || null,
      playerOnId || null,
      desc,
      JSON.stringify({ playerOffName, playerOnName })
    ]
  );

  broadcastFootballEvent(match, {
    type: 'SUBSTITUTION',
    teamId,
    playerOffName,
    playerOnName,
    minute,
    commentary: desc
  });

  return { success: true, eventId: insertRes.insertId };
}

/**
 * 7. Undo Last Event.
 */
async function undoLastEvent(matchPublicId, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const lastEvents = await db.query(
    `SELECT * FROM sport_match_events WHERE match_id = ? ORDER BY id DESC LIMIT 1`,
    [match.id]
  );
  if (!lastEvents || lastEvents.length === 0) {
    throw { statusCode: 400, message: 'No events to undo.' };
  }

  const lastEvent = lastEvents[0];
  await db.query(`DELETE FROM sport_match_events WHERE id = ?`, [lastEvent.id]);

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  // If the undone event was a goal, decrement score
  if (lastEvent.event_type === 'GOAL') {
    const isTeamA = Number(lastEvent.team_id) === Number(match.team_a_id);
    if (isTeamA) {
      state.teamAScore = Math.max(0, (state.teamAScore || 1) - 1);
    } else {
      state.teamBScore = Math.max(0, (state.teamBScore || 1) - 1);
    }

    const scoreSummary = `${state.teamAScore} - ${state.teamBScore}`;
    await db.query(
      `UPDATE tournament_matches 
       SET team_a_score = ?, team_b_score = ?,
           live_score_summary = ?, sport_state = ?
       WHERE id = ?`,
      [state.teamAScore, state.teamBScore, scoreSummary, JSON.stringify(state), match.id]
    );
  }

  broadcastFootballEvent(match, {
    type: 'UNDO',
    undoneEventId: lastEvent.id,
    undoneEventType: lastEvent.event_type,
    scoreSummary: `${state.teamAScore || 0} - ${state.teamBScore || 0}`
  });

  return { success: true, message: 'Last event successfully undone.', state };
}

/**
 * 8. Complete Match & Finalize Tournament Standings.
 */
async function completeMatch(matchPublicId, { winnerTeamId, resultSummary }, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  const scoreA = state.teamAScore != null ? state.teamAScore : (match.team_a_score || 0);
  const scoreB = state.teamBScore != null ? state.teamBScore : (match.team_b_score || 0);

  let determinedWinnerId = winnerTeamId;
  let finalSummary = resultSummary;

  if (!finalSummary) {
    if (determinedWinnerId && Number(determinedWinnerId) === Number(match.team_a_id)) {
      finalSummary = `${match.team_a_name} won ${scoreA} - ${scoreB}`;
    } else if (determinedWinnerId && Number(determinedWinnerId) === Number(match.team_b_id)) {
      finalSummary = `${match.team_b_name} won ${scoreB} - ${scoreA}`;
    } else if (scoreA > scoreB) {
      determinedWinnerId = match.team_a_id;
      finalSummary = `${match.team_a_name} won ${scoreA} - ${scoreB}`;
    } else if (scoreB > scoreA) {
      determinedWinnerId = match.team_b_id;
      finalSummary = `${match.team_b_name} won ${scoreB} - ${scoreA}`;
    } else {
      determinedWinnerId = null;
      finalSummary = `Match Drawn ${scoreA} - ${scoreB}`;
    }
  }

  state.period = 'FULL_TIME';

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'COMPLETED',
         winner_team_id = ?,
         result_summary = ?,
         live_score_summary = ?,
         live_subtext = 'Full Time',
         period_state = 'FULL_TIME',
         sport_state = ?
     WHERE id = ?`,
    [
      determinedWinnerId || null,
      finalSummary,
      `${scoreA} - ${scoreB}`,
      JSON.stringify(state),
      match.id
    ]
  );

  // Recalculate standings for tournament
  await recalculateStandings(match.tournament_id);

  // If Knockout match, advance winner
  if (match.stage && match.stage !== 'GROUP' && determinedWinnerId) {
    const loserId = determinedWinnerId === match.team_a_id ? match.team_b_id : match.team_a_id;
    await advanceKnockoutWinner(match.id, determinedWinnerId, loserId);
  }

  // Broadcast completion
  broadcastFootballEvent(match, {
    type: 'MATCH_COMPLETED',
    status: 'COMPLETED',
    scoreSummary: `${scoreA} - ${scoreB}`,
    winnerTeamId: determinedWinnerId,
    resultSummary: finalSummary
  });

  return {
    success: true,
    message: 'Football match completed and standings recalculated.',
    winnerTeamId: determinedWinnerId,
    resultSummary: finalSummary
  };
}

/**
 * Socket.IO Broadcaster Helper for Football Events
 */
function broadcastFootballEvent(match, payload) {
  const io = getIO();
  if (!io) return;

  const matchRoom = `match:${match.uuid}`;
  const tourneyRoom = `tournament:${match.tournament_public_id}`;

  const enriched = {
    matchId: match.uuid,
    timestamp: Date.now(),
    eventSeq: payload.eventSeq || Date.now(),
    ...payload
  };

  io.to(matchRoom).emit('match:footballEvent', enriched);
  io.to(matchRoom).emit('match:ballEvent', enriched);
  io.to(matchRoom).emit('score:updated', enriched);
  io.to(matchRoom).emit('match:pointScored', enriched);

  const summaryPayload = {
    matchId: match.uuid,
    status: payload.status || match.status,
    liveScoreSummary: payload.scoreSummary || match.live_score_summary,
    liveSubtext: payload.commentary || payload.period || match.live_subtext,
    celebration: payload.celebration || null,
    eventSeq: enriched.eventSeq,
    timestamp: enriched.timestamp
  };

  io.to(tourneyRoom).emit('tournament:matchUpdated', summaryPayload);
  io.emit('signage:matchUpdate', summaryPayload);
  if (payload.celebration || payload.type === 'GOAL') {
    io.emit('signage:pointScored', enriched);
  }
}

module.exports = {
  getScorerState,
  setLineups,
  updatePeriod,
  recordGoal,
  recordCard,
  recordSubstitution,
  undoLastEvent,
  completeMatch
};
