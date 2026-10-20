const db = require('../config/database');
const crypto = require('crypto');
const { broadcastPickleballScore } = require('./socketService');

/**
 * Helper to fetch internal tournament ID and basic info from UUID or ID.
 */
const getTournamentEntity = async (tournamentId) => {
  const rows = await db.query(
    `SELECT t.id, t.uuid, t.name, t.match_format, t.target_score, t.win_by_two, 
            t.max_score, t.roster_size, t.groups_count, t.status, t.created_by,
            s.slug as sport_slug
     FROM tournaments t
     JOIN sports s ON t.sport_id = s.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentId, isNaN(tournamentId) ? -1 : parseInt(tournamentId, 10)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
};

/**
 * 1. Get tournament groups and teams assigned to each group.
 */
const getTournamentGroups = async (tournamentId) => {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  const teams = await db.query(
    `SELECT 
      tm.id as internal_team_id,
      tm.uuid as id,
      tm.name,
      tm.logo_url as logoUrl,
      tt.seed_number as seed,
      COALESCE(tt.group_name, 'Group 1') as groupName,
      tt.registration_status as status,
      (SELECT COUNT(*) FROM team_members mem WHERE mem.team_id = tm.id) as playerCount
     FROM tournament_teams tt
     JOIN teams tm ON tt.team_id = tm.id
     WHERE tt.tournament_id = ?
     ORDER BY tt.group_name ASC, tt.seed_number ASC, tm.name ASC`,
    [tournament.id]
  );

  const groups = {};
  const numGroups = tournament.groups_count || 2;
  for (let i = 1; i <= numGroups; i++) {
    groups[`Group ${i}`] = [];
  }

  teams.forEach((team) => {
    const gName = team.groupName || 'Group 1';
    if (!groups[gName]) {
      groups[gName] = [];
    }
    groups[gName].push(team);
  });

  return {
    tournamentId: tournament.uuid,
    tournamentName: tournament.name,
    groupsCount: numGroups,
    matchFormat: tournament.match_format || 'DOUBLES',
    groups
  };
};

/**
 * 2. Update group assignments (manual or auto-distribute).
 */
const updateGroupAssignments = async (tournamentId, { assignments, autoDistribute, groupsCount }, user) => {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  // Check if matches have already started
  const liveOrCompletedMatches = await db.query(
    `SELECT id FROM tournament_matches 
     WHERE tournament_id = ? AND status IN ('LIVE', 'COMPLETED', 'PAUSED') LIMIT 1`,
    [tournament.id]
  );
  if (liveOrCompletedMatches && liveOrCompletedMatches.length > 0) {
    throw { statusCode: 400, message: 'Cannot modify groups after tournament matches have started.' };
  }

  const numGroups = Math.max(1, parseInt(groupsCount || tournament.groups_count || 2, 10));
  if (groupsCount && groupsCount !== tournament.groups_count) {
    await db.query(`UPDATE tournaments SET groups_count = ? WHERE id = ?`, [numGroups, tournament.id]);
  }

  if (autoDistribute) {
    // Auto-distribute registered teams evenly across N groups
    const teams = await db.query(
      `SELECT tm.id as team_id 
       FROM tournament_teams tt
       JOIN teams tm ON tt.team_id = tm.id
       WHERE tt.tournament_id = ?
       ORDER BY tt.seed_number ASC, tm.name ASC`,
      [tournament.id]
    );

    if (teams.length === 0) {
      throw { statusCode: 400, message: 'No registered teams to distribute.' };
    }

    for (let i = 0; i < teams.length; i++) {
      const groupNum = (i % numGroups) + 1;
      const groupName = `Group ${groupNum}`;
      await db.query(
        `UPDATE tournament_teams SET group_name = ? WHERE tournament_id = ? AND team_id = ?`,
        [groupName, tournament.id, teams[i].team_id]
      );
    }
  } else if (Array.isArray(assignments) && assignments.length > 0) {
    // Manual assignments: [{ teamId, groupName }]
    const assignedTeamIds = new Set();
    for (const item of assignments) {
      if (assignedTeamIds.has(item.teamId)) {
        throw { statusCode: 400, message: `Team ${item.teamId} assigned to multiple groups.` };
      }
      assignedTeamIds.add(item.teamId);

      await db.query(
        `UPDATE tournament_teams tt
         JOIN teams tm ON tt.team_id = tm.id
         SET tt.group_name = ?
         WHERE tt.tournament_id = ? AND (tm.uuid = ? OR tm.id = ?)`,
        [item.groupName || 'Group 1', tournament.id, item.teamId, isNaN(item.teamId) ? -1 : parseInt(item.teamId, 10)]
      );
    }
  }

  return await getTournamentGroups(tournament.uuid);
};

/**
 * 3. Add team with roster to tournament.
 */
const addTeamToTournament = async (tournamentId, { teamId, name, logoUrl, groupName = 'Group 1', playerNames = [] }, user) => {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  let internalTeamId = null;
  let teamUuid = null;
  let cleanName = typeof name === 'string' ? name.trim() : '';

  // 1. Try finding existing team by teamId
  if (teamId) {
    const existing = await db.query(
      'SELECT id, uuid, name, logo_url FROM teams WHERE uuid = ? OR id = ?',
      [teamId, /^\d+$/.test(String(teamId)) ? parseInt(teamId, 10) : -1]
    );
    if (existing && existing.length > 0) {
      internalTeamId = existing[0].id;
      teamUuid = existing[0].uuid;
      cleanName = cleanName || existing[0].name;
      logoUrl = logoUrl || existing[0].logo_url;
    }
  }

  // 2. Try finding existing team by name if no teamId provided
  if (!internalTeamId && cleanName) {
    const existingByName = await db.query(
      'SELECT id, uuid, name, logo_url FROM teams WHERE LOWER(name) = LOWER(?) LIMIT 1',
      [cleanName]
    );
    if (existingByName && existingByName.length > 0) {
      internalTeamId = existingByName[0].id;
      teamUuid = existingByName[0].uuid;
      cleanName = existingByName[0].name;
      logoUrl = logoUrl || existingByName[0].logo_url;
    }
  }

  // 3. If neither found, ensure a valid name is provided
  if (!internalTeamId && (!cleanName || cleanName.length === 0)) {
    throw { statusCode: 400, message: 'Team name is required.' };
  }

  // 4. Validate duplicate registration in this tournament
  if (internalTeamId) {
    const existingInTournament = await db.query(
      `SELECT id FROM tournament_teams WHERE tournament_id = ? AND team_id = ?`,
      [tournament.id, internalTeamId]
    );
    if (existingInTournament && existingInTournament.length > 0) {
      throw { statusCode: 400, message: `Team "${cleanName}" is already registered in this tournament.` };
    }
  } else {
    const existingNameInTournament = await db.query(
      `SELECT tm.id FROM tournament_teams tt
       JOIN teams tm ON tt.team_id = tm.id
       WHERE tt.tournament_id = ? AND LOWER(tm.name) = LOWER(?)`,
      [tournament.id, cleanName]
    );
    if (existingNameInTournament && existingNameInTournament.length > 0) {
      throw { statusCode: 400, message: `A team named "${cleanName}" is already registered in this tournament.` };
    }
  }

  const defaultLogo = logoUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(cleanName)}&background=10b981&color=fff`;

  // 5. Create team if it does not exist
  if (!internalTeamId) {
    teamUuid = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO teams (uuid, name, logo_url, sport_id, captain_id, status)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      [teamUuid, cleanName, defaultLogo, tournament.sport_id || 1, user ? user.id : 1]
    );
    internalTeamId = result.insertId;
  }

  // 6. Assign team to tournament
  await db.query(
    `INSERT INTO tournament_teams (tournament_id, team_id, registration_status, payment_status, group_name)
     VALUES (?, ?, 'APPROVED', 'PAID', ?)`,
    [tournament.id, internalTeamId, groupName || 'Group 1']
  );

  // 7. Add roster players if team doesn't have members or custom players passed
  const existingMembers = await db.query(
    'SELECT id FROM team_members WHERE team_id = ?',
    [internalTeamId]
  );

  let finalRosterCount = existingMembers ? existingMembers.length : 0;

  if (finalRosterCount === 0 || (Array.isArray(playerNames) && playerNames.length > 0)) {
    const roster = Array.isArray(playerNames) && playerNames.length > 0
      ? playerNames
      : (finalRosterCount === 0 ? Array.from({ length: tournament.roster_size || 12 }, (_, i) => `${cleanName} Player ${i + 1}`) : []);

    for (let idx = 0; idx < roster.length; idx++) {
      const pName = typeof roster[idx] === 'string' ? roster[idx].trim() : (roster[idx].name || `Player ${idx + 1}`);
      const role = idx === 0 ? 'CAPTAIN' : (idx === 1 ? 'VICE_CAPTAIN' : 'PLAYER');
      const isCap = idx === 0 ? 1 : 0;
      const isViceCap = idx === 1 ? 1 : 0;
      const pRole = typeof roster[idx] === 'object' && (roster[idx].position || roster[idx].role) ? (roster[idx].position || roster[idx].role) : null;
      await db.query(
        `INSERT INTO team_members (team_id, user_id, player_name, role, jersey_number, is_captain, is_vice_captain, position)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        [internalTeamId, pName, role, finalRosterCount + idx + 1, isCap, isViceCap, pRole]
      );
    }
    finalRosterCount += roster.length;
  }

  return {
    id: teamUuid,
    name: cleanName,
    logoUrl: defaultLogo,
    groupName: groupName || 'Group 1',
    rosterSize: finalRosterCount
  };
};

/**
 * 4. Generate Group-Stage Fixtures (Complete Round-Robin or Custom).
 */
const generateFixtures = async (tournamentId, { mode = 'ROUND_ROBIN', customMatches = [], courtName = 'Court 1' }, user) => {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  // Check if matches have started
  const liveOrCompletedMatches = await db.query(
    `SELECT id FROM tournament_matches 
     WHERE tournament_id = ? AND status IN ('LIVE', 'COMPLETED', 'PAUSED') LIMIT 1`,
    [tournament.id]
  );
  if (liveOrCompletedMatches && liveOrCompletedMatches.length > 0) {
    throw { statusCode: 400, message: 'Cannot regenerate fixtures after matches have started.' };
  }

  // Delete previously generated SCHEDULED matches for this tournament to ensure idempotency
  await db.query(
    `DELETE FROM tournament_matches WHERE tournament_id = ? AND status = 'SCHEDULED'`,
    [tournament.id]
  );

  const fixturesToInsert = [];

  if (mode === 'ROUND_ROBIN') {
    // Group-stage round-robin: within each group, every team plays every other team once
    const teams = await db.query(
      `SELECT tm.id, tm.name, COALESCE(tt.group_name, 'Group 1') as group_name
       FROM tournament_teams tt
       JOIN teams tm ON tt.team_id = tm.id
       WHERE tt.tournament_id = ? AND tt.registration_status = 'APPROVED'
       ORDER BY tt.group_name ASC, tm.name ASC`,
      [tournament.id]
    );

    // Group teams
    const groupedTeams = {};
    for (const t of teams) {
      const g = t.group_name;
      if (!groupedTeams[g]) groupedTeams[g] = [];
      groupedTeams[g].push(t);
    }

    let matchNumber = 1;
    const baseDate = new Date();
    baseDate.setHours(9, 0, 0, 0);

    for (const groupName of Object.keys(groupedTeams).sort()) {
      const gTeams = groupedTeams[groupName];
      const n = gTeams.length;

      if (n < 2) continue; // Need at least 2 teams to generate fixtures

      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const teamA = gTeams[i];
          const teamB = gTeams[j];

          // Compute scheduled start time (staggered by 30 mins)
          const matchDateObj = new Date(baseDate.getTime() + (matchNumber - 1) * 35 * 60 * 1000);
          const matchDateStr = matchDateObj.toISOString().slice(0, 10);
          const startTimeStr = matchDateObj.toTimeString().slice(0, 8);

          fixturesToInsert.push({
            uuid: crypto.randomUUID(),
            tournament_id: tournament.id,
            match_number: matchNumber++,
            team_a_id: teamA.id,
            team_b_id: teamB.id,
            group_name: groupName,
            match_date: matchDateStr,
            start_time: startTimeStr,
            status: 'SCHEDULED'
          });
        }
      }
    }
  } else if (mode === 'CUSTOM' && Array.isArray(customMatches)) {
    let matchNumber = 1;
    for (const m of customMatches) {
      if (!m.teamAId || !m.teamBId || m.teamAId === m.teamBId) continue;
      fixturesToInsert.push({
        uuid: crypto.randomUUID(),
        tournament_id: tournament.id,
        match_number: matchNumber++,
        team_a_id: m.teamAId,
        team_b_id: m.teamBId,
        group_name: m.groupName || 'Group 1',
        match_date: m.date || new Date().toISOString().slice(0, 10),
        start_time: m.startTime || '10:00:00',
        status: 'SCHEDULED'
      });
    }
  }

  // Insert fixtures
  for (const f of fixturesToInsert) {
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, team_a_id, team_b_id,
        group_name, match_date, start_time, status, live_score_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Yet to Start')`,
      [f.uuid, f.tournament_id, f.match_number, f.team_a_id, f.team_b_id, f.group_name, f.match_date, f.start_time, f.status]
    );
  }

  // Also initialize standings for all tournament teams
  await recalculateStandings(tournament.id);

  return {
    success: true,
    message: `Generated ${fixturesToInsert.length} fixtures successfully.`,
    totalFixtures: fixturesToInsert.length
  };
};

/**
 * 5. Compute authoritative Group Standings.
 * Ranking Rules:
 *  1. Matches Won (DESC)
 *  2. Points Scored (PF) (DESC)
 *  3. Head-to-Head between tied teams
 *  4. Point Difference (PD) (DESC)
 *  5. Team Name (ASC)
 */
const recalculateStandings = async (internalTournamentId) => {
  // 1. Fetch all teams in tournament
  const teams = await db.query(
    `SELECT tm.id as team_id, tm.uuid as team_uuid, tm.name as team_name, tm.logo_url,
            COALESCE(tt.group_name, 'Group 1') as group_name
     FROM tournament_teams tt
     JOIN teams tm ON tt.team_id = tm.id
     WHERE tt.tournament_id = ? AND tt.registration_status = 'APPROVED'`,
    [internalTournamentId]
  );

  // 2. Fetch all COMPLETED matches
  const completedMatches = await db.query(
    `SELECT id, team_a_id, team_b_id, team_a_score, team_b_score, winner_team_id, group_name
     FROM tournament_matches
     WHERE tournament_id = ? AND status = 'COMPLETED'`,
    [internalTournamentId]
  );

  // 3. Aggregate stats per team
  const statsMap = {};
  teams.forEach(t => {
    statsMap[t.team_id] = {
      teamId: t.team_uuid,
      internalId: t.team_id,
      teamName: t.team_name,
      logoUrl: t.logo_url,
      groupName: t.group_name,
      played: 0,
      won: 0,
      lost: 0,
      pointsScored: 0,
      pointsConceded: 0,
      pointDifference: 0,
      points: 0
    };
  });

  completedMatches.forEach(m => {
    const a = statsMap[m.team_a_id];
    const b = statsMap[m.team_b_id];
    const aScore = m.team_a_score || 0;
    const bScore = m.team_b_score || 0;

    if (a) {
      a.played += 1;
      a.pointsScored += aScore;
      a.pointsConceded += bScore;
      if (m.winner_team_id === m.team_a_id) {
        a.won += 1;
        a.points += 2;
      } else if (m.winner_team_id === m.team_b_id) {
        a.lost += 1;
      }
    }

    if (b) {
      b.played += 1;
      b.pointsScored += bScore;
      b.pointsConceded += aScore;
      if (m.winner_team_id === m.team_b_id) {
        b.won += 1;
        b.points += 2;
      } else if (m.winner_team_id === m.team_a_id) {
        b.lost += 1;
      }
    }
  });

  // Calculate point difference
  Object.values(statsMap).forEach(s => {
    s.pointDifference = s.pointsScored - s.pointsConceded;
  });

  // 4. Group teams and sort
  const groups = {};
  Object.values(statsMap).forEach(s => {
    if (!groups[s.groupName]) groups[s.groupName] = [];
    groups[s.groupName].push(s);
  });

  const finalStandings = {};

  for (const groupName of Object.keys(groups)) {
    const list = groups[groupName];

    list.sort((x, y) => {
      // Rule 1: Matches won
      if (y.won !== x.won) return y.won - x.won;

      // Rule 2: Higher points scored (PF)
      if (y.pointsScored !== x.pointsScored) return y.pointsScored - x.pointsScored;

      // Rule 3: Head-to-Head between x and y
      const h2h = completedMatches.find(m =>
        (m.team_a_id === x.internalId && m.team_b_id === y.internalId) ||
        (m.team_a_id === y.internalId && m.team_b_id === x.internalId)
      );
      if (h2h && h2h.winner_team_id) {
        if (h2h.winner_team_id === x.internalId) return -1;
        if (h2h.winner_team_id === y.internalId) return 1;
      }

      // Rule 4: Better point difference (PD)
      if (y.pointDifference !== x.pointDifference) return y.pointDifference - x.pointDifference;

      // Rule 5: Team name alphabetical
      return x.teamName.localeCompare(y.teamName);
    });

    // Assign rank and sync with points_table in database
    list.forEach((team, idx) => {
      team.rank = idx + 1;
    });

    finalStandings[groupName] = list;

    // Sync into `points_table`
    for (const t of list) {
      await db.query(
        `INSERT INTO points_table (
          tournament_id, team_id, matches_played, won, lost, points,
          group_name, points_scored, points_conceded, point_difference
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
          matches_played = VALUES(matches_played),
          won = VALUES(won),
          lost = VALUES(lost),
          points = VALUES(points),
          group_name = VALUES(group_name),
          points_scored = VALUES(points_scored),
          points_conceded = VALUES(points_conceded),
          point_difference = VALUES(point_difference)`,
        [
          internalTournamentId, t.internalId, t.played, t.won, t.lost, t.points,
          groupName, t.pointsScored, t.pointsConceded, t.pointDifference
        ]
      );
    }
  }

  return finalStandings;
};

/**
 * 6. Get tournament standings by tournament public ID.
 */
const getTournamentStandings = async (tournamentId) => {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  const standings = await recalculateStandings(tournament.id);
  return {
    tournamentId: tournament.uuid,
    tournamentName: tournament.name,
    rankingRules: [
      'Rule 1: Most matches won',
      'Rule 2: Higher cumulative points scored (PF)',
      'Rule 3: Head-to-head match result between tied teams',
      'Rule 4: Better point difference (PD)'
    ],
    standings
  };
};

/**
 * Helper to fetch match entity by public ID.
 */
const getMatchEntity = async (matchId) => {
  const rows = await db.query(
    `SELECT tm.id, tm.uuid, tm.tournament_id, tm.match_number, tm.status,
            tm.team_a_id, tm.team_b_id, tm.team_a_score, tm.team_b_score,
            tm.team_a_lineup, tm.team_b_lineup, tm.group_name, tm.winner_team_id,
            tm.result_summary, tm.live_score_summary,
            t.uuid as tournament_uuid, t.name as tournament_name,
            t.match_format, t.target_score, t.win_by_two, t.max_score,
            ta.uuid as team_a_uuid, ta.name as team_a_name, ta.logo_url as team_a_logo,
            tb.uuid as team_b_uuid, tb.name as team_b_name, tb.logo_url as team_b_logo
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchId, isNaN(matchId) ? -1 : parseInt(matchId, 10)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
};

/**
 * 7. Get full Pickleball Scorer state for match.
 */
const getScorerState = async (matchId) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  // Fetch full squad for team A
  const squadA = await db.query(
    `SELECT tm.id, tm.role, tm.jersey_number,
            COALESCE(u.full_name, tm.player_name, 'Player') as name,
            tm.user_id
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [m.team_a_id]
  );

  // Fetch full squad for team B
  const squadB = await db.query(
    `SELECT tm.id, tm.role, tm.jersey_number,
            COALESCE(u.full_name, tm.player_name, 'Player') as name,
            tm.user_id
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?`,
    [m.team_b_id]
  );

  // Fetch recent score logs
  const logs = await db.query(
    `SELECT id, sequence_number, point_to, team_a_score, team_b_score, notes, event_type, created_at
     FROM pickleball_score_logs
     WHERE match_id = ?
     ORDER BY sequence_number DESC
     LIMIT 50`,
    [m.id]
  );

  let parsedALineup = null;
  let parsedBLineup = null;
  try {
    parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
    parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
  } catch {
    // ignore
  }

  return {
    matchId: m.uuid,
    matchNumber: m.match_number,
    groupName: m.group_name || 'Group 1',
    status: m.status,
    tournament: {
      id: m.tournament_uuid,
      name: m.tournament_name
    },
    rules: {
      matchFormat: m.match_format || 'DOUBLES',
      targetScore: m.target_score != null ? m.target_score : 15,
      winByTwo: m.win_by_two != null ? Boolean(m.win_by_two) : true,
      maxScore: m.max_score || null
    },
    scores: {
      teamA: m.team_a_score || 0,
      teamB: m.team_b_score || 0
    },
    lineup: {
      teamA: parsedALineup || [],
      teamB: parsedBLineup || []
    },
    winner: m.winner_team_id ? (m.winner_team_id === m.team_a_id ? 'team_a' : 'team_b') : null,
    resultSummary: m.result_summary,
    teamA: {
      id: m.team_a_uuid,
      name: m.team_a_name,
      logo: m.team_a_logo,
      squad: squadA
    },
    teamB: {
      id: m.team_b_uuid,
      name: m.team_b_name,
      logo: m.team_b_logo,
      squad: squadB
    },
    logs
  };
};

/**
 * 8. Set active lineup before starting match.
 */
const setLineup = async (matchId, { teamALineup, teamBLineup }, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  if (m.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Cannot modify lineup of a completed match.' };
  }

  const format = m.match_format || 'DOUBLES';
  const expectedCount = format === 'SINGLES' ? 1 : 2;

  if (!Array.isArray(teamALineup) || teamALineup.length !== expectedCount) {
    throw { statusCode: 400, message: `Team A lineup must have exactly ${expectedCount} player(s) for ${format}.` };
  }
  if (!Array.isArray(teamBLineup) || teamBLineup.length !== expectedCount) {
    throw { statusCode: 400, message: `Team B lineup must have exactly ${expectedCount} player(s) for ${format}.` };
  }

  // Validate no duplicate players in the same lineup
  const aNames = new Set(teamALineup.map(p => typeof p === 'string' ? p : (p.name || p.id)));
  if (aNames.size !== expectedCount) {
    throw { statusCode: 400, message: 'Team A active lineup contains duplicate players.' };
  }
  const bNames = new Set(teamBLineup.map(p => typeof p === 'string' ? p : (p.name || p.id)));
  if (bNames.size !== expectedCount) {
    throw { statusCode: 400, message: 'Team B active lineup contains duplicate players.' };
  }

  await db.query(
    `UPDATE tournament_matches 
     SET team_a_lineup = ?, team_b_lineup = ?, status = CASE WHEN status = 'SCHEDULED' THEN 'READY' ELSE status END
     WHERE id = ?`,
    [JSON.stringify(teamALineup), JSON.stringify(teamBLineup), m.id]
  );

  return await getScorerState(m.uuid);
};

/**
 * 9. Start Match.
 */
const startMatch = async (matchId, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  if (m.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Match is already completed.' };
  }

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'LIVE', live_score_summary = '0 - 0'
     WHERE id = ?`,
    [m.id]
  );

  // Broadcast
  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: 'LIVE',
    teamAScore: m.team_a_score || 0,
    teamBScore: m.team_b_score || 0,
    isCompleted: false
  });

  return await getScorerState(m.uuid);
};

/**
 * 10. Record Point (+1 to Team A or Team B).
 */
const recordPoint = async (matchId, { pointTo, notes = 'Point scored' }, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  if (m.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Match is already completed. Score cannot be altered without correction.' };
  }

  if (!['team_a', 'team_b'].includes(pointTo)) {
    throw { statusCode: 400, message: 'Invalid pointTo value. Must be "team_a" or "team_b".' };
  }

  let newScoreA = m.team_a_score || 0;
  let newScoreB = m.team_b_score || 0;

  if (pointTo === 'team_a') {
    newScoreA += 1;
  } else {
    newScoreB += 1;
  }

  const targetScore = m.target_score != null ? m.target_score : 15;
  const winByTwo = m.win_by_two != null ? Boolean(m.win_by_two) : true;
  const maxScore = m.max_score || null;

  // Check winning condition
  let isCompleted = false;
  let winnerTeamId = null;
  let resultSummary = null;

  // Condition 1: maxScore reached
  if (maxScore && (newScoreA >= maxScore || newScoreB >= maxScore)) {
    isCompleted = true;
    winnerTeamId = newScoreA >= maxScore ? m.team_a_id : m.team_b_id;
  }
  // Condition 2: targetScore reached with win-by-two or normal
  else if (newScoreA >= targetScore || newScoreB >= targetScore) {
    const margin = Math.abs(newScoreA - newScoreB);
    if (!winByTwo || margin >= 2) {
      isCompleted = true;
      winnerTeamId = newScoreA > newScoreB ? m.team_a_id : m.team_b_id;
    }
  }

  if (isCompleted) {
    const winnerName = winnerTeamId === m.team_a_id ? m.team_a_name : m.team_b_name;
    resultSummary = `${winnerName} won ${newScoreA} - ${newScoreB}`;
  }

  const newStatus = isCompleted ? 'COMPLETED' : 'LIVE';
  const liveScoreSummary = `${newScoreA} - ${newScoreB}`;

  // Update match in database
  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = ?,
         winner_team_id = ?, result_summary = ?, live_score_summary = ?,
         end_time = CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIME ELSE end_time END
     WHERE id = ?`,
    [newScoreA, newScoreB, newStatus, winnerTeamId, resultSummary, liveScoreSummary, newStatus, m.id]
  );

  // Get next sequence number
  const lastSeqRows = await db.query(
    `SELECT MAX(sequence_number) as max_seq FROM pickleball_score_logs WHERE match_id = ?`,
    [m.id]
  );
  const nextSeq = (lastSeqRows[0]?.max_seq || 0) + 1;

  // Insert log
  await db.query(
    `INSERT INTO pickleball_score_logs (
      match_id, sequence_number, point_to, team_a_score, team_b_score, scorer_id, event_type, notes
    ) VALUES (?, ?, ?, ?, ?, ?, 'POINT', ?)`,
    [m.id, nextSeq, pointTo, newScoreA, newScoreB, user ? user.id : null, notes]
  );

  // Recalculate standings if completed
  if (isCompleted) {
    await recalculateStandings(m.tournament_id);
  }

  const state = await getScorerState(m.uuid);

  // Broadcast real-time
  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: newStatus,
    type: 'POINT',
    eventSeq: nextSeq,
    teamAScore: newScoreA,
    teamBScore: newScoreB,
    scoreSummary: `${newScoreA} - ${newScoreB}`,
    winnerTeamId,
    resultSummary,
    isCompleted,
    state
  });

  return state;
};

