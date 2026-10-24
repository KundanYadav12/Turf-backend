const db = require('../config/database');
const { broadcastTournamentMatchUpdate, broadcastMatchBallEvent, getIO } = require('./socketService');

/**
 * Validates whether the authenticated user has permission to score the match.
 * ADMIN: Global access.
 * VENUE_OWNER: Allowed if match is at their venue or in their tournament.
 * SCORER: Allowed if explicitly assigned (tm.scorer_id = userId).
 */
const checkScorerAuthorization = async (userId, userRole, matchInternalId) => {
  const roleUpper = String(userRole || '').toUpperCase();
  if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') return true;
  const { checkUserCanScoreMatch } = require('./scorerAccessService');
  return await checkUserCanScoreMatch({ userId, userRole, matchPublicOrInternalId: matchInternalId });
};

/**
 * Helper to fetch internal match ID from UUID or integer ID.
 */
const resolveMatchId = async (publicOrInternalId) => {
  const rows = await db.query(
    'SELECT id, uuid, tournament_id, status FROM tournament_matches WHERE uuid = ? OR id = ?',
    [publicOrInternalId, isNaN(publicOrInternalId) ? -1 : parseInt(publicOrInternalId, 10)]
  );
  if (!rows || rows.length === 0) return null;
  return rows[0];
};

/**
 * 1. GET Scorer Initial State & Configuration
 */
