const db = require('../config/database');
const crypto = require('crypto');
const { getIO } = require('./socketService');
const {
  getTournamentEntity,
  recalculateStandings,
  advanceKnockoutWinner,
  generateRoundRobinPairings
} = require('./tournamentEngineService');

/**
 * 1. Check Scheduling Conflicts for Teams and Courts
 */
async function checkSchedulingConflicts({
  tournamentId,
  matchId = null,
  matchDate,
  startTime,
  endTime,
  courtId = null,
  venueId = null,
  teamAId = null,
  teamBId = null
}) {
  if (!matchDate || !startTime || !endTime) {
    return { hasConflict: false, conflicts: [] };
  }

  const conflicts = [];

  // Resolve integer match ID if UUID
  let resolvedExcludeId = null;
  if (matchId) {
    const [m] = await db.query('SELECT id FROM tournament_matches WHERE id = ? OR uuid = ?', [matchId, matchId]);
    if (m) resolvedExcludeId = m.id;
  }

  // 1. Check Court / Venue Overlap
  if (courtId) {
    const courtConflicts = await db.query(
      `SELECT tm.id, tm.uuid, tm.match_number, tm.start_time, tm.end_time, tm.category,
              c.name as court_name,
              ta.name as team_a_name, tb.name as team_b_name
       FROM tournament_matches tm
       LEFT JOIN courts c ON tm.court_id = c.id
       LEFT JOIN teams ta ON tm.team_a_id = ta.id
       LEFT JOIN teams tb ON tm.team_b_id = tb.id
       WHERE tm.court_id = ? 
         AND tm.match_date = ? 
         AND tm.status NOT IN ('CANCELLED', 'ABANDONED')
         AND (? < tm.end_time AND ? > tm.start_time)
         AND (? IS NULL OR tm.id != ?)`,
      [courtId, matchDate, startTime, endTime, resolvedExcludeId, resolvedExcludeId]
    );

    if (courtConflicts.length > 0) {
      for (const cc of courtConflicts) {
        conflicts.push({
          type: 'COURT_OVERLAP',
          message: `Court "${cc.court_name || 'Selected Court'}" is already assigned to Match #${cc.match_number} (${cc.team_a_name || 'Team A'} vs ${cc.team_b_name || 'Team B'}) from ${cc.start_time} to ${cc.end_time}.`,
          matchId: cc.id,
          matchNumber: cc.match_number
        });
      }
    }
  }

  // 2. Check Participating Team Overlap
  if (teamAId || teamBId) {
    const checkTeamIds = [teamAId, teamBId].filter(Boolean);
    if (checkTeamIds.length > 0) {
      const placeholders = checkTeamIds.map(() => '?').join(',');
      const teamConflicts = await db.query(
        `SELECT tm.id, tm.uuid, tm.match_number, tm.start_time, tm.end_time, tm.category,
                tm.team_a_id, tm.team_b_id,
                ta.name as team_a_name, tb.name as team_b_name
         FROM tournament_matches tm
         LEFT JOIN teams ta ON tm.team_a_id = ta.id
         LEFT JOIN teams tb ON tm.team_b_id = tb.id
         WHERE (tm.team_a_id IN (${placeholders}) OR tm.team_b_id IN (${placeholders}))
           AND tm.match_date = ?
           AND tm.status NOT IN ('CANCELLED', 'ABANDONED')
           AND (? < tm.end_time AND ? > tm.start_time)
           AND (? IS NULL OR tm.id != ?)`,
        [...checkTeamIds, ...checkTeamIds, matchDate, startTime, endTime, resolvedExcludeId, resolvedExcludeId]
      );

      if (teamConflicts.length > 0) {
        for (const tc of teamConflicts) {
          const conflictingTeamName = (checkTeamIds.includes(tc.team_a_id) ? tc.team_a_name : tc.team_b_name) || 'Participating Team';
          conflicts.push({
            type: 'TEAM_OVERLAP',
            message: `Team "${conflictingTeamName}" is already scheduled in Match #${tc.match_number} from ${tc.start_time} to ${tc.end_time}.`,
            matchId: tc.id,
            matchNumber: tc.match_number
          });
        }
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts
  };
}

/**
 * 2. Create a Single Fixture
 */
async function createFixture({ tournamentId, user, fixtureData }) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  if (user.role !== 'ADMIN' && tournament.created_by !== user.id && tournament.venue_owner_id !== user.id) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can create fixtures.' };
  }

  const {
    category = 'League',
    matchNumber,
    roundNumber = 1,
    teamAId = null,
    teamBId = null,
    groupName = null,
    matchDate,
    startTime,
    endTime,
    venueId = tournament.venue_id,
    courtId = null,
    courtName = null,
    scorerId = null,
    countsInStandings,
    allowConflictOverride = false
  } = fixtureData;

  // Validate Category
  const VALID_CATEGORIES = ['League', 'Knockout', 'Quarter-Final', 'Semi-Final', 'Final'];
  const resolvedCategory = VALID_CATEGORIES.includes(category) ? category : 'League';

  // Conflict Check
  if (matchDate && startTime && endTime) {
    const conflictResult = await checkSchedulingConflicts({
      tournamentId: tournament.id,
      matchDate,
      startTime,
      endTime,
      courtId,
      venueId,
      teamAId,
      teamBId
    });

    if (conflictResult.hasConflict && !allowConflictOverride) {
      return {
        success: false,
        requiresConfirmation: true,
        conflicts: conflictResult.conflicts,
        message: 'Scheduling conflict detected: ' + conflictResult.conflicts.map(c => c.message).join(' ')
      };
    }
  }

  // Next match number if not provided
  let resolvedMatchNumber = matchNumber;
  if (!resolvedMatchNumber) {
    const [numRow] = await db.query(
      'SELECT COALESCE(MAX(match_number), 0) + 1 as next_num FROM tournament_matches WHERE tournament_id = ?',
      [tournament.id]
    );
    resolvedMatchNumber = numRow ? numRow.next_num : 1;
  }

  // Determine counts_in_standings default: League = 1, Knockout/Quarter/Semi/Final = 0
  const resolvedCountsInStandings = countsInStandings !== undefined
    ? (countsInStandings ? 1 : 0)
    : (resolvedCategory === 'League' ? 1 : 0);

  // Court name resolution if courtId passed
  let resolvedCourtName = courtName;
  if (courtId && !resolvedCourtName) {
    const [c] = await db.query('SELECT name FROM courts WHERE id = ?', [courtId]);
    if (c) resolvedCourtName = c.name;
  }

  const matchUuid = crypto.randomUUID();

  const insertResult = await db.query(
    `INSERT INTO tournament_matches (
      uuid, tournament_id, match_number, round_number,
      team_a_id, team_b_id, venue_id, court_id, court_name,
      match_date, start_time, end_time, status, category,
      group_name, counts_in_standings, scorer_id, live_score_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, ?, 'Yet to Start')`,
    [
      matchUuid,
      tournament.id,
      resolvedMatchNumber,
      roundNumber,
      teamAId || null,
      teamBId || null,
      venueId || null,
      courtId || null,
      resolvedCourtName || null,
      matchDate || null,
      startTime || null,
      endTime || null,
      resolvedCategory,
      groupName || null,
      resolvedCountsInStandings,
      scorerId || null
    ]
  );

  const newMatchId = insertResult.insertId;

  // If scorer assigned, create tournament_scorers record
  if (scorerId) {
    await db.query(
      `INSERT INTO tournament_scorers (tournament_id, user_id, match_id, assigned_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id=id`,
      [tournament.id, scorerId, newMatchId, user.id]
    );
  }

  // Broadcast WebSocket update
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchesUpdated', {
      tournamentId: tournament.uuid,
      createdMatchId: newMatchId,
      category: resolvedCategory
    });
  }

  return {
    success: true,
    message: `Match #${resolvedMatchNumber} (${resolvedCategory}) created successfully.`,
    matchId: newMatchId,
    uuid: matchUuid
  };
}

