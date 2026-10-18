const db = require('../config/database');
const { getSportConfig } = require('./sportsRegistry');

/**
 * Statistics & Awards Service
 * Manages player career profiles, team profiles, and automatic tournament
 * leaderboards and awards computation across all sports.
 */

/**
 * 1. Compute Tournament Leaderboards & Awards.
 */
async function computeTournamentAwards(tournamentId) {
  const [tournament] = await db.query(
    `SELECT t.id, t.uuid, t.sport_id, s.slug as sport_slug
     FROM tournaments t
     JOIN sports s ON t.sport_id = s.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentId, /^\d+$/.test(String(tournamentId).trim()) ? parseInt(tournamentId, 10) : -1]
  );

  if (!tournament) throw { statusCode: 404, message: 'Tournament not found.' };

  const sportSlug = tournament.sport_slug;
  const awardsList = [];

  // ── FOOTBALL AWARDS ──
  if (sportSlug === 'football') {
    // 1. Top Scorer (Golden Boot)
    const topScorers = await db.query(
      `SELECT e.player_id, u.full_name as player_name, tm.name as team_name, tm.id as team_id,
              COUNT(*) as goals_count
       FROM sport_match_events e
       JOIN tournament_matches m ON e.match_id = m.id
       JOIN users u ON e.player_id = u.id
       LEFT JOIN teams tm ON e.team_id = tm.id
       WHERE m.tournament_id = ? AND e.event_type = 'GOAL'
       GROUP BY e.player_id, u.full_name, tm.name, tm.id
       ORDER BY goals_count DESC, u.full_name ASC
       LIMIT 1`,
      [tournament.id]
    );

    if (topScorers && topScorers.length > 0) {
      awardsList.push({
        key: 'GOLDEN_BOOT',
        name: 'Top Scorer (Golden Boot)',
        recipientType: 'PLAYER',
        recipientId: topScorers[0].player_id,
        recipientName: topScorers[0].player_name,
        teamId: topScorers[0].team_id,
        teamName: topScorers[0].team_name,
        statValue: `${topScorers[0].goals_count} Goals`,
        method: 'Most goals scored in tournament (open play + penalties)'
      });
    }

    // 2. Playmaker Award (Most Assists)
    const topAssists = await db.query(
      `SELECT e.assist_player_id as player_id, u.full_name as player_name, tm.name as team_name, tm.id as team_id,
              COUNT(*) as assists_count
       FROM sport_match_events e
       JOIN tournament_matches m ON e.match_id = m.id
       JOIN users u ON e.assist_player_id = u.id
       LEFT JOIN teams tm ON e.team_id = tm.id
       WHERE m.tournament_id = ? AND e.event_type = 'GOAL' AND e.assist_player_id IS NOT NULL
       GROUP BY e.assist_player_id, u.full_name, tm.name, tm.id
       ORDER BY assists_count DESC, u.full_name ASC
       LIMIT 1`,
      [tournament.id]
    );

    if (topAssists && topAssists.length > 0) {
      awardsList.push({
        key: 'PLAYMAKER',
        name: 'Most Assists (Playmaker Award)',
        recipientType: 'PLAYER',
        recipientId: topAssists[0].player_id,
        recipientName: topAssists[0].player_name,
        teamId: topAssists[0].team_id,
        teamName: topAssists[0].team_name,
        statValue: `${topAssists[0].assists_count} Assists`,
        method: 'Highest number of official goal assists'
      });
    }

    // 3. Fair Play Award (Fewest cards)
    const fairPlay = await db.query(
      `SELECT tm.id as team_id, tm.name as team_name,
              SUM(CASE WHEN e.event_type = 'YELLOW_CARD' THEN 1 WHEN e.event_type = 'RED_CARD' THEN 3 ELSE 0 END) as penalty_points
       FROM tournament_teams tt
       JOIN teams tm ON tt.team_id = tm.id
       LEFT JOIN sport_match_events e ON e.team_id = tm.id AND e.match_id IN (SELECT id FROM tournament_matches WHERE tournament_id = ?)
       WHERE tt.tournament_id = ?
       GROUP BY tm.id, tm.name
       ORDER BY penalty_points ASC, tm.name ASC
       LIMIT 1`,
      [tournament.id, tournament.id]
    );

    if (fairPlay && fairPlay.length > 0) {
      awardsList.push({
        key: 'FAIR_PLAY',
        name: 'Fair Play Trophy',
        recipientType: 'TEAM',
        recipientId: fairPlay[0].team_id,
        recipientName: fairPlay[0].team_name,
        teamId: fairPlay[0].team_id,
        teamName: fairPlay[0].team_name,
        statValue: `${fairPlay[0].penalty_points || 0} Demerit Pts`,
        method: 'Lowest disciplinary points (Yellow = 1 pt, Red = 3 pts)'
      });
    }
  }

  // ── CRICKET AWARDS ──
  else if (sportSlug === 'cricket') {
    // 1. Most Runs (Orange Cap)
    const topRuns = await db.query(
      `SELECT b.batter_id as player_id, u.full_name as player_name, tm.name as team_name, tm.id as team_id,
              SUM(b.runs_batter) as total_runs,
              SUM(CASE WHEN b.runs_batter = 6 THEN 1 ELSE 0 END) as total_sixes,
              SUM(CASE WHEN b.runs_batter = 4 THEN 1 ELSE 0 END) as total_fours
       FROM cricket_balls b
       JOIN cricket_innings inn ON b.innings_id = inn.id
       JOIN cricket_matches cm ON inn.cricket_match_id = cm.id
       JOIN tournament_matches m ON cm.match_id = m.id
       JOIN users u ON b.batter_id = u.id
       LEFT JOIN team_members mem ON mem.user_id = u.id
       LEFT JOIN teams tm ON mem.team_id = tm.id
       WHERE m.tournament_id = ?
       GROUP BY b.batter_id, u.full_name, tm.name, tm.id
       ORDER BY total_runs DESC
       LIMIT 1`,
      [tournament.id]
    );

    if (topRuns && topRuns.length > 0) {
      awardsList.push({
        key: 'ORANGE_CAP',
        name: 'Most Runs (Orange Cap)',
        recipientType: 'PLAYER',
        recipientId: topRuns[0].player_id,
        recipientName: topRuns[0].player_name,
        teamId: topRuns[0].team_id,
        teamName: topRuns[0].team_name,
        statValue: `${topRuns[0].total_runs} Runs`,
        method: 'Highest cumulative batting runs across tournament matches'
      });

      if (topRuns[0].total_sixes > 0) {
        awardsList.push({
          key: 'MOST_SIXES',
          name: 'Maximum Sixes Award',
          recipientType: 'PLAYER',
          recipientId: topRuns[0].player_id,
          recipientName: topRuns[0].player_name,
          teamId: topRuns[0].team_id,
          teamName: topRuns[0].team_name,
          statValue: `${topRuns[0].total_sixes} Sixes`,
          method: 'Most sixes hit in the tournament'
        });
      }
    }

    // 2. Most Wickets (Purple Cap)
    const topWickets = await db.query(
      `SELECT b.bowler_id as player_id, u.full_name as player_name, tm.name as team_name, tm.id as team_id,
              COUNT(*) as total_wickets
       FROM cricket_balls b
       JOIN cricket_innings inn ON b.innings_id = inn.id
       JOIN cricket_matches cm ON inn.cricket_match_id = cm.id
       JOIN tournament_matches m ON cm.match_id = m.id
       JOIN users u ON b.bowler_id = u.id
       LEFT JOIN team_members mem ON mem.user_id = u.id
       LEFT JOIN teams tm ON mem.team_id = tm.id
       WHERE m.tournament_id = ? AND b.is_wicket = 1 AND b.dismissal_type NOT IN ('run out', 'retired hurt')
       GROUP BY b.bowler_id, u.full_name, tm.name, tm.id
       ORDER BY total_wickets DESC
       LIMIT 1`,
      [tournament.id]
    );

    if (topWickets && topWickets.length > 0) {
      awardsList.push({
        key: 'PURPLE_CAP',
        name: 'Most Wickets (Purple Cap)',
        recipientType: 'PLAYER',
        recipientId: topWickets[0].player_id,
        recipientName: topWickets[0].player_name,
        teamId: topWickets[0].team_id,
        teamName: topWickets[0].team_name,
        statValue: `${topWickets[0].total_wickets} Wickets`,
        method: 'Most bowler-credited wickets across tournament'
      });
    }
  }

  // ── RACKET SPORTS (BADMINTON & PICKLEBALL) AWARDS ──
  else {
    // 1. Most Match Wins
    const mostWins = await db.query(
      `SELECT pt.team_id, tm.name as team_name, pt.won, pt.point_difference
       FROM points_table pt
       JOIN teams tm ON pt.team_id = tm.id
       WHERE pt.tournament_id = ?
       ORDER BY pt.won DESC, pt.point_difference DESC
       LIMIT 1`,
      [tournament.id]
    );

    if (mostWins && mostWins.length > 0) {
      awardsList.push({
        key: 'MOST_MATCH_WINS',
        name: 'Tournament Leading Team',
        recipientType: 'TEAM',
        recipientId: mostWins[0].team_id,
        recipientName: mostWins[0].team_name,
        teamId: mostWins[0].team_id,
        teamName: mostWins[0].team_name,
        statValue: `${mostWins[0].won} Wins`,
        method: 'Highest matches won in group & playoff stages'
      });
    }
  }

  // Save awards into tournament_awards table (preserving any manual overrides)
  for (const a of awardsList) {
    const existing = await db.query(
      `SELECT id, is_manual_override FROM tournament_awards 
       WHERE tournament_id = ? AND award_key = ?`,
      [tournament.id, a.key]
    );

    if (!existing || existing.length === 0) {
      await db.query(
        `INSERT INTO tournament_awards (
          tournament_id, award_key, award_name, sport_slug, recipient_type,
          recipient_id, recipient_name, team_id, team_name, stat_value,
          calculation_method, is_manual_override
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          tournament.id, a.key, a.name, sportSlug, a.recipientType,
          a.recipientId, a.recipientName, a.teamId, a.teamName,
          a.statValue, a.method
        ]
      );
    } else if (!existing[0].is_manual_override) {
      await db.query(
        `UPDATE tournament_awards 
         SET recipient_id = ?, recipient_name = ?, team_id = ?,
             team_name = ?, stat_value = ?, calculation_method = ?
         WHERE id = ?`,
        [a.recipientId, a.recipientName, a.teamId, a.teamName, a.statValue, a.method, existing[0].id]
      );
    }
  }

  return await getTournamentAwards(tournament.uuid);
}