const getScorerState = async (matchPublicId) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) return null;
  const matchId = matchInfo.id;

  // Match details with tournament and teams
  const [m] = await db.query(
    `SELECT tm.id, tm.uuid as public_id, tm.match_number, tm.status, tm.scorer_id,
            tm.live_score_summary, tm.live_subtext, tm.sport_state, tm.result_summary,
            t.id as tournament_id, t.uuid as tournament_public_id, t.name as tournament_name,
            c.name as court_name, v.name as venue_name, v.city as venue_city,
            ta.id as team_a_id, ta.uuid as team_a_public_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
            tb.id as team_b_id, tb.uuid as team_b_public_id, tb.name as team_b_name, tb.logo_url as team_b_logo
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     LEFT JOIN courts c ON tm.court_id = c.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tm.id = ?`,
    [matchId]
  );

  // Cricket match record (toss, overs, current innings)
  let [cm] = await db.query('SELECT * FROM cricket_matches WHERE match_id = ?', [matchId]);
  if (!cm) {
    // Auto-create default cricket match record if missing
    await db.query(
      `INSERT INTO cricket_matches (match_id, total_overs, target_runs) VALUES (?, 20, NULL)`,
      [matchId]
    );
    const [createdCm] = await db.query('SELECT * FROM cricket_matches WHERE match_id = ?', [matchId]);
    cm = createdCm;
  }

  // Active innings
  let currentInnings = null;
  if (cm.current_innings_id) {
    const [inn] = await db.query('SELECT * FROM cricket_innings WHERE id = ?', [cm.current_innings_id]);
    currentInnings = inn || null;
  }

  // Fetch team players for both sides
  const playersA = await db.query(
    `SELECT tm.id as member_id, tm.role, tm.jersey_number, u.id as user_id, u.full_name as name, u.profile_photo
     FROM team_members tm
     JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [m.team_a_id]
  );

  const playersB = await db.query(
    `SELECT tm.id as member_id, tm.role, tm.jersey_number, u.id as user_id, u.full_name as name, u.profile_photo
     FROM team_members tm
     JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [m.team_b_id]
  );

  // Parse cached sport_state
  let state = {};
  try {
    state = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {
    state = {};
  }

  // Calculate or reconstruct current match state
  const matchObj = {
    id: m.public_id,
    uuid: m.public_id,
    internalId: m.id,
    matchNumber: m.match_number,
    match_number: m.match_number,
    status: m.status,
    tournament_id: m.tournament_public_id,
    tournament_name: m.tournament_name,
    tournament: {
      id: m.tournament_public_id,
      name: m.tournament_name
    },
    venue: {
      court: m.court_name,
      name: m.venue_name,
      city: m.venue_city
    },
    teamA: {
      id: m.team_a_public_id,
      internalId: m.team_a_id,
      name: m.team_a_name,
      logo: m.team_a_logo,
      players: playersA
    },
    teamB: {
      id: m.team_b_public_id,
      internalId: m.team_b_id,
      name: m.team_b_name,
      logo: m.team_b_logo,
      players: playersB
    },
    team_a_id: m.team_a_id,
    team_b_id: m.team_b_id,
    team_a_name: m.team_a_name,
    team_b_name: m.team_b_name,
    overs_per_side: cm.total_overs || 20,
    totalOvers: cm.total_overs || 20,
    targetRuns: cm.target_runs || state.target || null,
    currentInningsNumber: currentInnings ? currentInnings.innings_number : 1,
    battingTeamId: currentInnings ? currentInnings.batting_team_id : null,
    bowlingTeamId: currentInnings ? currentInnings.bowling_team_id : null,
    toss: cm.toss_winner_team_id ? {
      winnerTeamId: cm.toss_winner_team_id,
      decision: cm.toss_decision
    } : null,
    live_score_summary: m.live_score_summary,
    live_subtext: m.live_subtext,
    result_summary: m.result_summary,
    resultSummary: m.result_summary,
    sport_state: state
  };

  const battingTeamName = state.battingTeamName || (currentInnings?.batting_team_id === m.team_b_id ? m.team_b_name : m.team_a_name);

  // Active innings summary
  const inningsObj = (currentInnings || state.battingTeamId) ? {
    id: currentInnings ? currentInnings.id : cm.current_innings_id,
    innings_number: currentInnings ? currentInnings.innings_number : (state.innings || 1),
    batting_team_id: currentInnings ? currentInnings.batting_team_id : state.battingTeamId,
    batting_team_name: battingTeamName,
    bowling_team_id: currentInnings ? currentInnings.bowling_team_id : state.bowlingTeamId,
    runs: state.totalRuns !== undefined ? state.totalRuns : (currentInnings?.total_runs || 0),
    wickets: state.wickets !== undefined ? state.wickets : (currentInnings?.total_wickets || 0),
    balls: (Math.floor(parseFloat(state.overs || 0)) * 6) + Math.round((parseFloat(state.overs || 0) % 1) * 10),
    overs: state.overs || '0.0'
  } : null;

  // Active striker & non-striker
  const strikerObj = state.striker ? {
    id: state.striker.id,
    name: state.striker.name || state.striker.player_name || 'Striker',
    player_name: state.striker.name || state.striker.player_name || 'Striker',
    runs: state.striker.runs || 0,
    balls: state.striker.balls || 0,
    balls_faced: state.striker.balls || 0,
    fours: state.striker.fours || 0,
    sixes: state.striker.sixes || 0,
    strikeRate: state.striker.strikeRate !== undefined ? state.striker.strikeRate : (state.striker.balls > 0 ? parseFloat(((state.striker.runs / state.striker.balls) * 100).toFixed(1)) : 0.0)
  } : null;

  const nonStrikerObj = state.nonStriker ? {
    id: state.nonStriker.id,
    name: state.nonStriker.name || state.nonStriker.player_name || 'Non-Striker',
    player_name: state.nonStriker.name || state.nonStriker.player_name || 'Non-Striker',
    runs: state.nonStriker.runs || 0,
    balls: state.nonStriker.balls || 0,
    balls_faced: state.nonStriker.balls || 0,
    fours: state.nonStriker.fours || 0,
    sixes: state.nonStriker.sixes || 0,
    strikeRate: state.nonStriker.strikeRate !== undefined ? state.nonStriker.strikeRate : (state.nonStriker.balls > 0 ? parseFloat(((state.nonStriker.runs / state.nonStriker.balls) * 100).toFixed(1)) : 0.0)
  } : null;

  // Active bowler
  const currentBowlerObj = state.bowler ? {
    id: state.bowler.id,
    name: state.bowler.name || state.bowler.player_name || 'Bowler',
    player_name: state.bowler.name || state.bowler.player_name || 'Bowler',
    runs: state.bowler.runs || 0,
    runs_conceded: state.bowler.runs || 0,
    overs: state.bowler.overs || '0.0',
    overs_bowled: state.bowler.overs || '0.0',
    wickets: state.bowler.wickets || 0,
    maidens: state.bowler.maidens || 0,
    economy: state.bowler.economy !== undefined ? state.bowler.economy : 0.0
  } : null;

  // Over completion flag
  const overCompleted = Boolean(state.legalBallsInOver >= 6);

  // Current over balls
  let currentOverBallsList = [];
  if (state.currentOverId) {
    const overBalls = await db.query(
      `SELECT id, ball_number, runs_scored as runs, is_wicket, is_wide, is_no_ball, is_bye, is_leg_bye, extra_runs
       FROM cricket_balls
       WHERE over_id = ?
       ORDER BY id ASC`,
      [state.currentOverId]
    );
    if (overBalls && overBalls.length > 0) {
      currentOverBallsList = overBalls.map(b => ({
        id: b.id,
        ball_number: b.ball_number,
        runs: b.runs,
        is_wicket: Boolean(b.is_wicket),
        extra_type: b.is_wide ? 'WIDE' : b.is_no_ball ? 'NO_BALL' : b.is_bye ? 'BYE' : b.is_leg_bye ? 'LEG_BYE' : 'NONE',
        extra_runs: b.extra_runs || 0
      }));
    }
  }

  // Fallback to state.currentOverBalls if table query had no rows
  if (currentOverBallsList.length === 0 && Array.isArray(state.currentOverBalls) && state.currentOverBalls.length > 0) {
    currentOverBallsList = state.currentOverBalls.map((b, idx) => {
      if (typeof b === 'object' && b !== null) return b;
      const str = String(b);
      const isWicket = str === 'W';
      const isWide = str.includes('Wd');
      const isNoBall = str.includes('Nb');
      const runsNum = parseInt(str.replace(/\D/g, '') || '0', 10);
      return {
        id: idx + 1,
        runs: isWide ? 0 : runsNum,
        is_wicket: isWicket,
        extra_type: isWide ? 'WIDE' : isNoBall ? 'NO_BALL' : 'NONE',
        extra_runs: isWide ? runsNum : 0
      };
    });
  }

  // Recent balls commentary stream
  const recentBallsRaw = await db.query(
    `SELECT cb.id, co.over_number, cb.ball_number, cb.runs_scored as runs, cb.is_wicket, cb.commentary,
            u_bowler.full_name as bowler_name, u_striker.full_name as striker_name
     FROM cricket_balls cb
     JOIN cricket_overs co ON cb.over_id = co.id
     LEFT JOIN users u_bowler ON cb.bowler_id = u_bowler.id
     LEFT JOIN users u_striker ON cb.striker_id = u_striker.id
     WHERE cb.match_id = ?
     ORDER BY cb.id DESC
     LIMIT 30`,
    [matchId]
  );

  // Batting roster
  const battingRoster = (state.battersList || []).map(b => ({
    id: b.id,
    name: b.name || b.player_name,
    player_name: b.name || b.player_name,
    runs: b.runs || 0,
    balls: b.balls || b.balls_faced || 0,
    balls_faced: b.balls || b.balls_faced || 0,
    fours: b.fours || 0,
    sixes: b.sixes || 0,
    is_out: Boolean(b.isOut),
    dismissal: b.dismissal || (b.isOut ? 'Out' : 'Not Out')
  }));

  // Bowling roster
  const bowlingRoster = (state.bowlersList || []).map(b => ({
    id: b.id,
    name: b.name || b.player_name,
    player_name: b.name || b.player_name,
    overs: b.overs || b.overs_bowled || '0.0',
    overs_bowled: b.overs || b.overs_bowled || '0.0',
    maidens: b.maidens || 0,
    runs: b.runs || b.runs_conceded || 0,
    runs_conceded: b.runs || b.runs_conceded || 0,
    wickets: b.wickets || 0,
    economy: b.economy || 0.0
  }));

  // Fall of wickets
  const fallOfWickets = state.fallOfWickets || [];

  // Eligible batters (players of batting team who have not batted yet)
  const battingPlayers = (state.battingTeamId === m.team_a_id ? playersA : playersB) || [];
  const activeBattersSet = new Set([
    state.striker?.id,
    state.nonStriker?.id,
    ...(state.battersList || []).filter(b => b.isOut).map(b => b.id)
  ]);
  const eligibleBatters = battingPlayers
    .filter(p => !activeBattersSet.has(p.user_id))
    .map(p => ({
      id: p.user_id,
      name: p.name,
      player_name: p.name
    }));

  return {
    match: matchObj,
    teamA: matchObj.teamA,
    teamB: matchObj.teamB,
    currentInnings: inningsObj,
    striker: strikerObj,
    nonStriker: nonStrikerObj,
    currentBowler: currentBowlerObj,
    currentOverBalls: currentOverBallsList,
    overCompleted,
    recentBalls: recentBallsRaw || [],
    battingRoster,
    bowlingRoster,
    fallOfWickets,
    eligibleBatters,
    live: state
  };
};

/**
 * 2. Setup Toss & Match Configuration
 */