/**
 * 11. Undo Last Score Action safely.
 */
const undoPoint = async (matchId, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  // Fetch the latest log
  const latestLogs = await db.query(
    `SELECT id, sequence_number, team_a_score, team_b_score 
     FROM pickleball_score_logs 
     WHERE match_id = ? 
     ORDER BY sequence_number DESC LIMIT 2`,
    [m.id]
  );

  if (!latestLogs || latestLogs.length === 0) {
    throw { statusCode: 400, message: 'No scoring actions to undo.' };
  }

  const currentLog = latestLogs[0];
  const prevLog = latestLogs.length > 1 ? latestLogs[1] : null;

  const revertedA = prevLog ? prevLog.team_a_score : 0;
  const revertedB = prevLog ? prevLog.team_b_score : 0;

  // Delete the undone log
  await db.query(`DELETE FROM pickleball_score_logs WHERE id = ?`, [currentLog.id]);

  const liveScoreSummary = `${revertedA} - ${revertedB}`;

  // If match was COMPLETED, undo re-opens it to LIVE
  const wasCompleted = m.status === 'COMPLETED';

  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = 'LIVE',
         winner_team_id = NULL, result_summary = NULL, live_score_summary = ?
     WHERE id = ?`,
    [revertedA, revertedB, liveScoreSummary, m.id]
  );

  if (wasCompleted) {
    await recalculateStandings(m.tournament_id);
  }

  const state = await getScorerState(m.uuid);

  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: 'LIVE',
    type: 'UNDO',
    eventSeq: Date.now(),
    teamAScore: revertedA,
    teamBScore: revertedB,
    scoreSummary: liveScoreSummary,
    winnerTeamId: null,
    resultSummary: null,
    isCompleted: false,
    state
  });

  return state;
};

/**
 * 12. Correct Score (Authorized Correction Workflow).
 */
const correctScore = async (matchId, { teamAScore, teamBScore, notes = 'Score Correction' }, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  const newScoreA = Math.max(0, parseInt(teamAScore, 10) || 0);
  const newScoreB = Math.max(0, parseInt(teamBScore, 10) || 0);

  const targetScore = m.target_score != null ? m.target_score : 15;
  const winByTwo = m.win_by_two != null ? Boolean(m.win_by_two) : true;
  const maxScore = m.max_score || null;

  let isCompleted = false;
  let winnerTeamId = null;
  let resultSummary = null;

  if (maxScore && (newScoreA >= maxScore || newScoreB >= maxScore)) {
    isCompleted = true;
    winnerTeamId = newScoreA >= maxScore ? m.team_a_id : m.team_b_id;
  } else if (newScoreA >= targetScore || newScoreB >= targetScore) {
    const margin = Math.abs(newScoreA - newScoreB);
    if (!winByTwo || margin >= 2) {
      isCompleted = true;
      winnerTeamId = newScoreA > newScoreB ? m.team_a_id : m.team_b_id;
    }
  }

  if (isCompleted) {
    const winnerName = winnerTeamId === m.team_a_id ? m.team_a_name : m.team_b_name;
    resultSummary = `${winnerName} won ${newScoreA} - ${newScoreB}`;
  }

  const newStatus = isCompleted ? 'COMPLETED' : 'LIVE';
  const liveScoreSummary = `${newScoreA} - ${newScoreB}`;

  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = ?,
         winner_team_id = ?, result_summary = ?, live_score_summary = ?
     WHERE id = ?`,
    [newScoreA, newScoreB, newStatus, winnerTeamId, resultSummary, liveScoreSummary, m.id]
  );

  const lastSeqRows = await db.query(
    `SELECT MAX(sequence_number) as max_seq FROM pickleball_score_logs WHERE match_id = ?`,
    [m.id]
  );
  const nextSeq = (lastSeqRows[0]?.max_seq || 0) + 1;

  await db.query(
    `INSERT INTO pickleball_score_logs (
      match_id, sequence_number, point_to, team_a_score, team_b_score, scorer_id, event_type, notes
    ) VALUES (?, ?, 'CORRECTION', ?, ?, ?, 'CORRECTION', ?)`,
    [m.id, nextSeq, newScoreA, newScoreB, user ? user.id : null, notes]
  );

  await recalculateStandings(m.tournament_id);

  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: newStatus,
    teamAScore: newScoreA,
    teamBScore: newScoreB,
    winnerTeamId,
    resultSummary,
    isCompleted
  });

  return await getScorerState(m.uuid);
};

module.exports = {
  getTournamentGroups,
  updateGroupAssignments,
  addTeamToTournament,
  generateFixtures,
  getTournamentStandings,
  recalculateStandings,
  getScorerState,
  setLineup,
  startMatch,
  recordPoint,
  undoPoint,
  correctScore
};