/**
 * 2. Get Tournament Awards & Leaderboards.
 */
async function getTournamentAwards(tournamentId) {
  const [tournament] = await db.query(
    `SELECT id, uuid FROM tournaments WHERE uuid = ? OR id = ?`,
    [tournamentId, /^\d+$/.test(String(tournamentId).trim()) ? parseInt(tournamentId, 10) : -1]
  );
  if (!tournament) return [];

  const awards = await db.query(
    `SELECT * FROM tournament_awards WHERE tournament_id = ? ORDER BY id ASC`,
    [tournament.id]
  );

  return awards.map(a => ({
    id: a.id,
    key: a.award_key,
    name: a.award_name,
    sportSlug: a.sport_slug,
    recipientType: a.recipient_type,
    recipientId: a.recipient_id,
    recipientName: a.recipient_name,
    teamId: a.team_id,
    teamName: a.team_name,
    statValue: a.stat_value,
    calculationMethod: a.calculation_method,
    isManualOverride: Boolean(a.is_manual_override),
    overrideReason: a.override_reason,
    createdAt: a.created_at
  }));
}

/**
 * 3. Organizer Override of an Award (with audit note).
 */
async function overrideAward(awardId, { recipientId, recipientName, reason }, user) {
  if (!user || !['ADMIN', 'VENUE_OWNER'].includes(user.role)) {
    throw { statusCode: 403, message: 'Forbidden. Only organizers can override tournament awards.' };
  }
  if (!reason || reason.trim().length < 5) {
    throw { statusCode: 400, message: 'A valid audit reason is required for award override.' };
  }

  const [award] = await db.query(`SELECT * FROM tournament_awards WHERE id = ?`, [awardId]);
  if (!award) throw { statusCode: 404, message: 'Award not found.' };

  await db.query(
    `UPDATE tournament_awards 
     SET recipient_id = ?, recipient_name = ?,
         is_manual_override = 1, override_reason = ?, overridden_by = ?
     WHERE id = ?`,
    [recipientId || null, recipientName, reason.trim(), user.id, awardId]
  );

  // Log in audit logs
  await db.query(
    `INSERT INTO tournament_audit_logs (
      tournament_id, action_type, user_id, user_role, previous_state, new_state, notes
    ) VALUES (?, 'AWARD_OVERRIDE', ?, ?, ?, ?, ?)`,
    [
      award.tournament_id,
      user.id,
      user.role,
      JSON.stringify({ recipientName: award.recipient_name, recipientId: award.recipient_id }),
      JSON.stringify({ recipientName, recipientId }),
      `Award ${award.award_name} overridden: ${reason}`
    ]
  );

  return { success: true, message: 'Award updated with audit record.' };
}