/**
 * 3. Update / Reschedule Fixture
 */
async function updateFixture({ tournamentId, matchId, user, updates }) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  if (user.role !== 'ADMIN' && tournament.created_by !== user.id && tournament.venue_owner_id !== user.id) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can edit fixtures.' };
  }

  const [match] = await db.query(
    'SELECT * FROM tournament_matches WHERE (id = ? OR uuid = ?) AND tournament_id = ?',
    [matchId, matchId, tournament.id]
  );
  if (!match) throw { statusCode: 404, message: 'Fixture not found' };

  const {
    category,
    teamAId,
    teamBId,
    matchDate,
    startTime,
    endTime,
    courtId,
    courtName,
    venueId,
    groupName,
    matchNumber,
    roundNumber,
    scorerId,
    countsInStandings,
    status,
    allowConflictOverride = false
  } = updates;

  const targetDate = matchDate !== undefined ? matchDate : match.match_date;
  const targetStartTime = startTime !== undefined ? startTime : match.start_time;
  const targetEndTime = endTime !== undefined ? endTime : match.end_time;
  const targetCourtId = courtId !== undefined ? courtId : match.court_id;
  const targetTeamAId = teamAId !== undefined ? teamAId : match.team_a_id;
  const targetTeamBId = teamBId !== undefined ? teamBId : match.team_b_id;

  // Conflict Check if timing, court, or teams changed
  if (targetDate && targetStartTime && targetEndTime) {
    const conflictResult = await checkSchedulingConflicts({
      tournamentId: tournament.id,
      matchId: match.id,
      matchDate: targetDate,
      startTime: targetStartTime,
      endTime: targetEndTime,
      courtId: targetCourtId,
      teamAId: targetTeamAId,
      teamBId: targetTeamBId
    });

    if (conflictResult.hasConflict && !allowConflictOverride) {
      return {
        success: false,
        requiresConfirmation: true,
        conflicts: conflictResult.conflicts,
        message: 'Scheduling conflict detected: ' + conflictResult.conflicts.map(c => c.message).join(' ')
      };
    }
  }

  // Determine category & counts_in_standings
  const newCategory = category !== undefined ? category : match.category;
  let newCountsInStandings = countsInStandings;
  if (newCountsInStandings === undefined) {
    if (category !== undefined && category !== match.category) {
      newCountsInStandings = (category === 'League' ? 1 : 0);
    } else {
      newCountsInStandings = match.counts_in_standings;
    }
  } else {
    newCountsInStandings = newCountsInStandings ? 1 : 0;
  }

  // Court name resolution
  let newCourtName = courtName !== undefined ? courtName : match.court_name;
  if (courtId && courtId !== match.court_id && !courtName) {
    const [c] = await db.query('SELECT name FROM courts WHERE id = ?', [courtId]);
    if (c) newCourtName = c.name;
  }

  await db.query(
    `UPDATE tournament_matches 
     SET category = ?,
         counts_in_standings = ?,
         team_a_id = ?,
         team_b_id = ?,
         match_date = ?,
         start_time = ?,
         end_time = ?,
         court_id = ?,
         court_name = ?,
         venue_id = ?,
         group_name = ?,
         match_number = ?,
         round_number = ?,
         scorer_id = ?,
         status = COALESCE(?, status),
         show_on_display = CASE WHEN ? = 'LIVE' THEN 1 ELSE show_on_display END,
         live_score_summary = CASE WHEN ? = 'LIVE' AND (live_score_summary IS NULL OR live_score_summary = 'Yet to Start') THEN '0 - 0' ELSE live_score_summary END
     WHERE id = ?`,
    [
      newCategory,
      newCountsInStandings,
      targetTeamAId || null,
      targetTeamBId || null,
      targetDate || null,
      targetStartTime || null,
      targetEndTime || null,
      targetCourtId || null,
      newCourtName || null,
      venueId !== undefined ? venueId : match.venue_id,
      groupName !== undefined ? groupName : match.group_name,
      matchNumber !== undefined ? matchNumber : match.match_number,
      roundNumber !== undefined ? roundNumber : match.round_number,
      scorerId !== undefined ? scorerId : match.scorer_id,
      status || null,
      status || null,
      status || null,
      match.id
    ]
  );

  // Sync tournament_scorers if scorer changed
  if (scorerId !== undefined && scorerId !== match.scorer_id) {
    await db.query('DELETE FROM tournament_scorers WHERE match_id = ?', [match.id]);
    if (scorerId) {
      await db.query(
        `INSERT INTO tournament_scorers (tournament_id, user_id, match_id, assigned_by)
         VALUES (?, ?, ?, ?)`,
        [tournament.id, scorerId, match.id, user.id]
      );
    }
  }

  // Recalculate standings if counts_in_standings or status was modified
  if (match.status === 'COMPLETED' || status === 'COMPLETED' || newCountsInStandings !== match.counts_in_standings) {
    await recalculateStandings(tournament.id);
  }

  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchesUpdated', {
      tournamentId: tournament.uuid,
      updatedMatchId: match.id,
      newStatus: status || match.status
    });
    io.to(`tv:${tournament.uuid}`).emit('display:matchesUpdated', {
      tournamentId: tournament.uuid
    });
    io.to(`signage:${tournament.uuid}`).emit('display:matchesUpdated', {
      tournamentId: tournament.uuid
    });
  }

  return {
    success: true,
    message: `Match #${matchNumber || match.match_number} updated successfully.`,
    data: {
      id: match.id,
      uuid: match.uuid,
      status: status || match.status,
      show_on_display: status === 'LIVE' ? 1 : match.show_on_display
    }
  };
}