const setupToss = async ({
  matchPublicId,
  tossWinnerTeamId,
  tossDecision, // 'BAT' | 'BOWL'
  totalOvers = 20,
  strikerId,
  nonStrikerId,
  bowlerId,
  userId,
  userRole
}) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized: You do not have permission to score this match.' };

  return await db.transaction(async (conn) => {
    // Determine batting & bowling teams
    const [mRows] = await conn.query('SELECT team_a_id, team_b_id FROM tournament_matches WHERE id = ?', [matchInfo.id]);
    const m = mRows[0];
    const tossWinner = parseInt(tossWinnerTeamId, 10);
    const otherTeam = tossWinner === m.team_a_id ? m.team_b_id : m.team_a_id;
    const battingTeamId = tossDecision === 'BAT' ? tossWinner : otherTeam;
    const bowlingTeamId = tossDecision === 'BAT' ? otherTeam : tossWinner;

    // Create 1st Innings
    const [innResult] = await conn.query(
      `INSERT INTO cricket_innings (match_id, innings_number, batting_team_id, bowling_team_id, total_runs, total_wickets, total_overs_bowled, is_completed)
       VALUES (?, 1, ?, ?, 0, 0, 0.0, 0)`,
      [matchInfo.id, battingTeamId, bowlingTeamId]
    );
    const inningsId = innResult.insertId;

    // Create 1st Over
    const [overResult] = await conn.query(
      `INSERT INTO cricket_overs (innings_id, over_number, bowler_id, total_runs, wickets_in_over)
       VALUES (?, 1, ?, 0, 0)`,
      [inningsId, bowlerId]
    );

    // Update cricket_matches
    await conn.query(
      `UPDATE cricket_matches 
       SET toss_winner_team_id = ?,
           toss_decision = ?,
           total_overs = ?,
           current_innings_id = ?,
           striker_id = ?,
           non_striker_id = ?,
           current_bowler_id = ?
       WHERE match_id = ?`,
      [tossWinner, tossDecision, totalOvers, inningsId, strikerId, nonStrikerId, bowlerId, matchInfo.id]
    );

    // Fetch player names for state
    const [strikerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [strikerId]);
    const [nonStrikerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [nonStrikerId]);
    const [bowlerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [bowlerId]);
    const [batTeamRows] = await conn.query('SELECT name FROM teams WHERE id = ?', [battingTeamId]);

    const striker = strikerRows[0];
    const nonStriker = nonStrikerRows[0];
    const bowler = bowlerRows[0];
    const batTeam = batTeamRows[0];

    const initialSportState = {
      innings: 1,
      battingTeamId,
      battingTeamName: batTeam.name,
      bowlingTeamId,
      totalRuns: 0,
      wickets: 0,
      overs: 0.0,
      legalBallsInOver: 0,
      overNumber: 1,
      currentOverId: overResult.insertId,
      striker: {
        id: striker.id,
        name: striker.full_name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        strikeRate: 0.0
      },
      nonStriker: {
        id: nonStriker.id,
        name: nonStriker.full_name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        strikeRate: 0.0
      },
      bowler: {
        id: bowler.id,
        name: bowler.full_name,
        overs: '0.0',
        maidens: 0,
        runs: 0,
        wickets: 0,
        economy: 0.0
      },
      currentOverBalls: [],
      extras: { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0, total: 0 },
      partnership: { runs: 0, balls: 0 },
      crr: '0.00',
      rrr: null,
      target: null,
      battersList: [
        { id: striker.id, name: striker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0, isOut: false, dismissal: 'Not Out' },
        { id: nonStriker.id, name: nonStriker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0, isOut: false, dismissal: 'Not Out' }
      ],
      bowlersList: [
        { id: bowler.id, name: bowler.full_name, overs: '0.0', maidens: 0, runs: 0, wickets: 0, economy: 0.0 }
      ],
      fallOfWickets: []
    };

    const initialSummary = '0/0 (0.0 ov)';
    const initialSubtext = `${batTeam.name} elected to ${tossDecision.toLowerCase()} first`;

    // Update tournament_matches status to LIVE
    await conn.query(
      `UPDATE tournament_matches 
       SET status = 'LIVE',
           live_score_summary = ?,
           live_subtext = ?,
           sport_state = ?
       WHERE id = ?`,
      [initialSummary, initialSubtext, JSON.stringify(initialSportState), matchInfo.id]
    );

    // Broadcast setup to rooms
    const io = getIO();
    if (io) {
      io.to(`match:${matchInfo.uuid}`).emit('match:statusChanged', {
        status: 'LIVE',
        liveScoreSummary: initialSummary,
        liveSubtext: initialSubtext,
        sportState: initialSportState
      });
    }

    return {
      success: true,
      message: 'Toss completed and 1st innings started!',
      state: initialSportState
    };
  });
};

/**
 * 3. Authoritative Cricket Delivery Calculation & Storage Engine
 */