/**
 * 4. Calculate actual dynamic career statistics from match events.
 */
async function calculateCricketCareerStats(userId) {
  // Batting totals
  const [batting] = await db.query(
    `SELECT 
       COUNT(DISTINCT match_id) as matches_batted,
       COALESCE(SUM(runs_scored), 0) as total_runs,
       COALESCE(SUM(CASE WHEN is_wide = 0 THEN 1 ELSE 0 END), 0) as balls_faced,
       COALESCE(SUM(CASE WHEN runs_scored = 4 THEN 1 ELSE 0 END), 0) as fours,
       COALESCE(SUM(CASE WHEN runs_scored = 6 THEN 1 ELSE 0 END), 0) as sixes
     FROM cricket_balls
     WHERE striker_id = ?`,
    [userId]
  );

  // Batting dismissals
  const [dismissals] = await db.query(
    `SELECT COUNT(*) as outs FROM cricket_balls WHERE dismissed_player_id = ?`,
    [userId]
  );

  // Highest score in a match
  const [highScore] = await db.query(
    `SELECT SUM(runs_scored) as innings_runs
     FROM cricket_balls
     WHERE striker_id = ?
     GROUP BY match_id
     ORDER BY innings_runs DESC LIMIT 1`,
    [userId]
  );

  // Bowling figures
  const [bowling] = await db.query(
    `SELECT 
       COUNT(DISTINCT match_id) as matches_bowled,
       COALESCE(SUM(CASE WHEN is_wide = 0 AND is_no_ball = 0 THEN 1 ELSE 0 END), 0) as legal_balls,
       COALESCE(SUM(runs_scored + extra_runs), 0) as runs_conceded,
       COALESCE(SUM(CASE WHEN is_wicket = 1 AND wicket_type NOT IN ('RUN_OUT', 'RETIRED_HURT') THEN 1 ELSE 0 END), 0) as wickets
     FROM cricket_balls
     WHERE bowler_id = ?`,
    [userId]
  );

  // Best bowling in a single match
  const [bestBowling] = await db.query(
    `SELECT 
       COUNT(CASE WHEN is_wicket = 1 AND wicket_type NOT IN ('RUN_OUT', 'RETIRED_HURT') THEN 1 ELSE NULL END) as wkts,
       SUM(runs_scored + extra_runs) as runs
     FROM cricket_balls
     WHERE bowler_id = ?
     GROUP BY match_id
     ORDER BY wkts DESC, runs ASC LIMIT 1`,
    [userId]
  );

  // Distinct appearances across all matches
  const [appearances] = await db.query(
    `SELECT COUNT(DISTINCT match_id) as total_matches
     FROM (
       SELECT match_id FROM cricket_balls WHERE striker_id = ? OR bowler_id = ?
       UNION
       SELECT tm.id as match_id FROM tournament_matches tm
       JOIN team_members mem ON (tm.team_a_id = mem.team_id OR tm.team_b_id = mem.team_id)
       WHERE mem.user_id = ? AND tm.status = 'COMPLETED'
     ) as m`,
    [userId, userId, userId]
  );

  const runs = parseInt(batting?.total_runs, 10) || 0;
  const balls = parseInt(batting?.balls_faced, 10) || 0;
  const outs = parseInt(dismissals?.outs, 10) || 0;
  const innings = parseInt(batting?.matches_batted, 10) || 0;
  const notOuts = Math.max(0, innings - outs);
  const battingAvg = outs > 0 ? (runs / outs).toFixed(2) : (runs > 0 ? runs.toFixed(2) : '0.00');
  const strikeRate = balls > 0 ? ((runs / balls) * 100).toFixed(2) : '0.00';

  const legalBalls = parseInt(bowling?.legal_balls, 10) || 0;
  const oversBowled = `${Math.floor(legalBalls / 6)}.${legalBalls % 6}`;
  const runsConceded = parseInt(bowling?.runs_conceded, 10) || 0;
  const wickets = parseInt(bowling?.wickets, 10) || 0;
  const economy = legalBalls > 0 ? (runsConceded / (legalBalls / 6)).toFixed(2) : '0.00';
  const bowlingAvg = wickets > 0 ? (runsConceded / wickets).toFixed(2) : '-';
  const bowlingSR = wickets > 0 ? (legalBalls / wickets).toFixed(1) : '-';

  return {
    matchesPlayed: parseInt(appearances?.total_matches, 10) || 0,
    batting: {
      innings,
      runs,
      highestScore: highScore?.innings_runs || 0,
      battingAverage: battingAvg,
      strikeRate,
      ballsFaced: balls,
      fours: parseInt(batting?.fours, 10) || 0,
      sixes: parseInt(batting?.sixes, 10) || 0,
      notOuts
    },
    bowling: {
      oversBowled,
      runsConceded,
      wickets,
      economy,
      bowlingAverage: bowlingAvg,
      bowlingStrikeRate: bowlingSR,
      bestBowling: bestBowling ? `${bestBowling.wkts}/${bestBowling.runs || 0}` : '-'
    }
  };
}