/**
 * 4. Delete Fixture
 */
async function deleteFixture({ tournamentId, matchId, user, force = false }) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  if (user.role !== 'ADMIN' && tournament.created_by !== user.id && tournament.venue_owner_id !== user.id) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can delete fixtures.' };
  }

  const [match] = await db.query(
    'SELECT * FROM tournament_matches WHERE (id = ? OR uuid = ?) AND tournament_id = ?',
    [matchId, matchId, tournament.id]
  );
  if (!match) throw { statusCode: 404, message: 'Fixture not found' };

  if ((match.status === 'COMPLETED' || match.status === 'LIVE') && !force) {
    return {
      success: false,
      requiresConfirmation: true,
      message: `Match #${match.match_number} has ${match.status.toLowerCase()} records. Deleting will affect match statistics and standings. Confirm deletion to proceed.`
    };
  }

  // Clean scorer assignments
  await db.query('DELETE FROM tournament_scorers WHERE match_id = ?', [match.id]);

  // Delete the fixture
  await db.query('DELETE FROM tournament_matches WHERE id = ?', [match.id]);

  // Recalculate standings
  if (match.status === 'COMPLETED') {
    await recalculateStandings(tournament.id);
  }

  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchesUpdated', {
      tournamentId: tournament.uuid,
      deletedMatchId: match.id
    });
  }

  return {
    success: true,
    message: `Match #${match.match_number} deleted successfully.`
  };
}

