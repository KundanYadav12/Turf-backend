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
 * Authoritative court and player tracking helper for BWF Badminton.
 * Strictly adheres to BWF Laws of Badminton (Sections 10 & 11):
 * - Service court parity: Even -> Right, Odd -> Left.
 * - When serving team scores: partners swap courts; same server serves from new court.
 * - When receiving team scores: service handover; neither team swaps courts; server is whoever is in court matching new score.
 */
function computeAuthoritativeBadmintonCourtState({
  format = 'DOUBLES',
  gameScoreA = 0,
  gameScoreB = 0,
  lineup = { teamA: [], teamB: [] },
  servingTeam = 'teamA',
  teamA = { name: 'Team A' },
  teamB = { name: 'Team B' },
  existingPlayerLocations = null
}) {
  const isDoubles = String(format).toUpperCase() !== 'SINGLES';
  const rawA = Array.isArray(lineup.teamA) ? lineup.teamA : [];
  const rawB = Array.isArray(lineup.teamB) ? lineup.teamB : [];

  const pA1 = typeof rawA[0] === 'string' ? rawA[0] : (rawA[0]?.name || `${teamA.name || 'Team A'} 1`);
  const pA2 = typeof rawA[1] === 'string' ? rawA[1] : (rawA[1]?.name || `${teamA.name || 'Team A'} 2`);
  const pB1 = typeof rawB[0] === 'string' ? rawB[0] : (rawB[0]?.name || `${teamB.name || 'Team B'} 1`);
  const pB2 = typeof rawB[1] === 'string' ? rawB[1] : (rawB[1]?.name || `${teamB.name || 'Team B'} 2`);

  const pA1Court = (typeof rawA[0] === 'object' && rawA[0]?.startCourt) ? String(rawA[0].startCourt).toUpperCase() : 'RIGHT';
  const pA2Court = (typeof rawA[1] === 'object' && rawA[1]?.startCourt) ? String(rawA[1].startCourt).toUpperCase() : (pA1Court === 'RIGHT' ? 'LEFT' : 'RIGHT');
  const pB1Court = (typeof rawB[0] === 'object' && rawB[0]?.startCourt) ? String(rawB[0].startCourt).toUpperCase() : 'RIGHT';
  const pB2Court = (typeof rawB[1] === 'object' && rawB[1]?.startCourt) ? String(rawB[1].startCourt).toUpperCase() : (pB1Court === 'RIGHT' ? 'LEFT' : 'RIGHT');

  let playerLocations = {};
  if (existingPlayerLocations && typeof existingPlayerLocations === 'object' && Object.keys(existingPlayerLocations).length > 0) {
    playerLocations = { ...existingPlayerLocations };
  } else if (isDoubles) {
    playerLocations[pA1] = pA1Court;
    playerLocations[pA2] = pA2Court;
    playerLocations[pB1] = pB1Court;
    playerLocations[pB2] = pB2Court;
  } else {
    playerLocations[pA1] = (gameScoreA % 2 === 0) ? 'RIGHT' : 'LEFT';
    playerLocations[pB1] = (gameScoreB % 2 === 0) ? 'RIGHT' : 'LEFT';
  }

  // Dual key by ID as well if member objects provided
  if (typeof rawA[0] === 'object' && rawA[0]?.id && playerLocations[pA1]) playerLocations[rawA[0].id] = playerLocations[pA1];
  if (typeof rawA[1] === 'object' && rawA[1]?.id && playerLocations[pA2]) playerLocations[rawA[1].id] = playerLocations[pA2];
  if (typeof rawB[0] === 'object' && rawB[0]?.id && playerLocations[pB1]) playerLocations[rawB[0].id] = playerLocations[pB1];
  if (typeof rawB[1] === 'object' && rawB[1]?.id && playerLocations[pB2]) playerLocations[rawB[1].id] = playerLocations[pB2];

  // BWF Service Court Parity: Even -> RIGHT box, Odd -> LEFT box
  const sScore = servingTeam === 'teamA' ? gameScoreA : gameScoreB;
  const serverCourt = (sScore % 2 === 0) ? 'RIGHT' : 'LEFT';
  const receiverCourt = serverCourt; // Cross-court diagonal target

  // Active server player
  const sPlayers = servingTeam === 'teamA' ? (isDoubles ? [pA1, pA2] : [pA1]) : (isDoubles ? [pB1, pB2] : [pB1]);
  const activeServer = sPlayers.find(p => (playerLocations[p] || playerLocations[p?.name] || playerLocations[p?.id]) === serverCourt) || sPlayers[0];

  // Active receiver player
  const rPlayers = servingTeam === 'teamA' ? (isDoubles ? [pB1, pB2] : [pB1]) : (isDoubles ? [pA1, pA2] : [pA1]);
  const activeReceiver = rPlayers.find(p => (playerLocations[p] || playerLocations[p?.name] || playerLocations[p?.id]) === receiverCourt) || rPlayers[0];

  // Screen box names (Assuming Team A on LEFT facing right, Team B on RIGHT facing left)
  const servingBoxName = servingTeam === 'teamA'
    ? (serverCourt === 'RIGHT' ? 'bottom-left' : 'top-left')
    : (serverCourt === 'RIGHT' ? 'top-right' : 'bottom-right');

  const targetBoxName = servingTeam === 'teamA'
    ? (receiverCourt === 'RIGHT' ? 'top-right' : 'bottom-right')
    : (receiverCourt === 'RIGHT' ? 'bottom-left' : 'top-left');

  return {
    format: isDoubles ? 'DOUBLES' : 'SINGLES',
    servingTeam,
    currentServer: servingTeam === 'teamA' ? 'A' : 'B',
    serverCourt,
    receiverCourt,
    servingBoxName,
    targetBoxName,
    serverPlayerName: typeof activeServer === 'object' ? activeServer.name : String(activeServer || ''),
    receiverPlayerName: typeof activeReceiver === 'object' ? activeReceiver.name : String(activeReceiver || ''),
    playerLocations
  };
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

  // Derive authoritative court state
  const curG = Math.max(0, (state.currentGame || 1) - 1);
  const curScoreA = state.gameScores?.[curG]?.teamA || 0;
  const curScoreB = state.gameScores?.[curG]?.teamB || 0;
  const courtState = computeAuthoritativeBadmintonCourtState({
    format: state.matchFormat || 'DOUBLES',
    gameScoreA: curScoreA,
    gameScoreB: curScoreB,
    lineup: state.lineup || { teamA: [], teamB: [] },
    servingTeam: state.servingTeam || (state.currentServer === 'B' ? 'teamB' : 'teamA'),
    teamA: { name: match.team_a_name },
    teamB: { name: match.team_b_name },
    existingPlayerLocations: state.playerLocations || null
  });

  state = {
    ...state,
    serverCourt: courtState.serverCourt,
    receiverCourt: courtState.receiverCourt,
    servingBoxName: courtState.servingBoxName,
    targetBoxName: courtState.targetBoxName,
    serverPlayerName: courtState.serverPlayerName,
    receiverPlayerName: courtState.receiverPlayerName,
    playerLocations: courtState.playerLocations,
    courtState
  };

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
async function setLineup(matchPublicId, { matchFormat = 'DOUBLES', teamALineup = [], teamBLineup = [], startingServingTeam = 'teamA' }, user) {
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

  const isB = startingServingTeam === 'teamB' || startingServingTeam === 'B';
  const initialServingTeam = isB ? 'teamB' : 'teamA';

  const courtState = computeAuthoritativeBadmintonCourtState({
    format: matchFormat,
    gameScoreA: 0,
    gameScoreB: 0,
    lineup: state.lineup,
    servingTeam: initialServingTeam,
    teamA: { name: match.team_a_name },
    teamB: { name: match.team_b_name }
  });

  state.currentServer = courtState.currentServer;
  state.servingTeam = courtState.servingTeam;
  state.startingServingTeam = courtState.servingTeam;
  state.serverCourt = courtState.serverCourt;
  state.receiverCourt = courtState.receiverCourt;
  state.servingBoxName = courtState.servingBoxName;
  state.targetBoxName = courtState.targetBoxName;
  state.serverPlayerName = courtState.serverPlayerName;
  state.receiverPlayerName = courtState.receiverPlayerName;
  state.playerLocations = courtState.playerLocations;
  state.courtState = courtState;

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
async function startMatch(matchPublicId, reqBodyOrUser, maybeUser) {
  const match = await resolveMatch(matchPublicId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  if (match.status === 'LIVE') {
    let currentState = {};
    try {
      currentState = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
    } catch (_) {}
    return { success: true, message: 'Badminton match is already live.', state: currentState };
  }

  let state = {};
  try {
    state = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
  } catch (e) {}

  const reqBody = (reqBodyOrUser && typeof reqBodyOrUser === 'object' && !reqBodyOrUser.role) ? reqBodyOrUser : {};
  const startingServingTeam = reqBody.startingServingTeam || state.startingServingTeam || state.servingTeam || (state.currentServer === 'B' ? 'teamB' : 'teamA');
  const isB = startingServingTeam === 'teamB' || startingServingTeam === 'B';
  const initialServingTeam = isB ? 'teamB' : 'teamA';

  state.currentGame = state.currentGame || 1;
  const courtState = computeAuthoritativeBadmintonCourtState({
    format: state.matchFormat || 'DOUBLES',
    gameScoreA: 0,
    gameScoreB: 0,
    lineup: state.lineup || { teamA: [], teamB: [] },
    servingTeam: initialServingTeam,
    teamA: { name: match.team_a_name },
    teamB: { name: match.team_b_name },
    existingPlayerLocations: state.playerLocations || null
  });

  state.currentServer = courtState.currentServer;
  state.servingTeam = courtState.servingTeam;
  state.startingServingTeam = courtState.servingTeam;
  state.serverCourt = courtState.serverCourt;
  state.receiverCourt = courtState.receiverCourt;
  state.servingBoxName = courtState.servingBoxName;
  state.targetBoxName = courtState.targetBoxName;
  state.serverPlayerName = courtState.serverPlayerName;
  state.receiverPlayerName = courtState.receiverPlayerName;
  state.playerLocations = courtState.playerLocations;
  state.courtState = courtState;

  const scoreSummary = `Game 1: 0 - 0`;
  const serverTeamName = isB ? match.team_b_name : match.team_a_name;
  const liveSubtext = `Serving: ${serverTeamName} (Right)`;

  state.eventSeq = 1;

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
    state,
    eventSeq: state.eventSeq
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

  const prevServingSide = state.currentServer || (state.servingTeam === 'teamB' ? 'B' : 'A');
  const isServingTeamWinner = prevServingSide === scoringSide;

  // Extract players
  const isDoubles = String(state.matchFormat || 'DOUBLES').toUpperCase() !== 'SINGLES';
  const rawA = Array.isArray(state.lineup?.teamA) ? state.lineup.teamA : [];
  const rawB = Array.isArray(state.lineup?.teamB) ? state.lineup.teamB : [];
  const pA1 = typeof rawA[0] === 'string' ? rawA[0] : (rawA[0]?.name || `${match.team_a_name} 1`);
  const pA2 = typeof rawA[1] === 'string' ? rawA[1] : (rawA[1]?.name || `${match.team_a_name} 2`);
  const pB1 = typeof rawB[0] === 'string' ? rawB[0] : (rawB[0]?.name || `${match.team_b_name} 1`);
  const pB2 = typeof rawB[1] === 'string' ? rawB[1] : (rawB[1]?.name || `${match.team_b_name} 2`);

  let nextLocations = { ...(state.playerLocations || {}) };
  if (!nextLocations[pA1]) {
    nextLocations[pA1] = (typeof rawA[0] === 'object' && rawA[0]?.startCourt) ? String(rawA[0].startCourt).toUpperCase() : 'RIGHT';
    if (isDoubles) nextLocations[pA2] = (typeof rawA[1] === 'object' && rawA[1]?.startCourt) ? String(rawA[1].startCourt).toUpperCase() : (nextLocations[pA1] === 'RIGHT' ? 'LEFT' : 'RIGHT');
    nextLocations[pB1] = (typeof rawB[0] === 'object' && rawB[0]?.startCourt) ? String(rawB[0].startCourt).toUpperCase() : 'RIGHT';
    if (isDoubles) nextLocations[pB2] = (typeof rawB[1] === 'object' && rawB[1]?.startCourt) ? String(rawB[1].startCourt).toUpperCase() : (nextLocations[pB1] === 'RIGHT' ? 'LEFT' : 'RIGHT');
  }

  // Increment point
  if (scoringSide === 'A') {
    currentGame.teamA++;
  } else {
    currentGame.teamB++;
  }

  // BWF Doubles Rotation Rules:
  // 1. If serving team wins rally: Serving team partners SWAP courts (Right <-> Left). Same server serves from new court. Receiving team DOES NOT swap!
  // 2. If receiving team wins rally: Service transfers to receiving team. NEITHER TEAM SWAPS! Server is whoever is in the court matching new score.
  let nextServingTeam = prevServingSide === 'A' ? 'teamA' : 'teamB';
  if (isServingTeamWinner) {
    if (isDoubles) {
      const sP1 = prevServingSide === 'A' ? pA1 : pB1;
      const sP2 = prevServingSide === 'A' ? pA2 : pB2;
      const loc1 = nextLocations[sP1] || 'RIGHT';
      const loc2 = nextLocations[sP2] || 'LEFT';
      nextLocations[sP1] = loc2;
      nextLocations[sP2] = loc1;
    }
  } else {
    nextServingTeam = scoringSide === 'A' ? 'teamA' : 'teamB';
  }

  if (!isDoubles) {
    nextLocations[pA1] = (currentGame.teamA % 2 === 0) ? 'RIGHT' : 'LEFT';
    nextLocations[pB1] = (currentGame.teamB % 2 === 0) ? 'RIGHT' : 'LEFT';
  }

  // Dual-key nextLocations by ID
  if (typeof rawA[0] === 'object' && rawA[0]?.id && nextLocations[pA1]) nextLocations[rawA[0].id] = nextLocations[pA1];
  if (typeof rawA[1] === 'object' && rawA[1]?.id && nextLocations[pA2]) nextLocations[rawA[1].id] = nextLocations[pA2];
  if (typeof rawB[0] === 'object' && rawB[0]?.id && nextLocations[pB1]) nextLocations[rawB[0].id] = nextLocations[pB1];
  if (typeof rawB[1] === 'object' && rawB[1]?.id && nextLocations[pB2]) nextLocations[rawB[1].id] = nextLocations[pB2];

  let nextCourtState = computeAuthoritativeBadmintonCourtState({
    format: state.matchFormat || 'DOUBLES',
    gameScoreA: currentGame.teamA,
    gameScoreB: currentGame.teamB,
    lineup: state.lineup || { teamA: [], teamB: [] },
    servingTeam: nextServingTeam,
    teamA: { name: match.team_a_name },
    teamB: { name: match.team_b_name },
    existingPlayerLocations: nextLocations
  });

  state.currentServer = nextCourtState.currentServer;
  state.servingTeam = nextCourtState.servingTeam;
  state.serverSide = state.currentServer;
  state.serverCourt = nextCourtState.serverCourt;
  state.receiverCourt = nextCourtState.receiverCourt;
  state.servingBoxName = nextCourtState.servingBoxName;
  state.targetBoxName = nextCourtState.targetBoxName;
  state.serverPlayerName = nextCourtState.serverPlayerName;
  state.receiverPlayerName = nextCourtState.receiverPlayerName;
  state.playerLocations = nextCourtState.playerLocations;
  state.courtState = nextCourtState;

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
      state.servingTeam = gameWinner === 'A' ? 'teamA' : 'teamB';
      const resetCourtState = computeAuthoritativeBadmintonCourtState({
        format: state.matchFormat || 'DOUBLES',
        gameScoreA: 0,
        gameScoreB: 0,
        lineup: state.lineup || { teamA: [], teamB: [] },
        servingTeam: state.servingTeam,
        teamA: { name: match.team_a_name },
        teamB: { name: match.team_b_name }
      });
      state.serverCourt = resetCourtState.serverCourt;
      state.receiverCourt = resetCourtState.receiverCourt;
      state.servingBoxName = resetCourtState.servingBoxName;
      state.targetBoxName = resetCourtState.targetBoxName;
      state.serverPlayerName = resetCourtState.serverPlayerName;
      state.receiverPlayerName = resetCourtState.receiverPlayerName;
      state.playerLocations = resetCourtState.playerLocations;
      state.courtState = resetCourtState;
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
      JSON.stringify({
        game: gIdx + 1,
        scoringSide,
        scoringTeam: scoringSide === 'A' ? 'teamA' : 'teamB',
        scoreA: currentGame.teamA,
        scoreB: currentGame.teamB,
        gameWinner,
        playerLocations: state.playerLocations,
        currentServer: state.currentServer,
        serverCourt: state.serverCourt
      })
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

  state.eventSeq = (state.eventSeq || 0) + 1;

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
    state,
    eventSeq: state.eventSeq
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
  const initServingTeam = state.startingServingTeam || 'teamA';
  let curServingSide = initServingTeam === 'teamB' ? 'B' : 'A';

  const isDoubles = String(state.matchFormat || 'DOUBLES').toUpperCase() !== 'SINGLES';
  const rawA = Array.isArray(state.lineup?.teamA) ? state.lineup.teamA : [];
  const rawB = Array.isArray(state.lineup?.teamB) ? state.lineup.teamB : [];
  const pA1 = typeof rawA[0] === 'string' ? rawA[0] : (rawA[0]?.name || `${match.team_a_name} 1`);
  const pA2 = typeof rawA[1] === 'string' ? rawA[1] : (rawA[1]?.name || `${match.team_a_name} 2`);
  const pB1 = typeof rawB[0] === 'string' ? rawB[0] : (rawB[0]?.name || `${match.team_b_name} 1`);
  const pB2 = typeof rawB[1] === 'string' ? rawB[1] : (rawB[1]?.name || `${match.team_b_name} 2`);

  let replayLocations = {};
  const resetLocations = () => {
    replayLocations[pA1] = (typeof rawA[0] === 'object' && rawA[0]?.startCourt) ? String(rawA[0].startCourt).toUpperCase() : 'RIGHT';
    if (isDoubles) replayLocations[pA2] = (typeof rawA[1] === 'object' && rawA[1]?.startCourt) ? String(rawA[1].startCourt).toUpperCase() : (replayLocations[pA1] === 'RIGHT' ? 'LEFT' : 'RIGHT');
    replayLocations[pB1] = (typeof rawB[0] === 'object' && rawB[0]?.startCourt) ? String(rawB[0].startCourt).toUpperCase() : 'RIGHT';
    if (isDoubles) replayLocations[pB2] = (typeof rawB[1] === 'object' && rawB[1]?.startCourt) ? String(rawB[1].startCourt).toUpperCase() : (replayLocations[pB1] === 'RIGHT' ? 'LEFT' : 'RIGHT');
  };
  resetLocations();

  for (const ev of remainingEvents) {
    const payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
    const gIdx = (payload.game || 1) - 1;
    const evScoringSide = payload.scoringSide || (ev.team_id === match.team_a_id ? 'A' : 'B');
    const isServingWinner = curServingSide === evScoringSide;

    if (payload.playerLocations) {
      replayLocations = { ...payload.playerLocations };
    } else {
      if (isServingWinner) {
        if (isDoubles) {
          const sP1 = curServingSide === 'A' ? pA1 : pB1;
          const sP2 = curServingSide === 'A' ? pA2 : pB2;
          const loc1 = replayLocations[sP1] || 'RIGHT';
          const loc2 = replayLocations[sP2] || 'LEFT';
          replayLocations[sP1] = loc2;
          replayLocations[sP2] = loc1;
        }
      }
    }

    curServingSide = evScoringSide;

    if (state.gameScores[gIdx]) {
      state.gameScores[gIdx].teamA = payload.scoreA;
      state.gameScores[gIdx].teamB = payload.scoreB;
      if (payload.gameWinner) {
        state.gameScores[gIdx].winner = payload.gameWinner;
        if (payload.gameWinner === 'A') state.gamesWonA++;
        else state.gamesWonB++;
        state.currentGame = Math.min(3, gIdx + 2);
        curServingSide = payload.gameWinner;
        resetLocations();
      }
    }
  }

  const curG = (state.currentGame || 1) - 1;
  const curScoreA = state.gameScores[curG]?.teamA || 0;
  const curScoreB = state.gameScores[curG]?.teamB || 0;

  // Dual-key replayLocations by ID
  if (typeof rawA[0] === 'object' && rawA[0]?.id && replayLocations[pA1]) replayLocations[rawA[0].id] = replayLocations[pA1];
  if (typeof rawA[1] === 'object' && rawA[1]?.id && replayLocations[pA2]) replayLocations[rawA[1].id] = replayLocations[pA2];
  if (typeof rawB[0] === 'object' && rawB[0]?.id && replayLocations[pB1]) replayLocations[rawB[0].id] = replayLocations[pB1];
  if (typeof rawB[1] === 'object' && rawB[1]?.id && replayLocations[pB2]) replayLocations[rawB[1].id] = replayLocations[pB2];

  const finalCourtState = computeAuthoritativeBadmintonCourtState({
    format: state.matchFormat || 'DOUBLES',
    gameScoreA: curScoreA,
    gameScoreB: curScoreB,
    lineup: state.lineup || { teamA: [], teamB: [] },
    servingTeam: curServingSide === 'A' ? 'teamA' : 'teamB',
    teamA: { name: match.team_a_name },
    teamB: { name: match.team_b_name },
    existingPlayerLocations: replayLocations
  });

  state.currentServer = finalCourtState.currentServer;
  state.servingTeam = finalCourtState.servingTeam;
  state.serverSide = state.currentServer;
  state.serverCourt = finalCourtState.serverCourt;
  state.receiverCourt = finalCourtState.receiverCourt;
  state.servingBoxName = finalCourtState.servingBoxName;
  state.targetBoxName = finalCourtState.targetBoxName;
  state.serverPlayerName = finalCourtState.serverPlayerName;
  state.receiverPlayerName = finalCourtState.receiverPlayerName;
  state.playerLocations = finalCourtState.playerLocations;
  state.courtState = finalCourtState;

  // Re-evaluate game point / match point flags
  const target = state.targetPoints || 21;
  const isLeadA = curG.teamA >= target - 1 && curG.teamA > curG.teamB;
  const isLeadB = curG.teamB >= target - 1 && curG.teamB > curG.teamA;
  state.isGamePoint = false;
  state.isMatchPoint = false;
  if (isLeadA || isLeadB) {
    const leader = isLeadA ? 'A' : 'B';
    const gamesWonByLeader = leader === 'A' ? state.gamesWonA : state.gamesWonB;
    if (gamesWonByLeader === (state.gamesToWin || 2) - 1) {
      state.isMatchPoint = true;
    } else {
      state.isGamePoint = true;
    }
  }

  const completedGamesStr = state.gameScores
    .filter(g => g.winner)
    .map(g => `${g.teamA}-${g.teamB}`)
    .join(', ');

  const currentScoreStr = `G${state.currentGame}: ${curG.teamA} - ${curG.teamB}`;
  const scoreSummary = completedGamesStr ? `${completedGamesStr} (${currentScoreStr})` : currentScoreStr;
  const liveSubtext = `Serving: ${state.currentServer === 'A' ? match.team_a_name : match.team_b_name} (${state.serverCourt})`;

  state.eventSeq = (state.eventSeq || 0) + 1;

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'LIVE',
         team_a_score = ?,
         team_b_score = ?,
         live_score_summary = ?,
         live_subtext = ?,
         sport_state = ?,
         winner_team_id = NULL,
         result_summary = NULL
     WHERE id = ?`,
    [state.gamesWonA, state.gamesWonB, scoreSummary, liveSubtext, JSON.stringify(state), match.id]
  );

  broadcastBadmintonEvent(match, {
    type: 'UNDO',
    scoreSummary,
    liveSubtext,
    state,
    eventSeq: state.eventSeq,
    scoringSide: null
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

  const eventSeq = payload.eventSeq || (payload.state?.eventSeq || Date.now());
  const enrichedPayload = {
    matchId: match.uuid,
    eventSeq,
    timestamp: Date.now(),
    ...payload
  };

  io.to(matchRoom).emit('match:badmintonEvent', enrichedPayload);
  io.to(matchRoom).emit('match:badmintonPoint', enrichedPayload);
  io.to(matchRoom).emit('match:ballEvent', enrichedPayload);
  io.to(matchRoom).emit('score:updated', enrichedPayload);
  io.to(matchRoom).emit('match:pointScored', enrichedPayload);
  io.emit('signage:pointScored', enrichedPayload);

  const summaryPayload = {
    matchId: match.uuid,
    status: payload.status || match.status,
    liveScoreSummary: payload.scoreSummary || match.live_score_summary,
    liveSubtext: payload.liveSubtext || match.live_subtext,
    state: payload.state,
    eventSeq,
    type: payload.type || 'POINT',
    scoringSide: payload.scoringSide,
    celebration: payload.celebration || (payload.isMatchPoint ? 'MATCH_POINT' : (payload.isGamePoint ? 'GAME_POINT' : null)),
    timestamp: enrichedPayload.timestamp
  };

  io.to(tourneyRoom).emit('tournament:matchUpdated', summaryPayload);
  io.emit('signage:matchUpdate', summaryPayload);
}

module.exports = {
  getScorerState,
  setLineup,
  startMatch,
  recordPoint,
  undoPoint,
  computeAuthoritativeBadmintonCourtState
};