async function calculateFootballCareerStats(userId) {
  const [goals] = await db.query(
    `SELECT COUNT(*) as count FROM sport_match_events WHERE player_id = ? AND event_type = 'GOAL'`,
    [userId]
  );
  const [assists] = await db.query(
    `SELECT COUNT(*) as count FROM sport_match_events WHERE assist_player_id = ?`,
    [userId]
  );
  const [yellowCards] = await db.query(
    `SELECT COUNT(*) as count FROM sport_match_events WHERE player_id = ? AND event_type = 'CARD' AND commentary LIKE '%YELLOW%'`,
    [userId]
  );
  const [redCards] = await db.query(
    `SELECT COUNT(*) as count FROM sport_match_events WHERE player_id = ? AND event_type = 'CARD' AND commentary LIKE '%RED%'`,
    [userId]
  );

  const [appearances] = await db.query(
    `SELECT COUNT(DISTINCT match_id) as total_matches
     FROM sport_match_events
     WHERE (player_id = ? OR assist_player_id = ?) AND sport_slug = 'football'`,
    [userId, userId]
  );

  return {
    matchesPlayed: parseInt(appearances?.total_matches, 10) || 0,
    goals: parseInt(goals?.count, 10) || 0,
    assists: parseInt(assists?.count, 10) || 0,
    yellowCards: parseInt(yellowCards?.count, 10) || 0,
    redCards: parseInt(redCards?.count, 10) || 0,
    cleanSheets: 0
  };
}