/**
 * 5. Auto-Generate League Round Robin Fixtures
 */
async function autoGenerateLeague({ tournamentId, user, options = {} }) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  if (user.role !== 'ADMIN' && tournament.created_by !== user.id && tournament.venue_owner_id !== user.id) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can generate fixtures.' };
  }

  const {
    groupName = null,
    startDate = tournament.start_date || new Date().toISOString().slice(0, 10),
    dailyStartTime = '09:00:00',
    matchDurationMinutes = 60,
    bufferMinutes = 15,
    matchesPerDay = 8
  } = options;

  // Fetch approved teams
  let teamsQuery = `
    SELECT tt.team_id, tt.group_name, tm.name as team_name
    FROM tournament_teams tt
    JOIN teams tm ON tt.team_id = tm.id
    WHERE tt.tournament_id = ? AND tt.registration_status = 'APPROVED'
  `;
  const queryParams = [tournament.id];
  if (groupName && groupName !== 'ALL') {
    teamsQuery += ' AND tt.group_name = ?';
    queryParams.push(groupName);
  }
  teamsQuery += ' ORDER BY tt.group_name ASC, tm.name ASC';

  const teams = await db.query(teamsQuery, queryParams);
  if (!teams || teams.length < 2) {
    throw { statusCode: 400, message: 'Need at least 2 approved teams to generate league fixtures.' };
  }

  // Get courts
  let courts = [];
  if (tournament.venue_id) {
    courts = await db.query(
      `SELECT id, name FROM courts WHERE venue_id = ? AND (status = 'ACTIVE' OR status IS NULL) ORDER BY id ASC`,
      [tournament.venue_id]
    );
  }
  if (!courts || courts.length === 0) {
    courts = [{ id: null, name: 'Main Court' }];
  }

  // Group teams
  const groups = {};
  for (const t of teams) {
    const g = t.group_name || 'Group 1';
    if (!groups[g]) groups[g] = [];
    groups[g].push(t.team_id);
  }

  // Get current max match number
  const [maxRow] = await db.query(
    'SELECT COALESCE(MAX(match_number), 0) as max_num FROM tournament_matches WHERE tournament_id = ?',
    [tournament.id]
  );
  let matchNumberSeq = (maxRow?.max_num || 0) + 1;

  let currentDayOffset = 0;
  let currentMatchInDay = 0;
  const startD = new Date(startDate);

  function getSlot() {
    const matchDate = new Date(startD.getTime() + currentDayOffset * 86400000).toISOString().slice(0, 10);
    const [startHour, startMin] = dailyStartTime.split(':').map(Number);
    const totalMinutes = startHour * 60 + startMin + currentMatchInDay * (matchDurationMinutes + bufferMinutes);

    const sH = String(Math.floor(totalMinutes / 60) % 24).padStart(2, '0');
    const sM = String(totalMinutes % 60).padStart(2, '0');
    const endMinutes = totalMinutes + matchDurationMinutes;
    const eH = String(Math.floor(endMinutes / 60) % 24).padStart(2, '0');
    const eM = String(endMinutes % 60).padStart(2, '0');

    const court = courts[currentMatchInDay % courts.length];

    currentMatchInDay++;
    if (currentMatchInDay >= matchesPerDay) {
      currentMatchInDay = 0;
      currentDayOffset++;
    }

    return {
      matchDate,
      startTime: `${sH}:${sM}:00`,
      endTime: `${eH}:${eM}:00`,
      courtId: court.id,
      courtName: court.name
    };
  }

  const generated = [];
  for (const [gKey, gTeamIds] of Object.entries(groups)) {
    if (gTeamIds.length < 2) continue;
    const pairings = generateRoundRobinPairings(gTeamIds);

    for (const round of pairings) {
      for (const pair of round) {
        const slot = getSlot();
        const uuid = crypto.randomUUID();

        await db.query(
          `INSERT INTO tournament_matches (
            uuid, tournament_id, match_number, round_number,
            team_a_id, team_b_id, venue_id, court_id, court_name,
            match_date, start_time, end_time, status, category,
            group_name, counts_in_standings, live_score_summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', 'League', ?, 1, 'Yet to Start')`,
          [
            uuid,
            tournament.id,
            matchNumberSeq++,
            pair.roundNumber,
            pair.teamAId,
            pair.teamBId,
            tournament.venue_id,
            slot.courtId,
            slot.courtName,
            slot.matchDate,
            slot.startTime,
            slot.endTime,
            gKey
          ]
        );

        generated.push({ uuid, matchNumber: matchNumberSeq - 1, teamAId: pair.teamAId, teamBId: pair.teamBId });
      }
    }
  }

  await recalculateStandings(tournament.id);

  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchesUpdated', {
      tournamentId: tournament.uuid,
      action: 'autoLeague',
      count: generated.length
    });
  }

  return {
    success: true,
    message: `Generated ${generated.length} League fixtures successfully across ${Object.keys(groups).length} group(s).`,
    count: generated.length
  };
}