const recordDelivery = async ({
  matchPublicId,
  runs = 0,               // 0, 1, 2, 3, 4, 6
  extraType = null,       // 'WIDE', 'NO_BALL', 'BYE', 'LEG_BYE', 'PENALTY', or null
  extraRuns = 0,          // Additional runs completed during extra (e.g. 1 wide + 2 running = 3 total)
  isWicket = false,
  wicketType = null,      // 'BOWLED', 'CAUGHT', 'LBW', 'RUN_OUT', 'STUMPED', etc.
  dismissedPlayerId = null,
  fielderId = null,
  newBatterId = null,
  commentary = null,
  userId,
  userRole
}) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  if (matchInfo.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Invalid Action: Match is already COMPLETED and cannot accept more balls.' };
  }

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized: You do not have permission to score this match.' };

  return await db.transaction(async (conn) => {
    // 1. Lock match record
    const [matches] = await conn.query(
      `SELECT tm.id, tm.uuid as public_id, tm.status, tm.tournament_id, tm.sport_state, tm.winner_team_id,
              c.total_overs, c.target_runs, c.current_innings_id, t.uuid as tournament_public_id,
              t.name as tournament_name
       FROM tournament_matches tm
       JOIN tournaments t ON tm.tournament_id = t.id
       LEFT JOIN cricket_matches c ON tm.id = c.match_id
       WHERE tm.id = ?
       FOR UPDATE`,
      [matchInfo.id]
    );

    const m = matches[0];
    let state = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
    if (!state.striker || !state.bowler) {
      throw { statusCode: 400, message: 'Match setup incomplete. Please complete Toss and Lineup setup first.' };
    }

    // Normalize state fields to ensure safety against missing/partial states
    state.totalRuns = state.totalRuns !== undefined ? state.totalRuns : (state.runs || 0);
    state.wickets = state.wickets || 0;
    state.overs = state.overs || '0.0';
    state.overNumber = state.overNumber || Math.floor(parseFloat(state.overs || 0)) + 1;
    state.legalBallsInOver = state.legalBallsInOver !== undefined ? state.legalBallsInOver : Math.round((parseFloat(state.overs || 0) % 1) * 10);

    if (!state.extras) {
      state.extras = { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0, total: 0 };
    } else {
      state.extras.wide = state.extras.wide || 0;
      state.extras.noBall = state.extras.noBall || 0;
      state.extras.bye = state.extras.bye || 0;
      state.extras.legBye = state.extras.legBye || 0;
      state.extras.penalty = state.extras.penalty || 0;
      state.extras.total = state.extras.total || 0;
    }

    if (!state.partnership) {
      state.partnership = { runs: 0, balls: 0 };
    }
    if (!Array.isArray(state.currentOverBalls)) {
      state.currentOverBalls = [];
    }
    if (!Array.isArray(state.battersList)) {
      state.battersList = [];
    }
    if (!Array.isArray(state.bowlersList)) {
      state.bowlersList = [];
    }
    if (!Array.isArray(state.fallOfWickets)) {
      state.fallOfWickets = [];
    }

    // Ensure striker, nonStriker, and bowler have all numerical fields
    state.striker = {
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      strikeRate: 0.0,
      ...(typeof state.striker === 'object' ? state.striker : { id: state.striker, name: 'Striker' })
    };
    state.nonStriker = {
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      strikeRate: 0.0,
      ...(typeof state.nonStriker === 'object' ? state.nonStriker : { id: state.nonStriker, name: 'Non-Striker' })
    };
    state.bowler = {
      runs: 0,
      wickets: 0,
      overs: '0.0',
      maidens: 0,
      economy: 0.0,
      ...(typeof state.bowler === 'object' ? state.bowler : { id: state.bowler, name: 'Bowler' })
    };

    // Ensure striker ID is resolved
    if (!state.striker.id) {
      if (state.striker.name) {
        const [u] = await conn.query('SELECT id FROM users WHERE full_name LIKE ? LIMIT 1', [`%${state.striker.name.split(' ')[0]}%`]);
        if (u.length > 0) state.striker.id = u[0].id;
      }
      if (!state.striker.id) {
        const [anyU] = await conn.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
        state.striker.id = anyU.length > 0 ? anyU[0].id : 1;
      }
    }

    // Ensure nonStriker ID is resolved
    if (!state.nonStriker.id) {
      if (state.nonStriker.name) {
        const [u] = await conn.query('SELECT id FROM users WHERE full_name LIKE ? AND id != ? LIMIT 1', [`%${state.nonStriker.name.split(' ')[0]}%`, state.striker.id]);
        if (u.length > 0) state.nonStriker.id = u[0].id;
      }
      if (!state.nonStriker.id) {
        const [anyU] = await conn.query('SELECT id FROM users WHERE id != ? ORDER BY id ASC LIMIT 1', [state.striker.id]);
        state.nonStriker.id = anyU.length > 0 ? anyU[0].id : 2;
      }
    }

    // Ensure bowler ID is resolved
    if (!state.bowler.id) {
      if (state.bowler.name) {
        const [u] = await conn.query('SELECT id FROM users WHERE full_name LIKE ? LIMIT 1', [`%${state.bowler.name.split(' ')[0]}%`]);
        if (u.length > 0) state.bowler.id = u[0].id;
      }
      if (!state.bowler.id) {
        const [anyU] = await conn.query('SELECT id FROM users WHERE id NOT IN (?, ?) ORDER BY id ASC LIMIT 1', [state.striker.id, state.nonStriker.id]);
        state.bowler.id = anyU.length > 0 ? anyU[0].id : 3;
      }
    }

    // Ensure valid current innings
    let inningsId = m.current_innings_id;
    if (!inningsId) {
      const [existingInn] = await conn.query(
        'SELECT id FROM cricket_innings WHERE match_id = ? ORDER BY innings_number DESC LIMIT 1',
        [matchInfo.id]
      );
      if (existingInn.length > 0) {
        inningsId = existingInn[0].id;
      } else {
        const battingTeamId = state.battingTeamId || matchInfo.team_a_id || 1;
        const bowlingTeamId = state.bowlingTeamId || matchInfo.team_b_id || 2;
        const [newInn] = await conn.query(
          `INSERT INTO cricket_innings (match_id, innings_number, batting_team_id, bowling_team_id, total_runs, total_wickets, total_overs_bowled, is_completed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
          [matchInfo.id, state.innings || state.currentInnings || 1, battingTeamId, bowlingTeamId, state.totalRuns || 0, state.wickets || 0, parseFloat(state.overs || 0)]
        );
        inningsId = newInn.insertId;
      }
      await conn.query('UPDATE cricket_matches SET current_innings_id = ? WHERE match_id = ?', [inningsId, matchInfo.id]);
    }

    // Ensure valid current over
    let overId = state.currentOverId;
    if (!overId) {
      const [existingOver] = await conn.query(
        'SELECT id FROM cricket_overs WHERE innings_id = ? ORDER BY over_number DESC LIMIT 1',
        [inningsId]
      );
      if (existingOver.length > 0) {
        overId = existingOver[0].id;
      } else {
        const overNum = state.overNumber || Math.floor(parseFloat(state.overs || 0)) + 1;
        const bowlerId = state.bowler?.id || 1;
        const [newOver] = await conn.query(
          `INSERT INTO cricket_overs (innings_id, over_number, bowler_id, total_runs, wickets_in_over)
           VALUES (?, ?, ?, 0, 0)`,
          [inningsId, overNum, bowlerId]
        );
        overId = newOver.insertId;
      }
      state.currentOverId = overId;
    } else {
      const [chkOver] = await conn.query('SELECT id FROM cricket_overs WHERE id = ?', [overId]);
      if (chkOver.length === 0) {
        const overNum = state.overNumber || Math.floor(parseFloat(state.overs || 0)) + 1;
        const bowlerId = state.bowler?.id || 1;
        const [newOver] = await conn.query(
          `INSERT INTO cricket_overs (innings_id, over_number, bowler_id, total_runs, wickets_in_over)
           VALUES (?, ?, ?, 0, 0)`,
          [inningsId, overNum, bowlerId]
        );
        overId = newOver.insertId;
        state.currentOverId = overId;
      }
    }

    // Guard against recording deliveries when over is already completed (6 legal balls)
    if (state.legalBallsInOver >= 6) {
      throw { statusCode: 400, message: 'This over has completed (6 legal balls). Please switch bowler before recording next delivery.' };
    }

    // 2. Determine Legal Ball, Team Runs, Bowler Runs, Batter Runs
    const isWide = extraType === 'WIDE';
    const isNoBall = extraType === 'NO_BALL';
    const isBye = extraType === 'BYE';
    const isLegBye = extraType === 'LEG_BYE';
    const isLegalBall = !isWide && !isNoBall;

    let totalBallRuns = 0;
    let batterRuns = 0;
    let bowlerRunsCharged = 0;
    let extraRunsAdded = 0;

    if (isWide) {
      // 1 penalty run for wide + extra completed runs
      const wideTotal = 1 + extraRuns;
      totalBallRuns = wideTotal;
      bowlerRunsCharged = wideTotal;
      extraRunsAdded = wideTotal;
      batterRuns = 0;
    } else if (isNoBall) {
      // 1 penalty run for no-ball + runs off the bat (or extra runs)
      const nbExtra = 1;
      batterRuns = runs;
      totalBallRuns = nbExtra + runs + extraRuns;
      bowlerRunsCharged = nbExtra + runs;
      extraRunsAdded = nbExtra + extraRuns;
    } else if (isBye || isLegBye) {
      totalBallRuns = runs + extraRuns;
      batterRuns = 0;
      bowlerRunsCharged = 0; // Bowler is not charged for byes or leg-byes per standard cricket laws
      extraRunsAdded = totalBallRuns;
    } else {
      // Clean off-the-bat delivery
      batterRuns = runs;
      totalBallRuns = runs;
      bowlerRunsCharged = runs;
      extraRunsAdded = 0;
    }

    // 3. Update Batter Stats
    state.striker.runs += batterRuns;
    if (isLegalBall) {
      state.striker.balls += 1;
    }
    if (batterRuns === 4) state.striker.fours += 1;
    if (batterRuns === 6) state.striker.sixes += 1;
    state.striker.strikeRate = state.striker.balls > 0 ? parseFloat(((state.striker.runs / state.striker.balls) * 100).toFixed(1)) : 0.0;

    // 4. Update Bowler Stats
    state.bowler.runs += bowlerRunsCharged;
    if (isWicket && !['RUN_OUT', 'RETIRED_HURT', 'RETIRED_OUT', 'OBSTRUCTING_FIELD'].includes(wicketType)) {
      state.bowler.wickets += 1;
    }

    // 5. Update Team Runs & Wickets
    state.totalRuns += totalBallRuns;
    if (isWicket) {
      state.wickets += 1;
    }

    // 6. Update Extras Breakdown
    if (isWide) state.extras.wide += totalBallRuns;
    if (isNoBall) state.extras.noBall += (1 + extraRuns);
    if (isBye) state.extras.bye += totalBallRuns;
    if (isLegBye) state.extras.legBye += totalBallRuns;
    state.extras.total += extraRunsAdded;

    // 7. Update Partnership
    state.partnership.runs += totalBallRuns;
    if (isLegalBall) {
      state.partnership.balls += 1;
    }

    // 8. Update Legal Ball Count & Overs
    let overCompleted = false;
    if (isLegalBall) {
      state.legalBallsInOver = (state.legalBallsInOver || 0) + 1;
      if (state.legalBallsInOver >= 6) {
        overCompleted = true;
      }
    }
    state.overCompleted = overCompleted;

    // Format over string (e.g. 4.2 or 5.0)
    const completedOvers = Math.max(0, Math.floor(state.overNumber - 1)) + (overCompleted ? 1 : 0);
    const currentBalls = overCompleted ? 0 : state.legalBallsInOver;
    const overDisplayNumber = completedOvers + (currentBalls > 0 ? (currentBalls / 10) : 0);
    state.overs = overDisplayNumber.toFixed(1);

    // Calculate Bowler Overs
    const bowlerLegalBalls = (Math.floor(parseFloat(state.bowler.overs || 0)) * 6) + Math.round((parseFloat(state.bowler.overs || 0) % 1) * 10) + (isLegalBall ? 1 : 0);
    const bowlerCompOvers = Math.floor(bowlerLegalBalls / 6);
    const bowlerRemBalls = bowlerLegalBalls % 6;
    state.bowler.overs = `${bowlerCompOvers}.${bowlerRemBalls}`;
    state.bowler.economy = bowlerLegalBalls > 0 ? parseFloat(((state.bowler.runs / bowlerLegalBalls) * 6).toFixed(2)) : 0.0;

    // 9. Current Over Display Ball Symbol
    let ballSymbol = '•';
    let celebrationType = null;
    if (isWicket) {
      ballSymbol = 'W';
      celebrationType = 'WICKET';
    } else if (isWide) {
      ballSymbol = extraRuns > 0 ? `${1 + extraRuns}Wd` : 'Wd';
    } else if (isNoBall) {
      ballSymbol = batterRuns > 0 ? `${1 + batterRuns}Nb` : 'Nb';
      if (batterRuns === 4) celebrationType = 'FOUR';
      if (batterRuns === 6) celebrationType = 'SIX';
    } else if (isBye) {
      ballSymbol = `${runs}B`;
    } else if (isLegBye) {
      ballSymbol = `${runs}Lb`;
    } else {
      if (runs === 0) ballSymbol = '•';
      else if (runs === 4) {
        ballSymbol = '4';
        celebrationType = 'FOUR';
      } else if (runs === 6) {
        ballSymbol = '6';
        celebrationType = 'SIX';
      } else {
        ballSymbol = `${runs}`;
      }
    }
    state.currentOverBalls.push(ballSymbol);

    // 10. Handle Wicket Dismissal & New Batter
    if (isWicket) {
      const dismissedId = dismissedPlayerId ? parseInt(dismissedPlayerId, 10) : state.striker.id;
      const isStrikerDismissed = dismissedId === state.striker.id;
      const dismissedPlayerName = isStrikerDismissed ? state.striker.name : state.nonStriker.name;

      // Add to Fall of Wickets
      state.fallOfWickets.push({
        wicket: state.wickets,
        runs: state.totalRuns,
        player: dismissedPlayerName,
        overs: state.overs
      });

      // Update batter list record
      const bIdx = state.battersList.findIndex(b => b.id === dismissedId);
      if (bIdx !== -1) {
        state.battersList[bIdx].isOut = true;
        state.battersList[bIdx].dismissal = `${wicketType || 'Out'}${fielderId ? ' c ' + fielderId : ''} b ${state.bowler.name}`;
      }

      // Reset partnership
      state.partnership = { runs: 0, balls: 0 };

      // Swap in new batter if provided
      if (newBatterId) {
        const [newBRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [newBatterId]);
        const newB = newBRows && newBRows[0];
        if (newB) {
          const newBatterObj = {
            id: newB.id,
            name: newB.full_name,
            runs: 0,
            balls: 0,
            fours: 0,
            sixes: 0,
            strikeRate: 0.0
          };
          if (isStrikerDismissed) {
            state.striker = newBatterObj;
          } else {
            state.nonStriker = newBatterObj;
          }
          state.battersList.push({
            ...newBatterObj,
            isOut: false,
            dismissal: 'Not Out'
          });
        }
      }
    }

    // 11. Strike Rotation Logic
    // If odd runs completed (1, 3, 5), batters swap ends
    const runningRuns = (isWide || isNoBall) ? extraRuns : runs;
    if (runningRuns % 2 === 1 && !isWicket) {
      const temp = state.striker;
      state.striker = state.nonStriker;
      state.nonStriker = temp;
    }

    // At end of over, swap ends
    if (overCompleted) {
      const temp = state.striker;
      state.striker = state.nonStriker;
      state.nonStriker = temp;
    }

    // 12. Calculate Run Rates (CRR, RRR)
    const totalLegalBalls = (completedOvers * 6) + currentBalls;
    state.crr = totalLegalBalls > 0 ? parseFloat(((state.totalRuns / totalLegalBalls) * 6).toFixed(2)) : '0.00';

    if (state.innings === 2 && m.target_runs) {
      const runsRemaining = Math.max(0, m.target_runs - state.totalRuns);
      const totalBallsInMatch = (m.total_overs || 20) * 6;
      const ballsRemaining = Math.max(0, totalBallsInMatch - totalLegalBalls);
      state.rrr = ballsRemaining > 0 ? parseFloat(((runsRemaining / ballsRemaining) * 6).toFixed(2)) : '0.00';
      state.runsRemaining = runsRemaining;
      state.ballsRemaining = ballsRemaining;
    }

    // 13. Auto-generate Commentary Line
    const autoCommentary = commentary || `${state.overs} ${state.bowler.name} to ${state.striker.name}: ${
      isWicket ? `OUT! (${wicketType})` :
      isWide ? `Wide ball (+${totalBallRuns} runs)` :
      isNoBall ? `No ball (+${totalBallRuns} runs)` :
      runs === 4 ? 'FOUR! Cracking shot through the boundary.' :
      runs === 6 ? 'SIX! Massive hit towering over the ropes.' :
      runs === 0 ? 'Dot ball. Defended cleanly.' :
      `${runs} run${runs > 1 ? 's' : ''} taken.`
    }`;

    // 14. Persist to Relational Tables
    // Save to cricket_balls
    const [ballIns] = await conn.query(
      `INSERT INTO cricket_balls 
        (over_id, match_id, innings_id, ball_number, striker_id, non_striker_id, bowler_id, 
         runs_scored, is_wide, is_no_ball, is_bye, is_leg_bye, is_wicket, wicket_type, 
         dismissed_player_id, extra_runs, commentary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        overId,
        matchInfo.id,
        inningsId,
        state.legalBallsInOver,
        state.striker.id,
        state.nonStriker.id,
        state.bowler.id,
        batterRuns,
        isWide ? 1 : 0,
        isNoBall ? 1 : 0,
        isBye ? 1 : 0,
        isLegBye ? 1 : 0,
        isWicket ? 1 : 0,
        wicketType || null,
        dismissedPlayerId || null,
        extraRunsAdded,
        autoCommentary
      ]
    );

    // Save to score_events
    await conn.query(
      `INSERT INTO score_events (match_id, event_type, ball_id, payload)
       VALUES (?, ?, ?, ?)`,
      [
        matchInfo.id,
        celebrationType || (isLegalBall ? 'LEGAL_BALL' : 'EXTRA_BALL'),
        ballIns.insertId,
        JSON.stringify({
          ballId: ballIns.insertId,
          commentary: autoCommentary,
          celebration: celebrationType,
          ballSymbol,
          sportState: state
        })
      ]
    );

    // Update cricket_overs
    await conn.query(
      `UPDATE cricket_overs 
       SET total_runs = total_runs + ?,
           wickets_in_over = wickets_in_over + ?
       WHERE id = ?`,
      [totalBallRuns, isWicket ? 1 : 0, overId]
    );

    // Update cricket_innings
    await conn.query(
      `UPDATE cricket_innings 
       SET total_runs = ?,
           total_wickets = ?,
           total_overs_bowled = ?
       WHERE id = ?`,
      [state.totalRuns, state.wickets, parseFloat(state.overs), inningsId]
    );

    // 15. Check Innings or Match End Conditions
    const scoreSummary = `${state.totalRuns}/${state.wickets} (${state.overs} ov)`;
    let subtext = `${state.battingTeamName} Batting`;
    if (state.innings === 2 && m.target_runs) {
      subtext = `Target ${m.target_runs} | Need ${state.runsRemaining} runs in ${state.ballsRemaining} balls`;
    }

    let matchStatus = 'LIVE';
    let resultSummary = null;
    let winnerTeamId = null;

    // Check if 2nd Innings Target Reached (Team won by wickets)
    if (state.innings === 2 && m.target_runs && state.totalRuns >= m.target_runs) {
      matchStatus = 'COMPLETED';
      const wicketsInHand = 10 - state.wickets;
      resultSummary = `${state.battingTeamName} won by ${wicketsInHand} wicket${wicketsInHand > 1 ? 's' : ''}!`;
      winnerTeamId = state.battingTeamId;
    }
    // Check All Out or Overs Finished in 2nd Innings
    else if (state.innings === 2 && (state.wickets >= 10 || totalLegalBalls >= (m.total_overs || 20) * 6)) {
      matchStatus = 'COMPLETED';
      if (state.totalRuns >= m.target_runs) {
        winnerTeamId = state.battingTeamId;
        resultSummary = `${state.battingTeamName} won!`;
      } else if (state.totalRuns === m.target_runs - 1) {
        resultSummary = 'MATCH TIED!';
      } else {
        winnerTeamId = state.bowlingTeamId;
        const [bowlTeamRows] = await conn.query('SELECT name FROM teams WHERE id = ?', [state.bowlingTeamId]);
        const bowlTeam = bowlTeamRows && bowlTeamRows[0];
        const runsDiff = (m.target_runs - 1) - state.totalRuns;
        resultSummary = `${bowlTeam ? bowlTeam.name : 'Opponent'} won by ${runsDiff} run${runsDiff > 1 ? 's' : ''}!`;
      }
    }
    // Check 1st Innings End (10 Wickets or Overs Complete)
    else if (state.innings === 1 && (state.wickets >= 10 || totalLegalBalls >= (m.total_overs || 20) * 6)) {
      matchStatus = 'INNINGS_BREAK';
      const target = state.totalRuns + 1;
      state.target = target;
      subtext = `Innings Break. Target set to ${target} runs`;
      await conn.query('UPDATE cricket_matches SET target_runs = ? WHERE match_id = ?', [target, matchInfo.id]);
      await conn.query('UPDATE cricket_innings SET is_completed = 1 WHERE id = ?', [m.current_innings_id]);
    }

    // 16. Update Tournament Matches
    await conn.query(
      `UPDATE tournament_matches 
       SET live_score_summary = ?,
           live_subtext = ?,
           sport_state = ?,
           status = ?,
           winner_team_id = COALESCE(?, winner_team_id),
           result_summary = COALESCE(?, result_summary)
       WHERE id = ?`,
      [
        scoreSummary,
        subtext,
        JSON.stringify(state),
        matchStatus,
        winnerTeamId,
        resultSummary,
        matchInfo.id
      ]
    );

    // 17. Broadcast live events
    broadcastTournamentMatchUpdate(m.tournament_public_id, {
      public_id: matchInfo.uuid,
      status: matchStatus,
      live_score_summary: scoreSummary,
      live_subtext: subtext,
      court_name: 'Live Pitch',
      celebration: celebrationType,
      type: celebrationType || 'DELIVERY',
      state: state
    });

    broadcastMatchBallEvent(matchInfo.uuid, {
      seq: ballIns.insertId,
      type: celebrationType || 'DELIVERY',
      celebration: celebrationType,
      scoreSummary,
      subtext,
      commentary: autoCommentary,
      overCompleted,
      state,
      tournamentId: m.tournament_public_id
    });

    return {
      success: true,
      ballId: ballIns.insertId,
      celebration: celebrationType,
      overCompleted,
      scoreSummary,
      subtext,
      state
    };
  });
};

/**
 * 4. Bowler Switch at Over Completion
 */
const switchBowler = async ({ matchPublicId, nextBowlerId, userId, userRole }) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized' };

  return await db.transaction(async (conn) => {
    const [matches] = await conn.query(
      `SELECT tm.sport_state, cm.current_innings_id
       FROM tournament_matches tm
       JOIN cricket_matches cm ON tm.id = cm.match_id
       WHERE tm.id = ?
       FOR UPDATE`,
      [matchInfo.id]
    );

    const state = typeof matches[0].sport_state === 'string' ? JSON.parse(matches[0].sport_state) : matches[0].sport_state;
    const [nextBowlerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [nextBowlerId]);
    const nextBowler = nextBowlerRows[0];
    if (!nextBowler) throw { statusCode: 404, message: 'Selected bowler not found.' };

    // Prevent consecutive over by same bowler unless solo player
    if (state.bowler.id === nextBowler.id && state.legalBallsInOver === 6) {
      console.warn('Same bowler selected consecutively');
    }

    // Create next over in cricket_overs
    const nextOverNumber = (state.overNumber || 1) + 1;
    const [newOver] = await conn.query(
      `INSERT INTO cricket_overs (innings_id, over_number, bowler_id, total_runs, wickets_in_over)
       VALUES (?, ?, ?, 0, 0)`,
      [matches[0].current_innings_id, nextOverNumber, nextBowler.id]
    );

    // Reset over-specific state counters
    state.overNumber = nextOverNumber;
    state.currentOverId = newOver.insertId;
    state.legalBallsInOver = 0;
    state.currentOverBalls = [];
    state.overCompleted = false;

    // Find bowler in existing list or add
    let bEntry = (state.bowlersList || []).find(b => b.id === nextBowler.id);
    if (!bEntry) {
      bEntry = { id: nextBowler.id, name: nextBowler.full_name, overs: '0.0', maidens: 0, runs: 0, wickets: 0, economy: 0.0 };
      if (!state.bowlersList) state.bowlersList = [];
      state.bowlersList.push(bEntry);
    }

    state.bowler = bEntry;

    await conn.query('UPDATE tournament_matches SET sport_state = ? WHERE id = ?', [JSON.stringify(state), matchInfo.id]);
    await conn.query('UPDATE cricket_matches SET current_bowler_id = ? WHERE match_id = ?', [nextBowler.id, matchInfo.id]);

    const io = getIO();
    if (io) {
      io.to(`match:${matchInfo.uuid}`).emit('match:bowlerSwitched', {
        bowler: state.bowler,
        overNumber: state.overNumber
      });
    }

    return { success: true, bowler: state.bowler, overNumber: state.overNumber };
  });
};