async function calculateRacketCareerStats(userId, sportSlug) {
  const matches = await db.query(
    `SELECT tm.id, tm.winner_team_id, mem.team_id
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     JOIN team_members mem ON (tm.team_a_id = mem.team_id OR tm.team_b_id = mem.team_id)
     WHERE s.slug = ? AND mem.user_id = ? AND tm.status = 'COMPLETED'`,
    [sportSlug, userId]
  );

  const total = matches.length;
  let won = 0;
  for (const m of matches) {
    if (m.winner_team_id && m.winner_team_id === m.team_id) won++;
  }
  const lost = total - won;
  const winRate = total > 0 ? ((won / total) * 100).toFixed(0) : '0';

  return {
    matchesPlayed: total,
    won,
    lost,
    winPercentage: `${winRate}%`
  };
}

/**
 * 5. Get Chronological Match-by-Match History for a Player.
 */
async function getPlayerMatchHistory(userId, sportFilter = null) {
  // Query matches player was involved in (through balls, events, or team rosters)
  let sql = `
    SELECT DISTINCT
      tm.id as internal_id,
      tm.uuid as match_id,
      tm.match_number,
      tm.match_date,
      tm.start_time,
      tm.status,
      tm.live_score_summary,
      tm.result_summary,
      s.slug as sport_slug,
      s.name as sport_name,
      t.name as tournament_name,
      t.uuid as tournament_uuid,
      c.name as court_name,
      v.name as venue_name,
      my_team.id as my_team_id,
      my_team.name as my_team_name,
      my_team.logo_url as my_team_logo,
      opp_team.name as opponent_name,
      opp_team.logo_url as opponent_logo
    FROM tournament_matches tm
    LEFT JOIN tournaments t ON tm.tournament_id = t.id
    LEFT JOIN sports s ON t.sport_id = s.id
    LEFT JOIN courts c ON tm.court_id = c.id
    LEFT JOIN venues v ON tm.venue_id = v.id
    JOIN team_members mem ON (tm.team_a_id = mem.team_id OR tm.team_b_id = mem.team_id)
    JOIN teams my_team ON mem.team_id = my_team.id
    JOIN teams opp_team ON (CASE WHEN tm.team_a_id = mem.team_id THEN tm.team_b_id ELSE tm.team_a_id END) = opp_team.id
    WHERE mem.user_id = ? AND tm.status = 'COMPLETED'
  `;

  const params = [userId];
  if (sportFilter) {
    sql += ` AND s.slug = ?`;
    params.push(sportFilter);
  }

  sql += ` ORDER BY tm.match_date DESC, tm.id DESC LIMIT 30`;

  const rows = await db.query(sql, params);

  // For each match, attach player-specific recorded statistics
  const history = [];
  for (const m of rows) {
    let performance = {};

    if (m.sport_slug === 'cricket') {
      const [bat] = await db.query(
        `SELECT SUM(runs_scored) as runs,
                COUNT(CASE WHEN is_wide = 0 THEN 1 ELSE NULL END) as balls,
                SUM(CASE WHEN runs_scored = 4 THEN 1 ELSE 0 END) as fours,
                SUM(CASE WHEN runs_scored = 6 THEN 1 ELSE 0 END) as sixes
         FROM cricket_balls
         WHERE match_id = ? AND striker_id = ?`,
        [m.internal_id, userId]
      );
      const [bowl] = await db.query(
        `SELECT COUNT(CASE WHEN is_wide = 0 AND is_no_ball = 0 THEN 1 ELSE NULL END) as balls,
                SUM(runs_scored + extra_runs) as runs,
                COUNT(CASE WHEN is_wicket = 1 THEN 1 ELSE NULL END) as wkts
         FROM cricket_balls
         WHERE match_id = ? AND bowler_id = ?`,
        [m.internal_id, userId]
      );

      const bRuns = parseInt(bat?.runs, 10) || 0;
      const bBalls = parseInt(bat?.balls, 10) || 0;
      const sr = bBalls > 0 ? ((bRuns / bBalls) * 100).toFixed(1) : '0.0';
      const bowlBalls = parseInt(bowl?.balls, 10) || 0;
      const bowlOvers = `${Math.floor(bowlBalls / 6)}.${bowlBalls % 6}`;

      performance = {
        batting: bBalls > 0 ? `${bRuns} (${bBalls}b, ${bat?.fours || 0}x4, ${bat?.sixes || 0}x6) SR: ${sr}` : 'DNB',
        bowling: bowlBalls > 0 ? `${bowl?.wkts || 0}/${bowl?.runs || 0} (${bowlOvers} ov)` : null
      };
    } else if (m.sport_slug === 'football') {
      const [fbEvents] = await db.query(
        `SELECT 
           SUM(CASE WHEN event_type = 'GOAL' AND player_id = ? THEN 1 ELSE 0 END) as goals,
           SUM(CASE WHEN assist_player_id = ? THEN 1 ELSE 0 END) as assists
         FROM sport_match_events
         WHERE match_id = ?`,
        [userId, userId, m.internal_id]
      );
      performance = {
        goals: parseInt(fbEvents?.goals, 10) || 0,
        assists: parseInt(fbEvents?.assists, 10) || 0
      };
    } else {
      performance = {
        scoreSummary: m.live_score_summary
      };
    }

    history.push({
      matchId: m.match_id,
      matchNumber: m.match_number,
      matchDate: m.match_date,
      tournamentName: m.tournament_name || 'Standard Match',
      sportSlug: m.sport_slug,
      sportName: m.sport_name,
      teamName: m.my_team_name,
      teamLogo: m.my_team_logo,
      opponentName: m.opponent_name,
      opponentLogo: m.opponent_logo,
      courtName: m.court_name,
      resultSummary: m.result_summary || 'Match Concluded',
      scoreSummary: m.live_score_summary,
      performance
    });
  }

  return history;
}

