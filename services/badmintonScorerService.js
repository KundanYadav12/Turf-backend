const db = require('../config/database');
const { broadcastTournamentMatchUpdate, getIO } = require('./socketService');
const { recalculateStandings, advanceKnockoutWinner } = require('./tournamentEngineService');

/**
 * Badminton Match Scoring and Management Service
 * Full-featured match engine adhering to BWF scoring standards:
 * - Singles & Doubles lineups
 * - Best of 3 Games (or configurable games count)
 * - 21 Target Points with Win-by-Two and 30-Point Cap
 * - Service court tracking (Even = Right, Odd = Left) & Service changes
 * - Game points, Match points, Game transitions
 * - Standings calculation & Knockout progression
 * - Undo & Corrections
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
 * 1. Get Badminton Scorer Console State.
 */
async function getScorerState(matchPublicId) {
  const match = await resolveMatch(matchPublicId);
  if (!match) return null;

  let state = {
    currentGame: 1,
    gamesToWin: 2, // Best of 3
    targetPoints: 21,
    winByTwo: true,
    maxScoreCap: 30,
    matchFormat: 'DOUBLES', // SINGLES | DOUBLES
    gameScores: [
      { game: 1, teamA: 0, teamB: 0, winner: null },
      { game: 2, teamA: 0, teamB: 0, winner: null },
      { game: 3, teamA: 0, teamB: 0, winner: null }
    ],
    gamesWonA: 0,
    gamesWonB: 0,
    currentServer: 'A', // 'A' or 'B'
    serverCourt: 'RIGHT', // 'RIGHT' (even) or 'LEFT' (odd)
    serverPlayerName: null,
    receiverPlayerName: null,
    isMatchPoint: false,
    isGamePoint: false,
    lineup: {
      teamA: [],
      teamB: []
    }
  };

  if (match.sport_state) {
    try {
      const parsed = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : match.sport_state;
      state = { ...state, ...parsed };
    } catch (e) {}
  }

  // Fetch squad rosters
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

  // Fetch event logs
  const events = await db.query(
    `SELECT * FROM sport_match_events 
     WHERE match_id = ? ORDER BY id DESC`,
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
      courtName: match.court_name || 'Court 1',
      venueName: match.venue_name || 'Badminton Arena',
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
 * 2. Set Singles or Doubles active lineup.
 */
async function setLineup(matchPublicId, { matchFormat = 'DOUBLES', teamALineup = [], teamBLineup = [] }, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  state.matchFormat = matchFormat;
  state.lineup = {
    teamA: teamALineup,
    teamB: teamBLineup
  };

  // Set initial server and receiver names
  if (teamALineup.length > 0) state.serverPlayerName = teamALineup[0].name;
  if (teamBLineup.length > 0) state.receiverPlayerName = teamBLineup[0].name;

  await db.query(
    `UPDATE tournament_matches 
     SET sport_state = ?, team_a_lineup = ?, team_b_lineup = ?
     WHERE id = ?`,
    [
      JSON.stringify(state),
      JSON.stringify(teamALineup),
      JSON.stringify(teamBLineup),
      match.id
    ]
  );

  return { success: true, message: 'Badminton lineup saved.', state };
}

/**
 * 3. Start Badminton Match Live.
 */
async function startMatch(matchPublicId, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  state.currentGame = state.currentGame || 1;
  state.currentServer = state.currentServer || 'A';
  state.serverCourt = 'RIGHT';

  const scoreSummary = `Game 1: 0 - 0`;
  const liveSubtext = `Serving: ${match.team_a_name} (Right)`;

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'LIVE',
         live_score_summary = ?,
         live_subtext = ?,
         team_a_score = 0,
         team_b_score = 0,
         sport_state = ?
     WHERE id = ?`,
    [scoreSummary, liveSubtext, JSON.stringify(state), match.id]
  );

  broadcastBadmintonEvent(match, {
    type: 'MATCH_STARTED',
    status: 'LIVE',
    scoreSummary,
    liveSubtext,
    state
  });

  return { success: true, message: 'Badminton match started live!', state };
}

/**
 * 4. Record Point (+1 Team A or +1 Team B).
 */
async function recordPoint(matchPublicId, { scoringSide = 'A', pointType = 'RALLY' }, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let state = {
    currentGame: 1,
    gamesToWin: 2,
    targetPoints: 21,
    winByTwo: true,
    maxScoreCap: 30,
    gameScores: [
      { game: 1, teamA: 0, teamB: 0, winner: null },
      { game: 2, teamA: 0, teamB: 0, winner: null },
      { game: 3, teamA: 0, teamB: 0, winner: null }
    ],
    gamesWonA: 0,
    gamesWonB: 0,
    currentServer: 'A',
    serverCourt: 'RIGHT'
  };

  try {
    if (match.sport_state) {
      const parsed = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : match.sport_state;
      state = { ...state, ...parsed };
    }
  } catch (e) {}

  const gIdx = (state.currentGame || 1) - 1;
  const currentGame = state.gameScores[gIdx] || { game: state.currentGame, teamA: 0, teamB: 0, winner: null };

  // Increment point
  if (scoringSide === 'A') {
    currentGame.teamA++;
    state.currentServer = 'A';
    // BWF rule: Even score serves from right, odd score from left
    state.serverCourt = currentGame.teamA % 2 === 0 ? 'RIGHT' : 'LEFT';
  } else {
    currentGame.teamB++;
    state.currentServer = 'B';
    state.serverCourt = currentGame.teamB % 2 === 0 ? 'RIGHT' : 'LEFT';
  }

  // Check Game Win Condition
  // Standard BWF: 21 pts, must win by 2; cap at 30 (30-29 wins)
  const target = state.targetPoints || 21;
  const cap = state.maxScoreCap || 30;
  const scoreA = currentGame.teamA;
  const scoreB = currentGame.teamB;

  let gameWinner = null;
  if (scoreA >= target || scoreB >= target) {
    if (scoreA >= cap) {
      gameWinner = 'A';
    } else if (scoreB >= cap) {
      gameWinner = 'B';
    } else if (Math.abs(scoreA - scoreB) >= 2) {
      gameWinner = scoreA > scoreB ? 'A' : 'B';
    }
  }

  // Check Game Point / Match Point flags
  state.isGamePoint = false;
  state.isMatchPoint = false;

  if (!gameWinner) {
    const isLeadA = scoreA >= target - 1 && scoreA > scoreB;
    const isLeadB = scoreB >= target - 1 && scoreB > scoreA;
    if (isLeadA || isLeadB) {
      const leader = isLeadA ? 'A' : 'B';
      const gamesWonByLeader = leader === 'A' ? state.gamesWonA : state.gamesWonB;
      if (gamesWonByLeader === (state.gamesToWin || 2) - 1) {
        state.isMatchPoint = true;
      } else {
        state.isGamePoint = true;
      }
    }
  }

  let matchCompleted = false;
  let winnerTeamId = null;
  let resultSummary = null;

  if (gameWinner) {
    currentGame.winner = gameWinner;
    if (gameWinner === 'A') {
      state.gamesWonA++;
    } else {
      state.gamesWonB++;
    }

    // Check if match won
    if (state.gamesWonA >= (state.gamesToWin || 2)) {
      matchCompleted = true;
      winnerTeamId = match.team_a_id;
      resultSummary = `${match.team_a_name} won ${state.gamesWonA} - ${state.gamesWonB}`;
    } else if (state.gamesWonB >= (state.gamesToWin || 2)) {
      matchCompleted = true;
      winnerTeamId = match.team_b_id;
      resultSummary = `${match.team_b_name} won ${state.gamesWonB} - ${state.gamesWonA}`;
    } else {
      // Advance to next game
      state.currentGame++;
      state.currentServer = gameWinner; // Winner of previous game serves first
      state.serverCourt = 'RIGHT';
    }
  }

  state.gameScores[gIdx] = currentGame;

  // Insert event log
  const scoringTeamName = scoringSide === 'A' ? match.team_a_name : match.team_b_name;
  const commentary = gameWinner
    ? `🏆 ${scoringTeamName} wins Game ${gIdx + 1} (${currentGame.teamA}-${currentGame.teamB})!`
    : `🏸 Point to ${scoringTeamName} (${currentGame.teamA}-${currentGame.teamB})`;

  await db.query(
    `INSERT INTO sport_match_events (
      match_id, sport_slug, event_type, period, team_id, commentary, payload
    ) VALUES (?, 'badminton', 'POINT', ?, ?, ?, ?)`,
    [
      match.id,
      `GAME_${gIdx + 1}`,
      scoringSide === 'A' ? match.team_a_id : match.team_b_id,
      commentary,
      JSON.stringify({ game: gIdx + 1, scoreA: currentGame.teamA, scoreB: currentGame.teamB, gameWinner })
    ]
  );

  const completedGamesStr = state.gameScores
    .filter(g => g.winner)
    .map(g => `${g.teamA}-${g.teamB}`)
    .join(', ');

  const currentScoreStr = `G${state.currentGame}: ${currentGame.teamA} - ${currentGame.teamB}`;
  const scoreSummary = completedGamesStr ? `${completedGamesStr} (${currentScoreStr})` : currentScoreStr;
  const liveSubtext = gameWinner
    ? commentary
    : `Serving: ${state.currentServer === 'A' ? match.team_a_name : match.team_b_name} (${state.serverCourt})`;

  const newStatus = matchCompleted ? 'COMPLETED' : 'LIVE';

  await db.query(
    `UPDATE tournament_matches 
     SET status = ?,
         team_a_score = ?,
         team_b_score = ?,
         live_score_summary = ?,
         live_subtext = ?,
         sport_state = ?,
         winner_team_id = ?,
         result_summary = ?
     WHERE id = ?`,
    [
      newStatus,
      state.gamesWonA,
      state.gamesWonB,
      scoreSummary,
      liveSubtext,
      JSON.stringify(state),
      winnerTeamId || match.winner_team_id || null,
      resultSummary || match.result_summary || null,
      match.id
    ]
  );

  if (matchCompleted) {
    await recalculateStandings(match.tournament_id);
    if (match.stage && match.stage !== 'GROUP' && winnerTeamId) {
      const loserId = winnerTeamId === match.team_a_id ? match.team_b_id : match.team_a_id;
      await advanceKnockoutWinner(match.id, winnerTeamId, loserId);
    }
  }

  broadcastBadmintonEvent(match, {
    type: 'POINT',
    scoringSide,
    currentGame: state.currentGame,
    scoreSummary,
    liveSubtext,
    isGamePoint: state.isGamePoint,
    isMatchPoint: state.isMatchPoint,
    status: newStatus,
    state
  });

  return {
    success: true,
    scoreSummary,
    state,
    isCompleted: matchCompleted,
    winnerTeamId,
    resultSummary
  };
}

/**
 * 5. Undo Last Point.
 */
async function undoPoint(matchPublicId, user) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const lastEvents = await db.query(
    `SELECT * FROM sport_match_events 
     WHERE match_id = ? AND event_type = 'POINT' 
     ORDER BY id DESC LIMIT 1`,
    [match.id]
  );

  if (!lastEvents || lastEvents.length === 0) {
    throw { statusCode: 400, message: 'No points to undo.' };
  }

  const lastEvent = lastEvents[0];
  await db.query(`DELETE FROM sport_match_events WHERE id = ?`, [lastEvent.id]);

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  // Recalculate state from remaining events
  const remainingEvents = await db.query(
    `SELECT * FROM sport_match_events WHERE match_id = ? AND event_type = 'POINT' ORDER BY id ASC`,
    [match.id]
  );

  // Reset games
  state.gameScores = [
    { game: 1, teamA: 0, teamB: 0, winner: null },
    { game: 2, teamA: 0, teamB: 0, winner: null },
    { game: 3, teamA: 0, teamB: 0, winner: null }
  ];
  state.gamesWonA = 0;
  state.gamesWonB = 0;
  state.currentGame = 1;

  for (const ev of remainingEvents) {
    const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
    const gIdx = (payload.game || 1) - 1;
    if (state.gameScores[gIdx]) {
      state.gameScores[gIdx].teamA = payload.scoreA;
      state.gameScores[gIdx].teamB = payload.scoreB;
      if (payload.gameWinner) {
        state.gameScores[gIdx].winner = payload.gameWinner;
        if (payload.gameWinner === 'A') state.gamesWonA++;
        else state.gamesWonB++;
        state.currentGame = Math.min(3, gIdx + 2);
      }
    }
  }

  const curG = state.gameScores[(state.currentGame || 1) - 1] || { teamA: 0, teamB: 0 };
  const scoreSummary = `G${state.currentGame}: ${curG.teamA} - ${curG.teamB}`;

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'LIVE',
         team_a_score = ?,
         team_b_score = ?,
         live_score_summary = ?,
         sport_state = ?,
         winner_team_id = NULL,
         result_summary = NULL
     WHERE id = ?`,
    [state.gamesWonA, state.gamesWonB, scoreSummary, JSON.stringify(state), match.id]
  );

  broadcastBadmintonEvent(match, {
    type: 'UNDO',
    scoreSummary,
    state
  });

  return { success: true, message: 'Point undone.', state };
}

/**
 * Socket.IO Broadcaster Helper for Badminton
 */
function broadcastBadmintonEvent(match, payload) {
  const io = getIO();
  if (!io) return;

  const matchRoom = `match:${match.uuid}`;
  const tourneyRoom = `tournament:${match.tournament_public_id}`;

  io.to(matchRoom).emit('match:badmintonEvent', payload);
  io.to(matchRoom).emit('match:ballEvent', payload);

  io.to(tourneyRoom).emit('tournament:matchUpdated', {
    matchId: match.uuid,
    status: payload.status || match.status,
    liveScoreSummary: payload.scoreSummary || match.live_score_summary,
    liveSubtext: payload.liveSubtext || match.live_subtext,
    celebration: payload.celebration || (payload.isMatchPoint ? 'MATCH_POINT' : (payload.isGamePoint ? 'GAME_POINT' : null))
  });
}

module.exports = {
  getScorerState,
  setLineup,
  startMatch,
  recordPoint,
  undoPoint
};