/**
 * 5. Undo System (Reverts last valid delivery atomically)
 */
const undoLastDelivery = async ({ matchPublicId, userId, userRole }) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized' };

  return await db.transaction(async (conn) => {
    // 1. Fetch latest delivery
    const [latestBallRows] = await conn.query(
      `SELECT * FROM cricket_balls WHERE match_id = ? ORDER BY id DESC LIMIT 1`,
      [matchInfo.id]
    );
    const latestBall = latestBallRows[0];

    if (!latestBall) {
      throw { statusCode: 400, message: 'No deliveries recorded to undo.' };
    }

    // 2. Fetch the previous score_event before this ball
    const [prevEventsRows] = await conn.query(
      `SELECT payload FROM score_events 
       WHERE match_id = ? AND ball_id != ? 
       ORDER BY id DESC LIMIT 1`,
      [matchInfo.id, latestBall.id]
    );
    const prevEvents = prevEventsRows[0];

    // 3. Delete latest ball from cricket_balls
    await conn.query('DELETE FROM cricket_balls WHERE id = ?', [latestBall.id]);
    await conn.query('DELETE FROM score_events WHERE ball_id = ?', [latestBall.id]);

    let restoredState = null;
    if (prevEvents && prevEvents.payload) {
      try {
        const parsed = typeof prevEvents.payload === 'string' ? JSON.parse(prevEvents.payload) : prevEvents.payload;
        restoredState = parsed.sportState;
      } catch {
        restoredState = null;
      }
    }

    if (!restoredState) {
      // Reconstruct fresh from scratch or reset to 0
      const [matchesRows] = await conn.query('SELECT sport_state FROM tournament_matches WHERE id = ?', [matchInfo.id]);
      restoredState = typeof matchesRows[0].sport_state === 'string' ? JSON.parse(matchesRows[0].sport_state) : matchesRows[0].sport_state;
      restoredState.totalRuns = Math.max(0, restoredState.totalRuns - (latestBall.runs_scored + latestBall.extra_runs));
      if (latestBall.is_wicket) restoredState.wickets = Math.max(0, restoredState.wickets - 1);
      if (restoredState.currentOverBalls.length > 0) restoredState.currentOverBalls.pop();
    }

    const newSummary = `${restoredState.totalRuns}/${restoredState.wickets} (${restoredState.overs} ov)`;
    await conn.query(
      `UPDATE tournament_matches 
       SET live_score_summary = ?,
           sport_state = ?
       WHERE id = ?`,
      [newSummary, JSON.stringify(restoredState), matchInfo.id]
    );

    // Log in score_corrections
    await conn.query(
      `INSERT INTO score_corrections (match_id, original_ball_id, previous_payload, new_payload, corrected_by_id, reason)
       VALUES (?, ?, ?, ?, ?, 'Scorer pressed UNDO')`,
      [matchInfo.id, latestBall.id, JSON.stringify(latestBall), JSON.stringify(restoredState), userId]
    );

    // Broadcast undone event
    const io = getIO();
    if (io) {
      io.to(`match:${matchInfo.uuid}`).emit('match:undone', {
        revertedBallId: latestBall.id,
        scoreSummary: newSummary,
        state: restoredState
      });
    }

    return {
      success: true,
      message: 'Delivery successfully undone.',
      state: restoredState
    };
  });
};