/**
 * 6. Generate Knockout Bracket (Quarter-Finals -> Semi-Finals -> Final)
 */
async function generateKnockoutBracket({ tournamentId, user, options = {} }) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) throw { statusCode: 404, message: 'Tournament not found' };

  if (user.role !== 'ADMIN' && tournament.created_by !== user.id && tournament.venue_owner_id !== user.id) {
    throw { statusCode: 403, message: 'Only tournament organizer or super admin can generate brackets.' };
  }

  const {
    seedFromStandings = true,
    customTeamIds = null,
    startDate = tournament.start_date || new Date().toISOString().slice(0, 10),
    dailyStartTime = '14:00:00',
    matchDurationMinutes = 60
  } = options;

  // Resolve 8 or 4 teams for bracket
  let bracketTeamIds = [];

  if (seedFromStandings) {
    const standings = await db.query(
      `SELECT team_id FROM points_table 
       WHERE tournament_id = ? 
       ORDER BY points DESC, net_run_rate DESC, point_difference DESC, goal_difference DESC, won DESC 
       LIMIT 8`,
      [tournament.id]
    );
    bracketTeamIds = standings.map(s => s.team_id);
  } else if (Array.isArray(customTeamIds) && customTeamIds.length >= 4) {
    bracketTeamIds = customTeamIds.slice(0, 8);
  }

  // Fallback to approved tournament teams if standings not yet played
  if (bracketTeamIds.length < 4) {
    const appTeams = await db.query(
      `SELECT team_id FROM tournament_teams WHERE tournament_id = ? AND registration_status = 'APPROVED' LIMIT 8`,
      [tournament.id]
    );
    bracketTeamIds = appTeams.map(t => t.team_id);
  }

  if (bracketTeamIds.length < 4) {
    throw { statusCode: 400, message: 'Need at least 4 teams to generate a knockout bracket.' };
  }

  const is8Teams = bracketTeamIds.length >= 8;

  // Next match number
  const [maxRow] = await db.query(
    'SELECT COALESCE(MAX(match_number), 0) as max_num FROM tournament_matches WHERE tournament_id = ?',
    [tournament.id]
  );
  let matchNumberSeq = (maxRow?.max_num || 0) + 1;

  // Get court
  let court = { id: null, name: 'Center Court' };
  if (tournament.venue_id) {
    const [c] = await db.query('SELECT id, name FROM courts WHERE venue_id = ? LIMIT 1', [tournament.venue_id]);
    if (c) court = c;
  }

  // 1. Create Final
  const finalUuid = crypto.randomUUID();
  const finalInsert = await db.query(
    `INSERT INTO tournament_matches (
      uuid, tournament_id, match_number, round_number,
      team_a_id, team_b_id, venue_id, court_id, court_name,
      match_date, start_time, end_time, status, category,
      counts_in_standings, bracket_slot, live_score_summary
    ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, '19:00:00', '20:30:00', 'SCHEDULED', 'Final', 0, 'FINAL', 'Yet to Start')`,
    [finalUuid, tournament.id, is8Teams ? matchNumberSeq + 6 : matchNumberSeq + 2, is8Teams ? 3 : 2, tournament.venue_id, court.id, court.name, startDate]
  );
  const finalId = finalInsert.insertId;

  // 2. Create Semi-Finals (linking to Final)
  const sf1Uuid = crypto.randomUUID();
  const sf1Insert = await db.query(
    `INSERT INTO tournament_matches (
      uuid, tournament_id, match_number, round_number,
      team_a_id, team_b_id, venue_id, court_id, court_name,
      match_date, start_time, end_time, status, category,
      counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '16:00:00', '17:30:00', 'SCHEDULED', 'Semi-Final', 0, ?, 'SF1', 'TEAM_A', 'Yet to Start')`,
    [
      sf1Uuid, tournament.id, is8Teams ? matchNumberSeq + 4 : matchNumberSeq, is8Teams ? 2 : 1,
      is8Teams ? null : bracketTeamIds[0], is8Teams ? null : bracketTeamIds[3],
      tournament.venue_id, court.id, court.name, startDate, finalId
    ]
  );
  const sf1Id = sf1Insert.insertId;

  const sf2Uuid = crypto.randomUUID();
  const sf2Insert = await db.query(
    `INSERT INTO tournament_matches (
      uuid, tournament_id, match_number, round_number,
      team_a_id, team_b_id, venue_id, court_id, court_name,
      match_date, start_time, end_time, status, category,
      counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '17:30:00', '19:00:00', 'SCHEDULED', 'Semi-Final', 0, ?, 'SF2', 'TEAM_B', 'Yet to Start')`,
    [
      sf2Uuid, tournament.id, is8Teams ? matchNumberSeq + 5 : matchNumberSeq + 1, is8Teams ? 2 : 1,
      is8Teams ? null : bracketTeamIds[1], is8Teams ? null : bracketTeamIds[2],
      tournament.venue_id, court.id, court.name, startDate, finalId
    ]
  );
  const sf2Id = sf2Insert.insertId;

  // 3. If 8 teams, Create 4 Quarter-Finals (linking to SF1 and SF2)
  if (is8Teams) {
    // QF1: Seed 1 vs Seed 8 -> SF1 (TEAM_A)
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, round_number,
        team_a_id, team_b_id, venue_id, court_id, court_name,
        match_date, start_time, end_time, status, category,
        counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '09:00:00', '10:30:00', 'SCHEDULED', 'Quarter-Final', 0, ?, 'QF1', 'TEAM_A', 'Yet to Start')`,
      [crypto.randomUUID(), tournament.id, matchNumberSeq++, bracketTeamIds[0], bracketTeamIds[7], tournament.venue_id, court.id, court.name, startDate, sf1Id]
    );

    // QF2: Seed 4 vs Seed 5 -> SF1 (TEAM_B)
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, round_number,
        team_a_id, team_b_id, venue_id, court_id, court_name,
        match_date, start_time, end_time, status, category,
        counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '10:30:00', '12:00:00', 'SCHEDULED', 'Quarter-Final', 0, ?, 'QF2', 'TEAM_B', 'Yet to Start')`,
      [crypto.randomUUID(), tournament.id, matchNumberSeq++, bracketTeamIds[3], bracketTeamIds[4], tournament.venue_id, court.id, court.name, startDate, sf1Id]
    );

    // QF3: Seed 2 vs Seed 7 -> SF2 (TEAM_A)
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, round_number,
        team_a_id, team_b_id, venue_id, court_id, court_name,
        match_date, start_time, end_time, status, category,
        counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '12:00:00', '13:30:00', 'SCHEDULED', 'Quarter-Final', 0, ?, 'QF3', 'TEAM_A', 'Yet to Start')`,
      [crypto.randomUUID(), tournament.id, matchNumberSeq++, bracketTeamIds[1], bracketTeamIds[6], tournament.venue_id, court.id, court.name, startDate, sf2Id]
    );

    // QF4: Seed 3 vs Seed 6 -> SF2 (TEAM_B)
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, round_number,
        team_a_id, team_b_id, venue_id, court_id, court_name,
        match_date, start_time, end_time, status, category,
        counts_in_standings, next_match_id, bracket_slot, bracket_target_team, live_score_summary
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '13:30:00', '15:00:00', 'SCHEDULED', 'Quarter-Final', 0, ?, 'QF4', 'TEAM_B', 'Yet to Start')`,
      [crypto.randomUUID(), tournament.id, matchNumberSeq++, bracketTeamIds[2], bracketTeamIds[5], tournament.venue_id, court.id, court.name, startDate, sf2Id]
    );
  }

  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchesUpdated', {
      tournamentId: tournament.uuid,
      action: 'knockoutBracketGenerated'
    });
  }

  return {
    success: true,
    message: `Generated ${is8Teams ? '8-Team (Quarter-Finals to Final)' : '4-Team (Semi-Finals to Final)'} Knockout Bracket with auto-progression linkages.`,
    is8Teams
  };
}

