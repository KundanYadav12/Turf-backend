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
    const { resolveTeamId } = require('./fixtureService');
    let matchNumber = 1;
    for (const m of customMatches) {
      if (!m.teamAId || !m.teamBId || m.teamAId === m.teamBId) continue;
      const resolvedA = await resolveTeamId(m.teamAId);
      const resolvedB = await resolveTeamId(m.teamBId);
      if (!resolvedA || !resolvedB) continue;

      fixturesToInsert.push({
        uuid: crypto.randomUUID(),
        tournament_id: tournament.id,
        match_number: matchNumber++,
        team_a_id: resolvedA,
        team_b_id: resolvedB,
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
 *  2. Higher Points Scored (PF) (DESC)
 *  3. Head-to-Head between tied teams
 *  4. Point Difference (PD) (DESC)
 *  5. Team Name (ASC)
 */
const recalculateStandings = async (internalTournamentId, options = {}) => {
  const tournamentEngineService = require('./tournamentEngineService');
  await tournamentEngineService.recalculateStandings(internalTournamentId, options);
  const data = await tournamentEngineService.getTournamentStandings(internalTournamentId);
  return data.groups || data.standings || {};
};

/**
 * 6. Get tournament standings by tournament public ID.
 */
const getTournamentStandings = async (tournamentId) => {
  const tournamentEngineService = require('./tournamentEngineService');
  return await tournamentEngineService.getTournamentStandings(tournamentId);
};

/**
 * Deterministically calculates player positions ('RIGHT' | 'LEFT') for a pickleball doubles team
 * based strictly on the team's score parity and immutable starting positions.
 *
 * Rules:
 * - Even team score (0, 2, 4, 6, 8, 10, 12, 14...):
 *     Player who started on RIGHT occupies RIGHT-side position.
 *     Player who started on LEFT occupies LEFT-side position.
 * - Odd team score (1, 3, 5, 7, 9, 11, 13, 15...):
 *     Player who started on RIGHT occupies LEFT-side position.
 *     Player who started on LEFT occupies RIGHT-side position.
 */
function calculatePickleballDoublesPositions(teamScore, originalPlayerPositions) {
  const score = Math.max(0, parseInt(teamScore, 10) || 0);
  const isEven = (score % 2 === 0);

  let rightPlayerId = null;
  let leftPlayerId = null;

  if (Array.isArray(originalPlayerPositions)) {
    if (originalPlayerPositions.length >= 2) {
      const p0 = originalPlayerPositions[0];
      const p1 = originalPlayerPositions[1];
      const p0Id = (typeof p0 === 'object' && p0 !== null) ? (p0.name || p0.id) : String(p0);
      const p1Id = (typeof p1 === 'object' && p1 !== null) ? (p1.name || p1.id) : String(p1);
      const p0Court = (typeof p0 === 'object' && p0?.startCourt) ? String(p0.startCourt).toUpperCase() : 'RIGHT';
      if (p0Court === 'RIGHT') {
        rightPlayerId = p0Id;
        leftPlayerId = p1Id;
      } else {
        rightPlayerId = p1Id;
        leftPlayerId = p0Id;
      }
    } else if (originalPlayerPositions.length === 1) {
      const p0 = originalPlayerPositions[0];
      rightPlayerId = (typeof p0 === 'object' && p0 !== null) ? (p0.name || p0.id) : String(p0);
    }
  } else if (originalPlayerPositions && typeof originalPlayerPositions === 'object') {
    for (const [id, court] of Object.entries(originalPlayerPositions)) {
      if (String(court).toUpperCase() === 'RIGHT') rightPlayerId = id;
      else if (String(court).toUpperCase() === 'LEFT') leftPlayerId = id;
    }
    if (!rightPlayerId && !leftPlayerId) {
      const keys = Object.keys(originalPlayerPositions);
      rightPlayerId = keys[0];
      leftPlayerId = keys[1];
    }
  }

  const result = {};
  if (rightPlayerId && leftPlayerId) {
    if (isEven) {
      result[rightPlayerId] = 'RIGHT';
      result[leftPlayerId] = 'LEFT';
    } else {
      result[rightPlayerId] = 'LEFT';
      result[leftPlayerId] = 'RIGHT';
    }
  } else if (rightPlayerId) {
    result[rightPlayerId] = isEven ? 'RIGHT' : 'LEFT';
  }
  return result;
}

/**
 * Computes authoritative court state, player positions, serving team, server, and active service box.
 */
function computeAuthoritativeCourtState({
  format = 'DOUBLES',
  scoringMode = 'RALLY',
  rotationRule = 'OFFICIAL',
  scores = { teamA: 0, teamB: 0 },
  lineup = { teamA: [], teamB: [] },
  servingTeam = 'teamA',
  serverNumber = 1,
  teamA = { name: 'Team A' },
  teamB = { name: 'Team B' },
  existingPlayerLocations = null,
  startingServingTeam = 'teamA'
}) {
  const isDoubles = format !== 'SINGLES';
  const isBadmintonRule = String(rotationRule || '').toUpperCase() === 'BADMINTON' || String(rotationRule || '').toUpperCase() === 'BADMINTON_STYLE';
  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const scoreA = Math.max(0, parseInt(scores.teamA, 10) || 0);
  const scoreB = Math.max(0, parseInt(scores.teamB, 10) || 0);

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

  const originalPositionsA = isDoubles ? { [pA1]: pA1Court, [pA2]: pA2Court } : { [pA1]: 'RIGHT' };
  const originalPositionsB = isDoubles ? { [pB1]: pB1Court, [pB2]: pB2Court } : { [pB1]: 'RIGHT' };

  let playerLocations = {};
  if (existingPlayerLocations && typeof existingPlayerLocations === 'object' && Object.keys(existingPlayerLocations).length > 0) {
    playerLocations = { ...existingPlayerLocations };
  } else if (isDoubles) {
    if (scoreA > 0 || scoreB > 0) {
      const posA = calculatePickleballDoublesPositions(scoreA, originalPositionsA);
      const posB = calculatePickleballDoublesPositions(scoreB, originalPositionsB);
      playerLocations = { ...posA, ...posB };
    } else {
      playerLocations[pA1] = pA1Court;
      playerLocations[pA2] = pA2Court;
      playerLocations[pB1] = pB1Court;
      playerLocations[pB2] = pB2Court;
    }
  } else {
    playerLocations[pA1] = (scoreA % 2 === 0) ? 'RIGHT' : 'LEFT';
    playerLocations[pB1] = (scoreB % 2 === 0) ? 'RIGHT' : 'LEFT';
  }

  // Ensure dual keying by ID as well if member objects provided
  if (typeof rawA[0] === 'object' && rawA[0]?.id && playerLocations[pA1]) playerLocations[rawA[0].id] = playerLocations[pA1];
  if (typeof rawA[1] === 'object' && rawA[1]?.id && playerLocations[pA2]) playerLocations[rawA[1].id] = playerLocations[pA2];
  if (typeof rawB[0] === 'object' && rawB[0]?.id && playerLocations[pB1]) playerLocations[rawB[0].id] = playerLocations[pB1];
  if (typeof rawB[1] === 'object' && rawB[1]?.id && playerLocations[pB2]) playerLocations[rawB[1].id] = playerLocations[pB2];

  // Active serving court: Even score -> RIGHT box, Odd score -> LEFT box
  const sScore = servingTeam === 'teamA' ? scoreA : scoreB;
  const serviceCourt = (sScore % 2 === 0) ? 'RIGHT' : 'LEFT';
  const receiverCourt = serviceCourt; // Cross-court diagonal

  // Active server player
  const sPlayers = servingTeam === 'teamA'
    ? (isDoubles ? [pA1, pA2] : [pA1])
    : (isDoubles ? [pB1, pB2] : [pB1]);
  const activeServerName = sPlayers.find(p => (playerLocations[p] || playerLocations[p?.name] || playerLocations[p?.id]) === serviceCourt) || sPlayers[0];

  const rPlayers = servingTeam === 'teamA'
    ? (isDoubles ? [pB1, pB2] : [pB1])
    : (isDoubles ? [pA1, pA2] : [pA1]);
  const activeReceiverName = rPlayers.find(p => (playerLocations[p] || playerLocations[p?.name] || playerLocations[p?.id]) === receiverCourt) || rPlayers[0];

  // Screen box names (Assuming Team A on LEFT facing right, Team B on RIGHT facing left)
  // Left team: RIGHT court is bottom-left, LEFT court is top-left
  // Right team: RIGHT court is top-right, LEFT court is bottom-right
  const servingBoxName = servingTeam === 'teamA'
    ? (serviceCourt === 'RIGHT' ? 'bottom-left' : 'top-left')
    : (serviceCourt === 'RIGHT' ? 'top-right' : 'bottom-right');

  const targetBoxName = servingTeam === 'teamA'
    ? (receiverCourt === 'RIGHT' ? 'top-right' : 'bottom-right')
    : (receiverCourt === 'RIGHT' ? 'bottom-left' : 'top-left');

  return {
    format: isDoubles ? 'DOUBLES' : 'SINGLES',
    scoringMode: isBadmintonRule ? 'RALLY' : (isSideOut ? 'SIDE_OUT' : 'RALLY'),
    rotationRule: isBadmintonRule ? 'BADMINTON' : 'OFFICIAL',
    servingTeam,
    serverNumber: isBadmintonRule ? 1 : (isSideOut && isDoubles ? (serverNumber || 1) : 1),
    serviceCourt,
    receiverCourt,
    servingBoxName,
    targetBoxName,
    activeServerName,
    activeReceiverName,
    playerLocations,
    originalPositions: {
      teamA: originalPositionsA,
      teamB: originalPositionsB
    }
  };
}

/**
 * Helper to fetch match entity by public ID.
 */
const getMatchEntity = async (matchId) => {
  const rows = await db.query(
    `SELECT tm.id, tm.uuid, tm.tournament_id, tm.match_number, tm.status,
            tm.team_a_id, tm.team_b_id, tm.team_a_score, tm.team_b_score,
            tm.team_a_lineup, tm.team_b_lineup, tm.group_name, tm.winner_team_id,
            tm.result_summary, tm.live_score_summary, tm.sport_state,
            t.uuid as tournament_uuid, t.name as tournament_name,
            t.match_format, t.target_score, t.win_by_two, t.max_score, t.sport_config, t.rules as tournament_rules,
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

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {
    // ignore
  }

  let sportState = null;
  try {
    sportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {
    // ignore
  }

  const rotationRule = sportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(rotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || sportState?.scoringMode || 'RALLY');
  const courtState = computeAuthoritativeCourtState({
    format: m.match_format || 'DOUBLES',
    scoringMode,
    rotationRule,
    scores: { teamA: m.team_a_score || 0, teamB: m.team_b_score || 0 },
    lineup: { teamA: parsedALineup || [], teamB: parsedBLineup || [] },
    servingTeam: sportState?.servingTeam || 'teamA',
    serverNumber: sportState?.serverNumber || (scoringMode === 'SIDE_OUT' && m.match_format !== 'SINGLES' ? 2 : 1),
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    existingPlayerLocations: sportState?.playerLocations || null,
    startingServingTeam: sportState?.startingServingTeam || 'teamA'
  });

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
      scoringMode,
      rotationRule,
      targetScore: m.target_score != null ? m.target_score : 15,
      winByTwo: m.win_by_two != null ? Boolean(m.win_by_two) : true,
      maxScore: m.max_score || null,
      tournamentRules: m.tournament_rules || null
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
    sportState: {
      ...(sportState || {}),
      scoringMode,
      rotationRule: courtState.rotationRule,
      servingTeam: courtState.servingTeam,
      serverNumber: courtState.serverNumber,
      serviceCourt: courtState.serviceCourt,
      receiverCourt: courtState.receiverCourt,
      servingBoxName: courtState.servingBoxName,
      targetBoxName: courtState.targetBoxName,
      activeServerName: courtState.activeServerName,
      activeReceiverName: courtState.activeReceiverName,
      playerLocations: courtState.playerLocations,
      originalPositions: courtState.originalPositions
    },
    courtState,
    logs
  };
};

/**
 * 8. Set active lineup before starting match.
 */
const setLineup = async (matchId, { teamALineup, teamBLineup, startingServingTeam = 'teamA', rotationRule }, user) => {
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

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const resolvedRotationRule = rotationRule || currentSportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(resolvedRotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');

  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const isDoubles = format !== 'SINGLES';
  const serverNumber = isBadmintonRule ? 1 : ((isSideOut && isDoubles) ? 2 : 1);

  const initialCourtState = computeAuthoritativeCourtState({
    format,
    scoringMode,
    rotationRule: resolvedRotationRule,
    scores: { teamA: m.team_a_score || 0, teamB: m.team_b_score || 0 },
    lineup: { teamA: teamALineup, teamB: teamBLineup },
    servingTeam: startingServingTeam === 'teamB' ? 'teamB' : 'teamA',
    serverNumber,
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    startingServingTeam
  });

  const sportStateToSave = {
    scoringMode,
    rotationRule: initialCourtState.rotationRule,
    servingTeam: initialCourtState.servingTeam,
    startingServingTeam: initialCourtState.servingTeam,
    serverNumber: initialCourtState.serverNumber,
    serviceCourt: initialCourtState.serviceCourt,
    receiverCourt: initialCourtState.receiverCourt,
    servingBoxName: initialCourtState.servingBoxName,
    targetBoxName: initialCourtState.targetBoxName,
    activeServerName: initialCourtState.activeServerName,
    activeReceiverName: initialCourtState.activeReceiverName,
    playerLocations: initialCourtState.playerLocations,
    originalPositions: initialCourtState.originalPositions,
    firstServeConfirmed: true
  };

  await db.query(
    `UPDATE tournament_matches 
     SET team_a_lineup = ?, team_b_lineup = ?, sport_state = ?,
         status = CASE WHEN status = 'SCHEDULED' THEN 'READY' ELSE status END
     WHERE id = ?`,
    [JSON.stringify(teamALineup), JSON.stringify(teamBLineup), JSON.stringify(sportStateToSave), m.id]
  );

  return await getScorerState(m.uuid);
};

/**
 * 9. Start Match.
 */
const startMatch = async (matchId, body = {}, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  if (m.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Match is already completed.' };
  }

  // Idempotency: If match is already LIVE, return current live state without resetting scores
  if (m.status === 'LIVE') {
    return await getScorerState(m.uuid);
  }

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const rotationRule = (body && body.rotationRule) || currentSportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(rotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');
  const format = m.match_format || 'DOUBLES';
  const isDoubles = format !== 'SINGLES';
  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const startingServingTeam = (body && (body.startingServingTeam || body.startingServeTeam)) || currentSportState?.startingServingTeam || currentSportState?.servingTeam || 'teamA';
  const serverNumber = isBadmintonRule ? 1 : ((isSideOut && isDoubles) ? 2 : 1);

  const parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : (m.team_a_lineup || []);
  const parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : (m.team_b_lineup || []);

  const initialCourtState = computeAuthoritativeCourtState({
    format,
    scoringMode,
    rotationRule,
    scores: { teamA: 0, teamB: 0 },
    lineup: { teamA: parsedALineup, teamB: parsedBLineup },
    servingTeam: startingServingTeam === 'teamB' ? 'teamB' : 'teamA',
    serverNumber,
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    startingServingTeam
  });

  const sportStateToSave = {
    scoringMode,
    rotationRule: initialCourtState.rotationRule,
    servingTeam: initialCourtState.servingTeam,
    startingServingTeam: initialCourtState.servingTeam,
    serverNumber: initialCourtState.serverNumber,
    serviceCourt: initialCourtState.serviceCourt,
    receiverCourt: initialCourtState.receiverCourt,
    servingBoxName: initialCourtState.servingBoxName,
    targetBoxName: initialCourtState.targetBoxName,
    activeServerName: initialCourtState.activeServerName,
    activeReceiverName: initialCourtState.activeReceiverName,
    playerLocations: initialCourtState.playerLocations,
    originalPositions: initialCourtState.originalPositions,
    firstServeConfirmed: true
  };

  await db.query(
    `UPDATE tournament_matches 
     SET status = 'LIVE', live_score_summary = '0 - 0', team_a_score = 0, team_b_score = 0, sport_state = ?
     WHERE id = ?`,
    [JSON.stringify(sportStateToSave), m.id]
  );

  const state = await getScorerState(m.uuid);

  // Broadcast
  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: 'LIVE',
    teamAScore: 0,
    teamBScore: 0,
    isCompleted: false,
    sportState: sportStateToSave,
    courtState: initialCourtState,
    state
  });

  return state;
};

/**
 * Deterministically reconstructs match state (scores, serving team, server number, and player court locations)
 * by replaying point logs from the match start.
 */
function replayMatchFromLogs(m, logs = []) {
  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const rotationRule = currentSportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(rotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');
  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const format = m.match_format || 'DOUBLES';
  const isDoubles = format !== 'SINGLES';

  let parsedALineup = null;
  let parsedBLineup = null;
  try {
    parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
    parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
  } catch {}

  const pA1 = typeof parsedALineup?.[0] === 'string' ? parsedALineup[0] : (parsedALineup?.[0]?.name || `${m.team_a_name || 'Team A'} 1`);
  const pA2 = typeof parsedALineup?.[1] === 'string' ? parsedALineup[1] : (parsedALineup?.[1]?.name || `${m.team_a_name || 'Team A'} 2`);
  const pB1 = typeof parsedBLineup?.[0] === 'string' ? parsedBLineup[0] : (parsedBLineup?.[0]?.name || `${m.team_b_name || 'Team B'} 1`);
  const pB2 = typeof parsedBLineup?.[1] === 'string' ? parsedBLineup[1] : (parsedBLineup?.[1]?.name || `${m.team_b_name || 'Team B'} 2`);

  const pA1Court = (typeof parsedALineup?.[0] === 'object' && parsedALineup?.[0]?.startCourt) ? String(parsedALineup[0].startCourt).toUpperCase() : 'RIGHT';
  const pA2Court = (typeof parsedALineup?.[1] === 'object' && parsedALineup?.[1]?.startCourt) ? String(parsedALineup[1].startCourt).toUpperCase() : (pA1Court === 'RIGHT' ? 'LEFT' : 'RIGHT');
  const pB1Court = (typeof parsedBLineup?.[0] === 'object' && parsedBLineup?.[0]?.startCourt) ? String(parsedBLineup[0].startCourt).toUpperCase() : 'RIGHT';
  const pB2Court = (typeof parsedBLineup?.[1] === 'object' && parsedBLineup?.[1]?.startCourt) ? String(parsedBLineup[1].startCourt).toUpperCase() : (pB1Court === 'RIGHT' ? 'LEFT' : 'RIGHT');

  let curServing = currentSportState?.startingServingTeam || 'teamA';
  let curServerNum = (isSideOut && isDoubles) ? 2 : 1;
  let scoreA = 0;
  let scoreB = 0;

  let playerLocations = {};
  if (isDoubles) {
    playerLocations[pA1] = pA1Court;
    playerLocations[pA2] = pA2Court;
    playerLocations[pB1] = pB1Court;
    playerLocations[pB2] = pB2Court;
  } else {
    playerLocations[pA1] = 'RIGHT';
    playerLocations[pB1] = 'RIGHT';
  }

  // Dual key by ID
  if (typeof parsedALineup?.[0] === 'object' && parsedALineup[0]?.id) playerLocations[parsedALineup[0].id] = playerLocations[pA1];
  if (typeof parsedALineup?.[1] === 'object' && parsedALineup[1]?.id) playerLocations[parsedALineup[1].id] = playerLocations[pA2];
  if (typeof parsedBLineup?.[0] === 'object' && parsedBLineup[0]?.id) playerLocations[parsedBLineup[0].id] = playerLocations[pB1];
  if (typeof parsedBLineup?.[1] === 'object' && parsedBLineup[1]?.id) playerLocations[parsedBLineup[1].id] = playerLocations[pB2];

  const sorted = [...logs].sort((a, b) => (a.sequence_number || 0) - (b.sequence_number || 0));
  for (const log of sorted) {
    if (log.event_type === 'CORRECTION') {
      if (log.team_a_score != null) scoreA = log.team_a_score;
      if (log.team_b_score != null) scoreB = log.team_b_score;
      continue;
    }
    const pointTo = (log.point_to === 'team_b' || log.pointTo === 'teamB') ? 'teamB' : 'teamA';
    const isServingTeamWinner = pointTo === curServing;

    if (isSideOut) {
      if (isServingTeamWinner) {
        if (pointTo === 'teamA') scoreA += 1;
        else scoreB += 1;

        if (isDoubles) {
          const sP1 = curServing === 'teamA' ? pA1 : pB1;
          const sP2 = curServing === 'teamA' ? pA2 : pB2;
          const loc1 = playerLocations[sP1] || 'RIGHT';
          const loc2 = playerLocations[sP2] || 'LEFT';
          playerLocations[sP1] = loc2;
          playerLocations[sP2] = loc1;
        }
      } else {
        if (isDoubles) {
          if (curServerNum === 1) {
            curServerNum = 2;
          } else {
            curServing = curServing === 'teamA' ? 'teamB' : 'teamA';
            curServerNum = 1;
          }
        } else {
          curServing = curServing === 'teamA' ? 'teamB' : 'teamA';
          curServerNum = 1;
        }
      }
    } else {
      // Rally scoring
      if (pointTo === 'teamA') scoreA += 1;
      else scoreB += 1;

      if (isServingTeamWinner) {
        if (isDoubles) {
          const sP1 = curServing === 'teamA' ? pA1 : pB1;
          const sP2 = curServing === 'teamA' ? pA2 : pB2;
          const loc1 = playerLocations[sP1] || 'RIGHT';
          const loc2 = playerLocations[sP2] || 'LEFT';
          playerLocations[sP1] = loc2;
          playerLocations[sP2] = loc1;
        }
      } else {
        curServing = pointTo;
        curServerNum = 1;
      }
    }

    if (!isDoubles) {
      playerLocations[pA1] = (scoreA % 2 === 0) ? 'RIGHT' : 'LEFT';
      playerLocations[pB1] = (scoreB % 2 === 0) ? 'RIGHT' : 'LEFT';
    }
  }

  // Dual key sync
  if (typeof parsedALineup?.[0] === 'object' && parsedALineup[0]?.id) playerLocations[parsedALineup[0].id] = playerLocations[pA1];
  if (typeof parsedALineup?.[1] === 'object' && parsedALineup[1]?.id) playerLocations[parsedALineup[1].id] = playerLocations[pA2];
  if (typeof parsedBLineup?.[0] === 'object' && parsedBLineup[0]?.id) playerLocations[parsedBLineup[0].id] = playerLocations[pB1];
  if (typeof parsedBLineup?.[1] === 'object' && parsedBLineup[1]?.id) playerLocations[parsedBLineup[1].id] = playerLocations[pB2];

  return {
    scores: { teamA: scoreA, teamB: scoreB },
    servingTeam: curServing,
    serverNumber: isBadmintonRule ? 1 : curServerNum,
    rotationRule: isBadmintonRule ? 'BADMINTON' : 'OFFICIAL',
    playerLocations
  };
}

/**
 * 10. Record Point (+1 to Team A or Team B).
 */
const recordPoint = async (matchId, { pointTo, notes = 'Point scored', from = null, to = null, eventId = null, seq = null }, user) => {
  // Auto-end match break when live scoring resumes
  try {
    const matchBreakService = require('./matchBreakService');
    matchBreakService.endBreak(matchId).catch(() => {});
  } catch (e) {}

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

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const rotationRule = currentSportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(rotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');
  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const isDoubles = (m.match_format || 'DOUBLES') !== 'SINGLES';

  let newScoreA = m.team_a_score || 0;
  let newScoreB = m.team_b_score || 0;
  let curServing = currentSportState?.servingTeam || 'teamA';
  let curServerNum = isBadmintonRule ? 1 : (currentSportState?.serverNumber || (isSideOut && isDoubles ? 2 : 1));
  let nextServingTeam = curServing;
  let nextServerNumber = curServerNum;

  const winningTeamKey = pointTo === 'team_a' ? 'teamA' : 'teamB';
  const isServingTeamWinner = winningTeamKey === curServing;

  let parsedALineup = null;
  let parsedBLineup = null;
  try {
    parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
    parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
  } catch {}

  const pA1 = typeof parsedALineup?.[0] === 'string' ? parsedALineup[0] : (parsedALineup?.[0]?.name || `${m.team_a_name || 'Team A'} 1`);
  const pA2 = typeof parsedALineup?.[1] === 'string' ? parsedALineup[1] : (parsedALineup?.[1]?.name || `${m.team_a_name || 'Team A'} 2`);
  const pB1 = typeof parsedBLineup?.[0] === 'string' ? parsedBLineup[0] : (parsedBLineup?.[0]?.name || `${m.team_b_name || 'Team B'} 1`);
  const pB2 = typeof parsedBLineup?.[1] === 'string' ? parsedBLineup[1] : (parsedBLineup?.[1]?.name || `${m.team_b_name || 'Team B'} 2`);

  let currentLocations = { ...(currentSportState?.playerLocations || {}) };
  if (isDoubles) {
    if (!currentLocations[pA1]) currentLocations[pA1] = 'RIGHT';
    if (!currentLocations[pA2]) currentLocations[pA2] = 'LEFT';
    if (!currentLocations[pB1]) currentLocations[pB1] = 'RIGHT';
    if (!currentLocations[pB2]) currentLocations[pB2] = 'LEFT';
  } else {
    if (!currentLocations[pA1]) currentLocations[pA1] = (newScoreA % 2 === 0) ? 'RIGHT' : 'LEFT';
    if (!currentLocations[pB1]) currentLocations[pB1] = (newScoreB % 2 === 0) ? 'RIGHT' : 'LEFT';
  }

  let nextLocations = { ...currentLocations };

  if (isSideOut) {
    if (isServingTeamWinner) {
      if (pointTo === 'team_a') newScoreA += 1;
      else newScoreB += 1;

      // Serving team partners swap courts (RIGHT <-> LEFT). Receiving team NEVER swaps!
      if (isDoubles) {
        const sP1 = curServing === 'teamA' ? pA1 : pB1;
        const sP2 = curServing === 'teamA' ? pA2 : pB2;
        const loc1 = currentLocations[sP1] || 'RIGHT';
        const loc2 = currentLocations[sP2] || 'LEFT';
        nextLocations[sP1] = loc2;
        nextLocations[sP2] = loc1;
      }
    } else {
      // Receiving team won rally in Side-Out: no score change, nobody swaps!
      if (isDoubles) {
        if (curServerNum === 1) {
          nextServerNumber = 2;
        } else {
          nextServingTeam = curServing === 'teamA' ? 'teamB' : 'teamA';
          nextServerNumber = 1;
        }
      } else {
        nextServingTeam = curServing === 'teamA' ? 'teamB' : 'teamA';
        nextServerNumber = 1;
      }
    }
  } else {
    // RALLY SCORING (Every rally awards 1 point)
    if (pointTo === 'team_a') {
      newScoreA += 1;
    } else {
      newScoreB += 1;
    }

    if (isServingTeamWinner) {
      // Serving team partners swap courts (RIGHT <-> LEFT). Receiving team NEVER swaps!
      if (isDoubles) {
        const sP1 = curServing === 'teamA' ? pA1 : pB1;
        const sP2 = curServing === 'teamA' ? pA2 : pB2;
        const loc1 = currentLocations[sP1] || 'RIGHT';
        const loc2 = currentLocations[sP2] || 'LEFT';
        nextLocations[sP1] = loc2;
        nextLocations[sP2] = loc1;
      }
    } else {
      // Receiving team won rally in Rally scoring: serve transfers with NO SWAP!
      nextServingTeam = winningTeamKey;
      nextServerNumber = 1;
    }
  }

  if (!isDoubles) {
    nextLocations[pA1] = (newScoreA % 2 === 0) ? 'RIGHT' : 'LEFT';
    nextLocations[pB1] = (newScoreB % 2 === 0) ? 'RIGHT' : 'LEFT';
  }

  // Dual key nextLocations by ID
  if (typeof parsedALineup?.[0] === 'object' && parsedALineup[0]?.id) nextLocations[parsedALineup[0].id] = nextLocations[pA1];
  if (typeof parsedALineup?.[1] === 'object' && parsedALineup[1]?.id) nextLocations[parsedALineup[1].id] = nextLocations[pA2];
  if (typeof parsedBLineup?.[0] === 'object' && parsedBLineup[0]?.id) nextLocations[parsedBLineup[0].id] = nextLocations[pB1];
  if (typeof parsedBLineup?.[1] === 'object' && parsedBLineup[1]?.id) nextLocations[parsedBLineup[1].id] = nextLocations[pB2];

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

  const nextCourtState = computeAuthoritativeCourtState({
    format: m.match_format || 'DOUBLES',
    scoringMode,
    rotationRule,
    scores: { teamA: newScoreA, teamB: newScoreB },
    lineup: { teamA: parsedALineup || [], teamB: parsedBLineup || [] },
    servingTeam: nextServingTeam,
    serverNumber: nextServerNumber,
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    existingPlayerLocations: nextLocations
  });

  const updatedSportState = {
    scoringMode,
    rotationRule: nextCourtState.rotationRule,
    servingTeam: nextCourtState.servingTeam,
    startingServingTeam: currentSportState?.startingServingTeam || nextCourtState.servingTeam,
    serverNumber: nextCourtState.serverNumber,
    serviceCourt: nextCourtState.serviceCourt,
    receiverCourt: nextCourtState.receiverCourt,
    servingBoxName: nextCourtState.servingBoxName,
    targetBoxName: nextCourtState.targetBoxName,
    activeServerName: nextCourtState.activeServerName,
    activeReceiverName: nextCourtState.activeReceiverName,
    playerLocations: nextCourtState.playerLocations,
    originalPositions: nextCourtState.originalPositions,
    firstServeConfirmed: true
  };

  // Update match in database
  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = ?,
         winner_team_id = ?, result_summary = ?, live_score_summary = ?,
         sport_state = ?,
         end_time = CASE WHEN ? = 'COMPLETED' THEN CURRENT_TIME ELSE end_time END
     WHERE id = ?`,
    [newScoreA, newScoreB, newStatus, winnerTeamId, resultSummary, liveScoreSummary, JSON.stringify(updatedSportState), newStatus, m.id]
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

  // Recalculate standings if completed and auto-clear any break
  if (isCompleted) {
    try {
      const matchBreakService = require('./matchBreakService');
      matchBreakService.endBreak(m.id).catch(() => {});
    } catch (e) {}
    await recalculateStandings(m.tournament_id);
  }

  const state = await getScorerState(m.uuid);

  const pointEvent = {
    type: 'POINT_SCORED',
    matchId: m.uuid,
    tournamentId: m.tournament_uuid,
    eventId: eventId || `pt-${m.id}-${nextSeq}-${Date.now()}`,
    seq: seq || nextSeq,
    from: from || {
      side: nextCourtState.servingTeam === 'teamA' ? 'left' : 'right',
      box: nextCourtState.serviceCourt === 'RIGHT' ? (nextCourtState.servingTeam === 'teamA' ? 'bottom' : 'top') : (nextCourtState.servingTeam === 'teamA' ? 'top' : 'bottom'),
      boxName: nextCourtState.servingBoxName
    },
    to: to || {
      side: nextCourtState.servingTeam === 'teamA' ? 'right' : 'left',
      box: nextCourtState.receiverCourt === 'RIGHT' ? (nextCourtState.servingTeam === 'teamA' ? 'top' : 'bottom') : (nextCourtState.servingTeam === 'teamA' ? 'bottom' : 'top'),
      boxName: nextCourtState.targetBoxName
    },
    timestamp: Date.now()
  };

  // Broadcast real-time
  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: newStatus,
    type: 'POINT_SCORED',
    eventSeq: nextSeq,
    teamAScore: newScoreA,
    teamBScore: newScoreB,
    scoreSummary: `${newScoreA} - ${newScoreB}`,
    winnerTeamId,
    resultSummary,
    isCompleted,
    sportState: updatedSportState,
    courtState: nextCourtState,
    state,
    pointEvent
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
    `SELECT id, sequence_number, point_to, team_a_score, team_b_score 
     FROM pickleball_score_logs 
     WHERE match_id = ? 
     ORDER BY sequence_number DESC LIMIT 1`,
    [m.id]
  );

  if (!latestLogs || latestLogs.length === 0) {
    throw { statusCode: 400, message: 'No scoring actions to undo.' };
  }

  const currentLog = latestLogs[0];

  // Delete the undone log
  await db.query(`DELETE FROM pickleball_score_logs WHERE id = ?`, [currentLog.id]);

  // Fetch all remaining logs in sequence order
  const remainingLogs = await db.query(
    `SELECT id, sequence_number, point_to, team_a_score, team_b_score, event_type 
     FROM pickleball_score_logs 
     WHERE match_id = ? 
     ORDER BY sequence_number ASC`,
    [m.id]
  );

  const replayed = replayMatchFromLogs(m, remainingLogs);
  const revertedA = replayed.scores.teamA;
  const revertedB = replayed.scores.teamB;
  const liveScoreSummary = `${revertedA} - ${revertedB}`;
  const wasCompleted = m.status === 'COMPLETED';

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const rotationRule = replayed.rotationRule || currentSportState?.rotationRule || sportConfig?.rotationRule || 'OFFICIAL';
  const isBadmintonRule = String(rotationRule).toUpperCase() === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');

  let parsedALineup = null;
  let parsedBLineup = null;
  try {
    parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
    parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
  } catch {}

  const revertedCourtState = computeAuthoritativeCourtState({
    format: m.match_format || 'DOUBLES',
    scoringMode,
    rotationRule,
    scores: { teamA: revertedA, teamB: revertedB },
    lineup: { teamA: parsedALineup || [], teamB: parsedBLineup || [] },
    servingTeam: replayed.servingTeam,
    serverNumber: replayed.serverNumber,
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    existingPlayerLocations: replayed.playerLocations
  });

  const updatedSportState = {
    scoringMode,
    rotationRule: revertedCourtState.rotationRule,
    servingTeam: revertedCourtState.servingTeam,
    startingServingTeam: currentSportState?.startingServingTeam || 'teamA',
    serverNumber: revertedCourtState.serverNumber,
    serviceCourt: revertedCourtState.serviceCourt,
    receiverCourt: revertedCourtState.receiverCourt,
    servingBoxName: revertedCourtState.servingBoxName,
    targetBoxName: revertedCourtState.targetBoxName,
    activeServerName: revertedCourtState.activeServerName,
    activeReceiverName: revertedCourtState.activeReceiverName,
    playerLocations: revertedCourtState.playerLocations,
    originalPositions: revertedCourtState.originalPositions,
    firstServeConfirmed: Boolean(currentSportState?.firstServeConfirmed)
  };

  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = 'LIVE',
         winner_team_id = NULL, result_summary = NULL, live_score_summary = ?,
         sport_state = ?
     WHERE id = ?`,
    [revertedA, revertedB, liveScoreSummary, JSON.stringify(updatedSportState), m.id]
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
    sportState: updatedSportState,
    courtState: revertedCourtState,
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

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const scoringMode = sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY';

  let parsedALineup = null;
  let parsedBLineup = null;
  try {
    parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
    parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
  } catch {}

  const correctedCourtState = computeAuthoritativeCourtState({
    format: m.match_format || 'DOUBLES',
    scoringMode,
    scores: { teamA: newScoreA, teamB: newScoreB },
    lineup: { teamA: parsedALineup || [], teamB: parsedBLineup || [] },
    servingTeam: currentSportState?.servingTeam || 'teamA',
    serverNumber: 1,
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name }
  });

  const updatedSportState = {
    scoringMode,
    servingTeam: correctedCourtState.servingTeam,
    serverNumber: correctedCourtState.serverNumber,
    serviceCourt: correctedCourtState.serviceCourt,
    receiverCourt: correctedCourtState.receiverCourt,
    servingBoxName: correctedCourtState.servingBoxName,
    targetBoxName: correctedCourtState.targetBoxName,
    activeServerName: correctedCourtState.activeServerName,
    activeReceiverName: correctedCourtState.activeReceiverName,
    playerLocations: correctedCourtState.playerLocations,
    originalPositions: correctedCourtState.originalPositions
  };

  await db.query(
    `UPDATE tournament_matches
     SET team_a_score = ?, team_b_score = ?, status = ?,
         winner_team_id = ?, result_summary = ?, live_score_summary = ?,
         sport_state = ?
     WHERE id = ?`,
    [newScoreA, newScoreB, newStatus, winnerTeamId, resultSummary, liveScoreSummary, JSON.stringify(updatedSportState), m.id]
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
  if (isCompleted) {
    try {
      const matchBreakService = require('./matchBreakService');
      matchBreakService.endBreak(m.id).catch(() => {});
    } catch (e) {}
  }

  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: newStatus,
    type: 'CORRECTION',
    teamAScore: newScoreA,
    teamBScore: newScoreB,
    scoreSummary: liveScoreSummary,
    winnerTeamId,
    resultSummary,
    isCompleted,
    sportState: updatedSportState,
    courtState: correctedCourtState
  });

  return await getScorerState(m.uuid);
};

/**
 * 12. Update Playing / Rotation Rule for a match (OFFICIAL vs BADMINTON).
 */
const setRotationRule = async (matchId, body = {}, user) => {
  const m = await getMatchEntity(matchId);
  if (!m) {
    throw { statusCode: 404, message: 'Match not found.' };
  }

  const rawRule = body.rotationRule || body.rule || 'OFFICIAL';
  const normalizedRule = String(rawRule).toUpperCase() === 'BADMINTON' ? 'BADMINTON' : 'OFFICIAL';

  let sportConfig = null;
  try {
    sportConfig = typeof m.sport_config === 'string' ? JSON.parse(m.sport_config) : (m.sport_config || {});
  } catch {}
  let currentSportState = null;
  try {
    currentSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : (m.sport_state || {});
  } catch {}

  const isBadmintonRule = normalizedRule === 'BADMINTON';
  const scoringMode = isBadmintonRule ? 'RALLY' : (sportConfig?.scoringMode || currentSportState?.scoringMode || 'RALLY');
  const format = m.match_format || 'DOUBLES';
  const isDoubles = format !== 'SINGLES';
  const isSideOut = !isBadmintonRule && String(scoringMode).toUpperCase() === 'SIDE_OUT';
  const serverNumber = isBadmintonRule ? 1 : ((isSideOut && isDoubles) ? 2 : 1);

  currentSportState = currentSportState || {};
  currentSportState.rotationRule = normalizedRule;
  currentSportState.scoringMode = scoringMode;

  const parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : (m.team_a_lineup || []);
  const parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : (m.team_b_lineup || []);

  const updatedCourtState = computeAuthoritativeCourtState({
    format,
    scoringMode,
    rotationRule: normalizedRule,
    scores: { teamA: m.team_a_score || 0, teamB: m.team_b_score || 0 },
    lineup: { teamA: parsedALineup, teamB: parsedBLineup },
    servingTeam: currentSportState.servingTeam || 'teamA',
    serverNumber: isBadmintonRule ? 1 : (currentSportState.serverNumber || serverNumber),
    teamA: { id: m.team_a_uuid, name: m.team_a_name },
    teamB: { id: m.team_b_uuid, name: m.team_b_name },
    existingPlayerLocations: currentSportState.playerLocations || null,
    startingServingTeam: currentSportState.startingServingTeam || 'teamA'
  });

  currentSportState.serviceCourt = updatedCourtState.serviceCourt;
  currentSportState.receiverCourt = updatedCourtState.receiverCourt;
  currentSportState.servingBoxName = updatedCourtState.servingBoxName;
  currentSportState.targetBoxName = updatedCourtState.targetBoxName;
  currentSportState.activeServerName = updatedCourtState.activeServerName;
  currentSportState.activeReceiverName = updatedCourtState.activeReceiverName;
  currentSportState.serverNumber = updatedCourtState.serverNumber;
  currentSportState.playerLocations = updatedCourtState.playerLocations;

  await db.query(
    'UPDATE tournament_matches SET sport_state = ? WHERE id = ?',
    [JSON.stringify(currentSportState), m.id]
  );

  broadcastPickleballScore(m.uuid, m.tournament_uuid, {
    status: m.status,
    type: 'RULE_CHANGE',
    teamAScore: m.team_a_score || 0,
    teamBScore: m.team_b_score || 0,
    sportState: currentSportState,
    courtState: updatedCourtState
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
  correctScore,
  setRotationRule
};