/**
 * 6. Start 2nd Innings
 */
const startSecondInnings = async ({
  matchPublicId,
  strikerId,
  nonStrikerId,
  bowlerId,
  userId,
  userRole
}) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized' };

  return await db.transaction(async (conn) => {
    const [cmRows] = await conn.query('SELECT * FROM cricket_matches WHERE match_id = ?', [matchInfo.id]);
    const cm = cmRows[0];
    const [mRows] = await conn.query('SELECT team_a_id, team_b_id, sport_state FROM tournament_matches WHERE id = ?', [matchInfo.id]);
    const m = mRows[0];
    const prevState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : m.sport_state;

    // Swap teams
    const battingTeamId = prevState.bowlingTeamId;
    const bowlingTeamId = prevState.battingTeamId;
    const target = (prevState.totalRuns || 0) + 1;

    // Create 2nd Innings record
    const [innResult] = await conn.query(
      `INSERT INTO cricket_innings (match_id, innings_number, batting_team_id, bowling_team_id, total_runs, total_wickets, total_overs_bowled, is_completed)
       VALUES (?, 2, ?, ?, 0, 0, 0.0, 0)`,
      [matchInfo.id, battingTeamId, bowlingTeamId]
    );
    const inningsId = innResult.insertId;

    // Create 1st Over of 2nd Innings
    const [overResult] = await conn.query(
      `INSERT INTO cricket_overs (innings_id, over_number, bowler_id, total_runs, wickets_in_over)
       VALUES (?, 1, ?, 0, 0)`,
      [inningsId, bowlerId]
    );

    await conn.query(
      `UPDATE cricket_matches 
       SET current_innings_id = ?, target_runs = ?, striker_id = ?, non_striker_id = ?, current_bowler_id = ?
       WHERE match_id = ?`,
      [inningsId, target, strikerId, nonStrikerId, bowlerId, matchInfo.id]
    );

    const [strikerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [strikerId]);
    const [nonStrikerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [nonStrikerId]);
    const [bowlerRows] = await conn.query('SELECT id, full_name FROM users WHERE id = ?', [bowlerId]);
    const [batTeamRows] = await conn.query('SELECT name FROM teams WHERE id = ?', [battingTeamId]);

    const striker = strikerRows[0];
    const nonStriker = nonStrikerRows[0];
    const bowler = bowlerRows[0];
    const batTeam = batTeamRows[0];

    const state = {
      innings: 2,
      battingTeamId,
      battingTeamName: batTeam.name,
      bowlingTeamId,
      totalRuns: 0,
      wickets: 0,
      overs: 0.0,
      legalBallsInOver: 0,
      overNumber: 1,
      currentOverId: overResult.insertId,
      target,
      runsRemaining: target,
      ballsRemaining: (cm.total_overs || 20) * 6,
      striker: { id: striker.id, name: striker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0 },
      nonStriker: { id: nonStriker.id, name: nonStriker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0 },
      bowler: { id: bowler.id, name: bowler.full_name, overs: '0.0', maidens: 0, runs: 0, wickets: 0, economy: 0.0 },
      currentOverBalls: [],
      extras: { wide: 0, noBall: 0, bye: 0, legBye: 0, penalty: 0, total: 0 },
      partnership: { runs: 0, balls: 0 },
      crr: '0.00',
      rrr: ((target / (cm.total_overs || 20))).toFixed(2),
      battersList: [
        { id: striker.id, name: striker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0, isOut: false, dismissal: 'Not Out' },
        { id: nonStriker.id, name: nonStriker.full_name, runs: 0, balls: 0, fours: 0, sixes: 0, strikeRate: 0.0, isOut: false, dismissal: 'Not Out' }
      ],
      bowlersList: [
        { id: bowler.id, name: bowler.full_name, overs: '0.0', maidens: 0, runs: 0, wickets: 0, economy: 0.0 }
      ],
      fallOfWickets: []
    };

    const summary = '0/0 (0.0 ov)';
    const subtext = `Target ${target} | Need ${target} runs in ${(cm.total_overs || 20) * 6} balls`;

    await conn.query(
      `UPDATE tournament_matches 
       SET status = 'LIVE',
           live_score_summary = ?,
           live_subtext = ?,
           sport_state = ?
       WHERE id = ?`,
      [summary, subtext, JSON.stringify(state), matchInfo.id]
    );

    const io = getIO();
    if (io) {
      io.to(`match:${matchInfo.uuid}`).emit('match:inningsStarted', {
        innings: 2,
        state,
        summary,
        subtext
      });
    }

    return { success: true, message: '2nd innings started!', state };
  });
};