/**
 * 6. Get Player Profile across sports with actual stats and privacy protections.
 */
async function getPlayerProfile(userId, requestingUser = null) {
  const [user] = await db.query(
    `SELECT * FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) throw { statusCode: 404, message: 'Player not found.' };

  // Calculate age from dob if present
  let age = null;
  if (user.dob) {
    const diff = new Date() - new Date(user.dob);
    age = Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
  }

  // Privacy Rule: Only expose private contact information to the player themselves or an Admin
  const isSelf = requestingUser && Number(requestingUser.id) === Number(user.id);
  const isAdmin = requestingUser && requestingUser.role === 'ADMIN';
  const showPrivate = isSelf || isAdmin;

  // Actual Dynamic Career Statistics
  const cricketCareer = await calculateCricketCareerStats(user.id);
  const footballCareer = await calculateFootballCareerStats(user.id);
  const badmintonCareer = await calculateRacketCareerStats(user.id, 'badminton');
  const pickleballCareer = await calculateRacketCareerStats(user.id, 'pickleball');

  // Multi-Sport Profiles from table
  const sportsProfiles = await db.query(
    `SELECT p.*, s.name as sport_name, s.icon as sport_icon
     FROM player_sport_profiles p
     JOIN sports s ON p.sport_slug = s.slug
     WHERE p.user_id = ?`,
    [userId]
  );

  // Teams player belongs to
  const teams = await db.query(
    `SELECT tm.id, tm.uuid as public_id, tm.name, tm.logo_url, s.name as sport_name,
            mem.role, mem.jersey_number, mem.position, mem.is_captain
     FROM team_members mem
     JOIN teams tm ON mem.team_id = tm.id
     JOIN sports s ON tm.sport_id = s.id
     WHERE mem.user_id = ?
     ORDER BY mem.is_captain DESC, tm.name ASC`,
    [userId]
  );

  // Awards won by player
  const awardsWon = await db.query(
    `SELECT a.*, t.name as tournament_name, t.uuid as tournament_uuid
     FROM tournament_awards a
     JOIN tournaments t ON a.tournament_id = t.id
     WHERE a.recipient_id = ? AND a.recipient_type = 'PLAYER'
     ORDER BY a.created_at DESC`,
    [userId]
  );

  // Match History
  const matchHistory = await getPlayerMatchHistory(user.id);

  return {
    id: user.id,
    fullName: user.full_name,
    profilePhoto: user.profile_photo,
    memberSince: user.created_at,
    dob: showPrivate ? user.dob : null,
    age,
    gender: user.gender || 'Not Specified',
    city: user.city || 'India',
    state: user.state || null,
    country: user.country || 'India',
    primarySportSlug: user.primary_sport_slug || 'cricket',
    primaryPosition: user.primary_position || 'All-Rounder',
    jerseyNumber: user.jersey_number || null,
    battingStyle: user.batting_style || 'Right-hand bat',
    bowlingStyle: user.bowling_style || 'Right-arm medium',
    preferredHandFoot: user.preferred_hand_foot || 'Right',
    experienceLevel: user.experience_level || 'Club',
    skillCategory: user.skill_category || 'Amateur',
    canEdit: Boolean(isSelf || isAdmin),

    // Protected Private Details (Null for spectators)
    contact: {
      phone: showPrivate ? user.phone : null,
      email: showPrivate ? user.email : null,
      address: showPrivate ? user.address : null,
      postalCode: showPrivate ? user.postal_code : null,
      emergencyContactName: showPrivate ? user.emergency_contact_name : null,
      emergencyContactPhone: showPrivate ? user.emergency_contact_phone : null
    },

    // Authoritative Career Totals
    careerStats: {
      cricket: cricketCareer,
      football: footballCareer,
      badminton: badmintonCareer,
      pickleball: pickleballCareer
    },

    sportsProfiles: sportsProfiles.map(sp => ({
      sportSlug: sp.sport_slug,
      sportName: sp.sport_name,
      sportIcon: sp.sport_icon,
      jerseyNumber: sp.jersey_number,
      position: sp.primary_position,
      dominantSide: sp.dominant_hand_foot,
      matchesPlayed: sp.matches_played,
      bio: sp.bio,
      stats: typeof sp.stats === 'string' ? JSON.parse(sp.stats) : (sp.stats || {})
    })),

    teams: teams.map(t => ({
      id: t.public_id,
      name: t.name,
      logoUrl: t.logo_url,
      sportName: t.sport_name,
      role: t.role,
      position: t.position || 'Player',
      jerseyNumber: t.jersey_number,
      isCaptain: Boolean(t.is_captain)
    })),

    awardsWon,
    matchHistory
  };
}

/**
 * 7. Update Player Profile.
 */
async function updatePlayerProfile(userId, data, requestingUser) {
  const isSelf = requestingUser && Number(requestingUser.id) === Number(userId);
  const isAdmin = requestingUser && requestingUser.role === 'ADMIN';
  if (!isSelf && !isAdmin) {
    throw { statusCode: 403, message: 'Forbidden. You can only edit your own player profile.' };
  }

  const {
    fullName,
    profilePhoto,
    dob,
    gender,
    city,
    state,
    country,
    address,
    postalCode,
    emergencyContactName,
    emergencyContactPhone,
    primarySportSlug,
    battingStyle,
    bowlingStyle,
    preferredHandFoot,
    experienceLevel,
    skillCategory,
    jerseyNumber,
    primaryPosition,
    bio
  } = data;

  await db.query(
    `UPDATE users SET
      full_name = COALESCE(?, full_name),
      profile_photo = COALESCE(?, profile_photo),
      dob = COALESCE(?, dob),
      gender = COALESCE(?, gender),
      city = COALESCE(?, city),
      state = COALESCE(?, state),
      country = COALESCE(?, country),
      address = COALESCE(?, address),
      postal_code = COALESCE(?, postal_code),
      emergency_contact_name = COALESCE(?, emergency_contact_name),
      emergency_contact_phone = COALESCE(?, emergency_contact_phone),
      primary_sport_slug = COALESCE(?, primary_sport_slug),
      batting_style = COALESCE(?, batting_style),
      bowling_style = COALESCE(?, bowling_style),
      preferred_hand_foot = COALESCE(?, preferred_hand_foot),
      experience_level = COALESCE(?, experience_level),
      skill_category = COALESCE(?, skill_category),
      jersey_number = COALESCE(?, jersey_number),
      primary_position = COALESCE(?, primary_position)
     WHERE id = ?`,
    [
      fullName ? fullName.trim() : null,
      profilePhoto,
      dob,
      gender,
      city,
      state,
      country,
      address,
      postalCode,
      emergencyContactName,
      emergencyContactPhone,
      primarySportSlug,
      battingStyle,
      bowlingStyle,
      preferredHandFoot,
      experienceLevel,
      skillCategory,
      jerseyNumber,
      primaryPosition,
      userId
    ]
  );

  return await getPlayerProfile(userId, requestingUser);
}

/**
 * 8. Search Players across sports, cities, and roles.
 */
async function searchPlayers({ query = '', sport = '', city = '', role = '', limit = 30 }) {
  const conditions = ["u.status = 'ACTIVE'"];
  const params = [];

  if (query && query.trim()) {
    conditions.push('(u.full_name LIKE ? OR u.phone LIKE ? OR tm.name LIKE ?)');
    params.push(`%${query.trim()}%`, `%${query.trim()}%`, `%${query.trim()}%`);
  }
  if (sport && sport.trim()) {
    conditions.push('(u.primary_sport_slug = ? OR s.slug = ?)');
    params.push(sport.trim(), sport.trim());
  }
  if (city && city.trim()) {
    conditions.push('u.city LIKE ?');
    params.push(`%${city.trim()}%`);
  }
  if (role && role.trim()) {
    conditions.push('(u.primary_position LIKE ? OR mem.role LIKE ?)');
    params.push(`%${role.trim()}%`, `%${role.trim()}%`);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);

  const sql = `
    SELECT DISTINCT
      u.id,
      u.full_name,
      u.profile_photo,
      u.city,
      u.primary_sport_slug,
      u.primary_position,
      u.jersey_number,
      u.experience_level,
      tm.name as current_team_name,
      tm.uuid as current_team_id
    FROM users u
    LEFT JOIN team_members mem ON u.id = mem.user_id
    LEFT JOIN teams tm ON mem.team_id = tm.id
    LEFT JOIN sports s ON tm.sport_id = s.id
    ${whereClause}
    ORDER BY u.id DESC
    LIMIT ?
  `;

  params.push(safeLimit);
  const rows = await db.query(sql, params);

  return rows.map(r => ({
    id: r.id,
    fullName: r.full_name,
    profilePhoto: r.profile_photo,
    city: r.city || 'India',
    sportSlug: r.primary_sport_slug || 'cricket',
    position: r.primary_position || 'Player',
    jerseyNumber: r.jersey_number,
    experienceLevel: r.experience_level || 'Club',
    currentTeam: r.current_team_name ? { id: r.current_team_id, name: r.current_team_name } : null
  }));
}

module.exports = {
  computeTournamentAwards,
  getTournamentAwards,
  overrideAward,
  calculateCricketCareerStats,
  calculateFootballCareerStats,
  calculateRacketCareerStats,
  getPlayerProfile,
  updatePlayerProfile,
  getPlayerMatchHistory,
  searchPlayers
};