/**
 * 7. Get Bracket Tree Structure for Visualizer
 */
async function getBracketTree(tournamentId) {
  const [tournament] = await db.query(
    'SELECT id, uuid FROM tournaments WHERE uuid = ? OR id = ?',
    [tournamentId, isNaN(tournamentId) ? -1 : parseInt(tournamentId, 10)]
  );
  if (!tournament) return { quarters: [], semis: [], final: null };

  const matches = await db.query(
    `SELECT tm.id, tm.uuid, tm.match_number, tm.category, tm.bracket_slot, tm.next_match_id,
            tm.status, tm.winner_team_id, tm.result_summary, tm.live_score_summary,
            tm.match_date, tm.start_time,
            ta.id as team_a_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
            tb.id as team_b_id, tb.name as team_b_name, tb.logo_url as team_b_logo,
            w.name as winner_name
     FROM tournament_matches tm
     LEFT JOIN teams ta ON tm.team_a_id = ta.id
     LEFT JOIN teams tb ON tm.team_b_id = tb.id
     LEFT JOIN teams w ON tm.winner_team_id = w.id
     WHERE tm.tournament_id = ? 
       AND (tm.category IN ('Knockout', 'Quarter-Final', 'Semi-Final', 'Final') OR tm.bracket_slot IS NOT NULL)
     ORDER BY tm.match_number ASC`,
    [tournament.id]
  );

  const quarters = matches.filter(m => m.category === 'Quarter-Final' || m.bracket_slot?.startsWith('QF'));
  const semis = matches.filter(m => m.category === 'Semi-Final' || m.bracket_slot?.startsWith('SF'));
  const finals = matches.filter(m => m.category === 'Final' || m.bracket_slot === 'FINAL');

  return {
    quarters,
    semis,
    final: finals[0] || null
  };
}

module.exports = {
  checkSchedulingConflicts,
  createFixture,
  updateFixture,
  deleteFixture,
  autoGenerateLeague,
  generateKnockoutBracket,
  getBracketTree
};