/**
 * 7. Complete Match & Update Tournament Standings
 */
const completeMatch = async ({ matchPublicId, winnerTeamId, resultSummary, userId, userRole }) => {
  const matchInfo = await resolveMatchId(matchPublicId);
  if (!matchInfo) throw { statusCode: 404, message: 'Match not found.' };

  const isAuth = await checkScorerAuthorization(userId, userRole, matchInfo.id);
  if (!isAuth) throw { statusCode: 403, message: 'Unauthorized' };

  return await db.transaction(async (conn) => {
    const [mRows] = await conn.query(
      `SELECT tm.tournament_id, tm.team_a_id, tm.team_b_id, tm.sport_state
       FROM tournament_matches tm
       WHERE tm.id = ?`,
      [matchInfo.id]
    );
    const m = mRows[0];

    await conn.query(
      `UPDATE tournament_matches 
       SET status = 'COMPLETED',
           winner_team_id = ?,
           result_summary = ?
       WHERE id = ?`,
      [winnerTeamId || null, resultSummary || 'Match Completed', matchInfo.id]
    );

    // Update Tournament points_table & recalculate authoritative standings (NRR, points, etc.)
    if (m && m.tournament_id) {
      try {
        const { recalculateStandings, advanceKnockoutWinner } = require('./tournamentEngineService');
        await recalculateStandings(m.tournament_id);
        if (winnerTeamId) {
          const loserTeamId = m.team_a_id === winnerTeamId ? m.team_b_id : m.team_a_id;
          await advanceKnockoutWinner(matchInfo.id, winnerTeamId, loserTeamId);
        }
      } catch (err) {
        console.error('Error recalculating standings on cricket match complete:', err);
      }
    }

    const io = getIO();
    if (io) {
      io.to(`match:${matchInfo.uuid}`).emit('match:completed', {
        winnerTeamId,
        resultSummary
      });
    }

    return { success: true, message: 'Match successfully completed and standings updated!' };
  });
};

/**
 * 8. Get Active Stadium Ads (Top & Bottom)
 */
const getMatchAds = async (matchPublicId) => {
  const rows = await db.query(
    `SELECT id, name, image_url, position, scroll_direction, scroll_speed, priority
     FROM advertisements
     WHERE status = 'ACTIVE'
     ORDER BY priority DESC, id ASC`
  );

  return {
    topAd: rows.find(r => r.position === 'TOP') || null,
    bottomAd: rows.find(r => r.position === 'BOTTOM') || null
  };
};

module.exports = {
  getScorerState,
  setupToss,
  recordDelivery,
  switchBowler,
  undoLastDelivery,
  startSecondInnings,
  completeMatch,
  getMatchAds
};
