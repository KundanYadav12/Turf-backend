const db = require('../config/database');
const crypto = require('crypto');
const { getSportConfig } = require('./sportsRegistry');
const { broadcastTournamentMatchUpdate, getIO } = require('./socketService');

/**
 * Tournament Engine Service
 * Reusable, multi-sport tournament management supporting:
 * - Single Round-Robin, Double Round-Robin
 * - Single Elimination Knockout with automatic seeding, byes, and next-round progression
 * - Double Elimination and Group Stage + Knockout Playoffs
 * - Conflict detection (team and court double-booking prevention)
 * - Sport-specific standings recalculation and auto-advancement
 */

/**
 * Helper to fetch tournament entity by UUID or integer ID.
 */
async function getTournamentEntity(tournamentId) {
  const intId = /^\d+$/.test(String(tournamentId).trim()) ? parseInt(tournamentId, 10) : -1;
  const rows = await db.query(
    `SELECT t.*, s.slug as sport_slug, s.name as sport_name
     FROM tournaments t
     JOIN sports s ON t.sport_id = s.id
     WHERE t.uuid = ? OR t.id = ?`,
    [String(tournamentId), intId]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Validates scheduling conflicts for teams and courts.
 */
async function checkSchedulingConflicts({
  teamAId,
  teamBId,
  matchDate,
  startTime,
  endTime,
  courtId,
  excludeMatchId = null
}) {
  if (!matchDate || !startTime || !endTime) return { hasConflict: false };

  // 1. Check if Court is already booked for another match at overlapping time
  if (courtId) {
    const courtConflicts = await db.query(
      `SELECT tm.id, tm.match_number, tm.start_time, tm.end_time
       FROM tournament_matches tm
       WHERE tm.court_id = ? 
         AND tm.match_date = ? 
         AND tm.status NOT IN ('CANCELLED', 'ABANDONED')
         AND (? < tm.end_time AND ? > tm.start_time)
         AND (? IS NULL OR tm.id != ?)`,
      [courtId, matchDate, startTime, endTime, excludeMatchId, excludeMatchId]
    );

    if (courtConflicts && courtConflicts.length > 0) {
      return {
        hasConflict: true,
        type: 'COURT_OVERLAP',
        message: `Court is already assigned to Match #${courtConflicts[0].match_number} during this time (${courtConflicts[0].start_time} - ${courtConflicts[0].end_time}).`
      };
    }
  }

  // 2. Check if Team A or Team B is scheduled in an overlapping match
  const teamConflicts = await db.query(
    `SELECT tm.id, tm.match_number, tm.team_a_id, tm.team_b_id, tm.start_time, tm.end_time
     FROM tournament_matches tm
     WHERE (tm.team_a_id IN (?, ?) OR tm.team_b_id IN (?, ?))
       AND tm.match_date = ?
       AND tm.status NOT IN ('CANCELLED', 'ABANDONED')
       AND (? < tm.end_time AND ? > tm.start_time)
       AND (? IS NULL OR tm.id != ?)`,
    [teamAId, teamBId, teamAId, teamBId, matchDate, startTime, endTime, excludeMatchId, excludeMatchId]
  );

  if (teamConflicts && teamConflicts.length > 0) {
    return {
      hasConflict: true,
      type: 'TEAM_OVERLAP',
      message: `A participating team is already scheduled to play Match #${teamConflicts[0].match_number} at overlapping time (${teamConflicts[0].start_time} - ${teamConflicts[0].end_time}).`
    };
  }

  return { hasConflict: false };
}

/**
 * Standard Berger / Polygon Round-Robin pairings generator.
 * Generates N-1 rounds for N teams (or N rounds if odd number of teams with byes).
 */
function generateRoundRobinPairings(teamIds) {
  const teams = [...teamIds];
  const hasBye = teams.length % 2 !== 0;
  if (hasBye) {
    teams.push(null); // null represents a bye
  }

  const numTeams = teams.length;
  const numRounds = numTeams - 1;
  const half = numTeams / 2;
  const rounds = [];

  for (let round = 0; round < numRounds; round++) {
    const roundPairings = [];
    for (let i = 0; i < half; i++) {
      const teamA = teams[i];
      const teamB = teams[numTeams - 1 - i];

      if (teamA !== null && teamB !== null) {
        // Alternate home and away
        if (round % 2 === 1) {
          roundPairings.push({ teamAId: teamB, teamBId: teamA, roundNumber: round + 1 });
        } else {
          roundPairings.push({ teamAId: teamA, teamBId: teamB, roundNumber: round + 1 });
        }
      }
    }
    rounds.push(roundPairings);

    // Rotate teams keeping the first element fixed
    const fixed = teams[0];
    const rest = teams.slice(1);
    const last = rest.pop();
    rest.unshift(last);
    teams.splice(0, teams.length, fixed, ...rest);
  }

  return rounds;
}

/**
 * Knockout Bracket generation with Seeding and Power-of-2 Byes.
 */
function generateKnockoutBrackets(teams) {
  // Sort by seed if available
  const sortedTeams = [...teams].sort((a, b) => (a.seed_number || 999) - (b.seed_number || 999));
  const teamCount = sortedTeams.length;

  if (teamCount < 2) {
    throw new Error('At least 2 teams are required to generate a knockout bracket.');
  }

  // Next power of 2
  let bracketSize = 2;
  while (bracketSize < teamCount) {
    bracketSize *= 2;
  }

  const totalRounds = Math.log2(bracketSize);
  const byesCount = bracketSize - teamCount;

  // Standard tournament seeding bracket distribution (1 vs 16, 2 vs 15, etc.)
  let seeds = [1, 2];
  while (seeds.length < bracketSize) {
    const nextSeeds = [];
    const currentSize = seeds.length * 2;
    for (const s of seeds) {
      nextSeeds.push(s);
      nextSeeds.push(currentSize + 1 - s);
    }
    seeds = nextSeeds;
  }

  // Map seed numbers to actual teams or BYE
  const seededTeams = seeds.map(seedNum => {
    if (seedNum <= teamCount) {
      return sortedTeams[seedNum - 1];
    }
    return null; // BYE
  });

  const round1Matches = [];
  const roundNames = getKnockoutRoundNames(totalRounds);

  for (let i = 0; i < seededTeams.length; i += 2) {
    const teamA = seededTeams[i];
    const teamB = seededTeams[i + 1];

    round1Matches.push({
      roundNumber: 1,
      roundName: roundNames[0],
      teamAId: teamA ? teamA.team_id : null,
      teamBId: teamB ? teamB.team_id : null,
      isBye: !teamA || !teamB
    });
  }

  return {
    bracketSize,
    totalRounds,
    byesCount,
    roundNames,
    round1Matches
  };
}

function getKnockoutRoundNames(totalRounds) {
  const names = [];
  for (let r = 1; r <= totalRounds; r++) {
    const remainingMatches = Math.pow(2, totalRounds - r);
    if (remainingMatches === 1) names.push('FINAL');
    else if (remainingMatches === 2) names.push('SEMI_FINAL');
    else if (remainingMatches === 4) names.push('QUARTER_FINAL');
    else if (remainingMatches === 8) names.push('ROUND_OF_16');
    else if (remainingMatches === 16) names.push('ROUND_OF_32');
    else names.push(`ROUND_${r}`);
  }
  return names;
}

/**
 * Main Fixture Generator supporting all tournament formats.
 */
async function generateFixtures(tournamentId, options = {}, user) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  // Authorization check: Only ADMIN or the tournament creator/venue owner
  if (user.role !== 'ADMIN' && tournament.created_by !== user.id) {
    throw { statusCode: 403, message: 'You are not authorized to manage fixtures for this tournament.' };
  }

  // Check if live or completed matches already exist
  const existingMatches = await db.query(
    `SELECT id, status FROM tournament_matches 
     WHERE tournament_id = ? AND status IN ('LIVE', 'COMPLETED', 'PAUSED')`,
    [tournament.id]
  );
  if (existingMatches && existingMatches.length > 0 && !options.forceRegenerate) {
    throw {
      statusCode: 400,
      message: 'Cannot regenerate fixtures: tournament already has live or completed matches with scores. Reset completed matches before regenerating.'
    };
  }

  // Delete previously generated SCHEDULED / READY matches
  await db.query(
    `DELETE FROM tournament_matches 
     WHERE tournament_id = ? AND status IN ('SCHEDULED', 'READY')`,
    [tournament.id]
  );

  // Fetch registered teams
  const teams = await db.query(
    `SELECT tt.team_id, tt.group_name, tt.seed_number, tm.name, tm.uuid as public_id
     FROM tournament_teams tt
     JOIN teams tm ON tt.team_id = tm.id
     WHERE tt.tournament_id = ? AND tt.registration_status = 'APPROVED'
     ORDER BY tt.group_name ASC, tt.seed_number ASC, tm.name ASC`,
    [tournament.id]
  );

  if (!teams || teams.length < 2) {
    throw { statusCode: 400, message: 'Tournament must have at least 2 approved teams to generate fixtures.' };
  }

  // Get available venue courts
  const venueId = tournament.venue_id;
  let courts = [];
  if (venueId) {
    try {
      courts = await db.query(
        `SELECT id, name FROM courts WHERE venue_id = ? AND (status = 'ACTIVE' OR status IS NULL) ORDER BY id ASC`,
        [venueId]
      );
    } catch (courtErr) {
      courts = await db.query(
        `SELECT id, name FROM courts WHERE venue_id = ? ORDER BY id ASC`,
        [venueId]
      );
    }
  }
  if (!courts || courts.length === 0) {
    courts = [{ id: null, name: 'Main Court' }];
  }

  const format = (tournament.tournament_format || tournament.format || 'ROUND_ROBIN').toUpperCase();
  const generatedMatches = [];
  let matchNumberSeq = 1;

  const startDate = new Date(tournament.start_date || Date.now());
  const matchDurationMinutes = options.matchDurationMinutes || 60;
  const bufferMinutes = options.bufferMinutes || 15;
  const dailyStartTime = options.dailyStartTime || '09:00:00';
  const matchesPerDay = options.matchesPerDay || 8;

  let currentDayOffset = 0;
  let currentMatchInDay = 0;

  function getNextSlot() {
    const matchDate = new Date(startDate.getTime() + currentDayOffset * 86400000).toISOString().slice(0, 10);
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

  // ── FORMAT 1: ROUND ROBIN & DOUBLE ROUND ROBIN ──
  if (format === 'ROUND_ROBIN' || format === 'LEAGUE' || format === 'DOUBLE_ROUND_ROBIN') {
    // Group teams by group_name
    const groups = {};
    for (const t of teams) {
      const gName = t.group_name || 'Group 1';
      if (!groups[gName]) groups[gName] = [];
      groups[gName].push(t.team_id);
    }

    for (const [groupName, groupTeamIds] of Object.entries(groups)) {
      if (groupTeamIds.length < 2) continue;

      const roundPairings = generateRoundRobinPairings(groupTeamIds);
      // If double round-robin, duplicate rounds with home/away inverted
      const allRounds = format === 'DOUBLE_ROUND_ROBIN'
        ? [...roundPairings, ...roundPairings.map(r => r.map(p => ({ teamAId: p.teamBId, teamBId: p.teamAId, roundNumber: p.roundNumber + roundPairings.length })))]
        : roundPairings;

      for (let rIdx = 0; rIdx < allRounds.length; rIdx++) {
        const pairings = allRounds[rIdx];
        for (const pair of pairings) {
          const slot = getNextSlot();
          const matchUuid = crypto.randomUUID();

          generatedMatches.push({
            uuid: matchUuid,
            tournamentId: tournament.id,
            matchNumber: matchNumberSeq++,
            teamAId: pair.teamAId,
            teamBId: pair.teamBId,
            venueId,
            courtId: slot.courtId,
            courtName: slot.courtName,
            matchDate: slot.matchDate,
            startTime: slot.startTime,
            endTime: slot.endTime,
            status: 'SCHEDULED',
            groupName,
            stage: 'GROUP',
            roundNumber: pair.roundNumber
          });
        }
      }
    }
  }

  // ── FORMAT 2: SINGLE ELIMINATION KNOCKOUT ──
  else if (format === 'KNOCKOUT' || format === 'SINGLE_ELIMINATION') {
    const bracket = generateKnockoutBrackets(teams);

    // Insert Round 1 matches
    for (const matchDef of bracket.round1Matches) {
      const slot = getNextSlot();
      const matchUuid = crypto.randomUUID();

      // If bye, auto-complete
      const isBye = matchDef.isBye;
      const winnerId = isBye ? (matchDef.teamAId || matchDef.teamBId) : null;
      const status = isBye ? 'COMPLETED' : 'SCHEDULED';
      const resultSummary = isBye ? 'Advanced via Bye' : null;

      generatedMatches.push({
        uuid: matchUuid,
        tournamentId: tournament.id,
        matchNumber: matchNumberSeq++,
        teamAId: matchDef.teamAId,
        teamBId: matchDef.teamBId,
        venueId,
        courtId: slot.courtId,
        courtName: slot.courtName,
        matchDate: slot.matchDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status,
        winnerTeamId: winnerId,
        resultSummary,
        groupName: null,
        stage: matchDef.roundName,
        roundNumber: 1
      });
    }

    // Pre-create placeholder matches for subsequent rounds
    for (let r = 2; r <= bracket.totalRounds; r++) {
      const matchesInRound = Math.pow(2, bracket.totalRounds - r);
      const stageName = bracket.roundNames[r - 1];

      for (let m = 0; m < matchesInRound; m++) {
        const slot = getNextSlot();
        const matchUuid = crypto.randomUUID();

        generatedMatches.push({
          uuid: matchUuid,
          tournamentId: tournament.id,
          matchNumber: matchNumberSeq++,
          teamAId: null,
          teamBId: null,
          venueId,
          courtId: slot.courtId,
          courtName: slot.courtName,
          matchDate: slot.matchDate,
          startTime: slot.startTime,
          endTime: slot.endTime,
          status: 'SCHEDULED',
          groupName: null,
          stage: stageName,
          roundNumber: r
        });
      }
    }

    // Optional 3rd Place Playoff
    if (tournament.third_place_playoff) {
      const slot = getNextSlot();
      generatedMatches.push({
        uuid: crypto.randomUUID(),
        tournamentId: tournament.id,
        matchNumber: matchNumberSeq++,
        teamAId: null,
        teamBId: null,
        venueId,
        courtId: slot.courtId,
        courtName: slot.courtName,
        matchDate: slot.matchDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        status: 'SCHEDULED',
        groupName: null,
        stage: 'THIRD_PLACE',
        roundNumber: bracket.totalRounds
      });
    }
  }

  // ── FORMAT 3: GROUP STAGE FOLLOWED BY KNOCKOUT PLAYOFFS ──
  else if (format === 'GROUP_KNOCKOUT' || format === 'LEAGUE_KNOCKOUT') {
    // 1. Group Stage Fixtures
    const groups = {};
    for (const t of teams) {
      const gName = t.group_name || 'Group 1';
      if (!groups[gName]) groups[gName] = [];
      groups[gName].push(t.team_id);
    }

    for (const [groupName, groupTeamIds] of Object.entries(groups)) {
      if (groupTeamIds.length < 2) continue;
      const roundPairings = generateRoundRobinPairings(groupTeamIds);

      for (const pairings of roundPairings) {
        for (const pair of pairings) {
          const slot = getNextSlot();
          generatedMatches.push({
            uuid: crypto.randomUUID(),
            tournamentId: tournament.id,
            matchNumber: matchNumberSeq++,
            teamAId: pair.teamAId,
            teamBId: pair.teamBId,
            venueId,
            courtId: slot.courtId,
            courtName: slot.courtName,
            matchDate: slot.matchDate,
            startTime: slot.startTime,
            endTime: slot.endTime,
            status: 'SCHEDULED',
            groupName,
            stage: 'GROUP',
            roundNumber: pair.roundNumber
          });
        }
      }
    }

    // 2. Placeholder Playoff Matches (e.g. Semis & Final)
    const playoffSlots = 4; // Typically top 2 from Group 1 & Group 2
    const semiSlot1 = getNextSlot();
    const semiSlot2 = getNextSlot();
    const finalSlot = getNextSlot();

    generatedMatches.push({
      uuid: crypto.randomUUID(),
      tournamentId: tournament.id,
      matchNumber: matchNumberSeq++,
      teamAId: null,
      teamBId: null,
      venueId,
      courtId: semiSlot1.courtId,
      courtName: semiSlot1.courtName,
      matchDate: semiSlot1.matchDate,
      startTime: semiSlot1.startTime,
      endTime: semiSlot1.endTime,
      status: 'SCHEDULED',
      groupName: null,
      stage: 'SEMI_FINAL',
      roundNumber: 2
    });

    generatedMatches.push({
      uuid: crypto.randomUUID(),
      tournamentId: tournament.id,
      matchNumber: matchNumberSeq++,
      teamAId: null,
      teamBId: null,
      venueId,
      courtId: semiSlot2.courtId,
      courtName: semiSlot2.courtName,
      matchDate: semiSlot2.matchDate,
      startTime: semiSlot2.startTime,
      endTime: semiSlot2.endTime,
      status: 'SCHEDULED',
      groupName: null,
      stage: 'SEMI_FINAL',
      roundNumber: 2
    });

    generatedMatches.push({
      uuid: crypto.randomUUID(),
      tournamentId: tournament.id,
      matchNumber: matchNumberSeq++,
      teamAId: null,
      teamBId: null,
      venueId,
      courtId: finalSlot.courtId,
      courtName: finalSlot.courtName,
      matchDate: finalSlot.matchDate,
      startTime: finalSlot.startTime,
      endTime: finalSlot.endTime,
      status: 'SCHEDULED',
      groupName: null,
      stage: 'FINAL',
      roundNumber: 3
    });
  }

  // Batch insert all generated matches into tournament_matches
  for (const m of generatedMatches) {
    await db.query(
      `INSERT INTO tournament_matches (
        uuid, tournament_id, match_number, team_a_id, team_b_id, venue_id,
        court_id, court_name, match_date, start_time, end_time, status,
        winner_team_id, result_summary, group_name, stage, round_number,
        live_score_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Yet to Start')`,
      [
        m.uuid, m.tournamentId, m.matchNumber, m.teamAId, m.teamBId, m.venueId,
        m.courtId, m.courtName, m.matchDate, m.startTime, m.endTime, m.status,
        m.winnerTeamId || null, m.resultSummary || null, m.groupName, m.stage, m.roundNumber
      ]
    );
  }

  // Initialize empty points_table entries for all registered teams
  await initializePointsTable(tournament.id, teams);

  return {
    success: true,
    message: `Generated ${generatedMatches.length} fixtures successfully for ${format} format.`,
    matchesCount: generatedMatches.length,
    format
  };
}

/**
 * Initializes points_table rows for all registered teams in a tournament.
 */
async function initializePointsTable(tournamentId, teams) {
  for (const t of teams) {
    const existing = await db.query(
      `SELECT id FROM points_table WHERE tournament_id = ? AND team_id = ?`,
      [tournamentId, t.team_id]
    );
    if (!existing || existing.length === 0) {
      await db.query(
        `INSERT INTO points_table (
          tournament_id, team_id, matches_played, won, lost, tied, drawn,
          no_result, points, net_run_rate, group_name, points_scored,
          points_conceded, point_difference, goals_for, goals_against,
          goal_difference, sets_won, sets_lost
        ) VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0, 0.000, ?, 0, 0, 0, 0, 0, 0, 0, 0)`,
        [tournamentId, t.team_id, t.group_name || 'Group 1']
      );
    }
  }
}

/**
 * Converts cricket overs notation (e.g. 17.1, 19.5, 20.0) into decimal overs.
 * In cricket notation, the fractional part represents legal balls (balls / 6).
 */
function oversToDecimal(overs) {
  if (overs === null || overs === undefined) return 0;
  const str = String(overs).trim();
  if (!str) return 0;
  const parts = str.split('.');
  const wholeOvers = parseInt(parts[0], 10) || 0;
  const balls = parts.length > 1 ? parseInt(parts[1], 10) || 0 : 0;
  return wholeOvers + (balls / 6);
}

/**
 * Authoritative Standings Recalculation Engine
 * Calculates sport-specific points, GD, NRR, game/point differentials and rankings.
 */
async function recalculateStandings(tournamentId) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) return;

  const sportConfig = getSportConfig(tournament.sport_slug);
  const winPts = sportConfig.standingsFormula?.winPoints ?? 2;
  const drawPts = sportConfig.standingsFormula?.drawPoints ?? (sportConfig.standingsFormula?.tiePoints ?? 1);
  const lossPts = sportConfig.standingsFormula?.lossPoints ?? 0;

  // 1. Fetch all registered teams
  const teams = await db.query(
    `SELECT tt.team_id, COALESCE(tt.group_name, 'Group 1') as group_name
     FROM tournament_teams tt
     WHERE tt.tournament_id = ? AND tt.registration_status = 'APPROVED'`,
    [tournament.id]
  );

  // 2. Fetch all completed group/league matches
  const matches = await db.query(
    `SELECT tm.*, 
            COALESCE(tm.team_a_score, 0) as score_a,
            COALESCE(tm.team_b_score, 0) as score_b
     FROM tournament_matches tm
     WHERE tm.tournament_id = ? 
       AND tm.status = 'COMPLETED'
       AND (tm.counts_in_standings = 1 OR (tm.counts_in_standings IS NULL AND (tm.category = 'League' OR tm.category IS NULL)))`,
    [tournament.id]
  );

  // Fetch cricket innings for completed matches if sport is cricket
  const cricketInningsMap = {};
  if (tournament.sport_slug === 'cricket') {
    const inningsRows = await db.query(
      `SELECT ci.*, cm.total_overs as match_quota_overs
       FROM cricket_innings ci
       JOIN tournament_matches tm ON ci.match_id = tm.id
       LEFT JOIN cricket_matches cm ON cm.match_id = tm.id
       WHERE tm.tournament_id = ? AND tm.status = 'COMPLETED'
       ORDER BY ci.match_id ASC, ci.innings_number ASC`,
      [tournament.id]
    );
    for (const inn of inningsRows) {
      if (!cricketInningsMap[inn.match_id]) cricketInningsMap[inn.match_id] = [];
      cricketInningsMap[inn.match_id].push(inn);
    }
  }

  // Initialize team aggregates
  const statsMap = {};
  for (const t of teams) {
    statsMap[t.team_id] = {
      teamId: t.team_id,
      groupName: t.group_name,
      played: 0,
      won: 0,
      lost: 0,
      drawn: 0,
      points: 0,
      gf: 0,
      ga: 0,
      gd: 0,
      pf: 0,
      pa: 0,
      pdiff: 0,
      setsWon: 0,
      setsLost: 0,
      runsScored: 0,
      oversFaced: 0,
      runsConceded: 0,
      oversBowled: 0,
      nrr: 0.000
    };
  }

  // Aggregate results from matches
  for (const m of matches) {
    const tA = statsMap[m.team_a_id];
    const tB = statsMap[m.team_b_id];
    if (!tA || !tB) continue;

    tA.played++;
    tB.played++;

    const scoreA = Number(m.score_a) || 0;
    const scoreB = Number(m.score_b) || 0;

    // Goals / Points For and Against
    tA.gf += scoreA;
    tA.ga += scoreB;
    tB.gf += scoreB;
    tB.ga += scoreA;

    tA.pf += scoreA;
    tA.pa += scoreB;
    tB.pf += scoreB;
    tB.pa += scoreA;

    // Cricket Innings data for Net Run Rate
    if (tournament.sport_slug === 'cricket') {
      const innings = cricketInningsMap[m.id];
      if (innings && innings.length > 0) {
        for (const inn of innings) {
          const tBat = statsMap[inn.batting_team_id];
          const tBowl = statsMap[inn.bowling_team_id];
          const matchQuota = inn.match_quota_overs || 20;
          // All-out rule: if 10 or more wickets lost, credited with full match quota overs
          const isAllOut = Number(inn.total_wickets) >= 10;
          const decOvers = oversToDecimal(inn.total_overs_bowled);
          const effectiveOvers = isAllOut ? matchQuota : decOvers;

          if (tBat) {
            tBat.runsScored += Number(inn.total_runs) || 0;
            tBat.oversFaced += effectiveOvers;
          }
          if (tBowl) {
            tBowl.runsConceded += Number(inn.total_runs) || 0;
            tBowl.oversBowled += effectiveOvers;
          }
        }
      } else if (m.sport_state) {
        try {
          const state = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : m.sport_state;
          if (state.innings1 && state.innings2) {
            const processInnings = (innObj, defaultBatId, defaultBowlId) => {
              const batId = innObj.battingTeamId || defaultBatId;
              const bowlId = innObj.bowlingTeamId || defaultBowlId;
              const tBat = statsMap[batId];
              const tBowl = statsMap[bowlId];
              const matchQuota = state.totalOvers || 20;
              const isAllOut = Number(innObj.wickets) >= 10;
              const decOvers = oversToDecimal(innObj.overs);
              const effectiveOvers = isAllOut ? matchQuota : decOvers;
              if (tBat) {
                tBat.runsScored += Number(innObj.runs || innObj.totalRuns) || 0;
                tBat.oversFaced += effectiveOvers;
              }
              if (tBowl) {
                tBowl.runsConceded += Number(innObj.runs || innObj.totalRuns) || 0;
                tBowl.oversBowled += effectiveOvers;
              }
            };
            processInnings(state.innings1, m.team_a_id, m.team_b_id);
            processInnings(state.innings2, m.team_b_id, m.team_a_id);
          }
        } catch (e) {}
      }
    }

    // Win, Loss, Draw determination
    if (m.winner_team_id === m.team_a_id) {
      tA.won++;
      tA.points += winPts;
      tB.lost++;
      tB.points += lossPts;
    } else if (m.winner_team_id === m.team_b_id) {
      tB.won++;
      tB.points += winPts;
      tA.lost++;
      tA.points += lossPts;
    } else {
      // Draw / Tie
      tA.drawn++;
      tA.points += drawPts;
      tB.drawn++;
      tB.points += drawPts;
    }
  }

  // Compute differentials and sport-specific metrics
  for (const t of Object.values(statsMap)) {
    t.gd = t.gf - t.ga;
    t.pdiff = t.pf - t.pa;

    if (tournament.sport_slug === 'cricket') {
      const runRateFor = t.oversFaced > 0 ? (t.runsScored / t.oversFaced) : 0;
      const runRateAgainst = t.oversBowled > 0 ? (t.runsConceded / t.oversBowled) : 0;
      const rawNrr = runRateFor - runRateAgainst;
      t.nrr = Math.abs(rawNrr) < 0.0001 ? 0 : parseFloat(rawNrr.toFixed(3));
    }
  }

  // Update points_table in database with net_run_rate included
  for (const s of Object.values(statsMap)) {
    await db.query(
      `INSERT INTO points_table (
        tournament_id, team_id, matches_played, won, lost, tied, drawn,
        points, points_scored, points_conceded, point_difference,
        goals_for, goals_against, goal_difference, sets_won, sets_lost, net_run_rate, group_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        matches_played = VALUES(matches_played),
        won = VALUES(won),
        lost = VALUES(lost),
        tied = VALUES(tied),
        drawn = VALUES(drawn),
        points = VALUES(points),
        points_scored = VALUES(points_scored),
        points_conceded = VALUES(points_conceded),
        point_difference = VALUES(point_difference),
        goals_for = VALUES(goals_for),
        goals_against = VALUES(goals_against),
        goal_difference = VALUES(goal_difference),
        sets_won = VALUES(sets_won),
        sets_lost = VALUES(sets_lost),
        net_run_rate = VALUES(net_run_rate)`,
      [
        tournament.id, s.teamId, s.played, s.won, s.lost, s.drawn, s.drawn,
        s.points, s.pf, s.pa, s.pdiff,
        s.gf, s.ga, s.gd, s.setsWon, s.setsLost, s.nrr, s.groupName
      ]
    );
  }

  // Broadcast standings update event via Socket.IO
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:standingsUpdated', {
      tournamentId: tournament.uuid,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Returns tournament standings grouped by group_name with full rankings.
 */
async function getTournamentStandings(tournamentId) {
  const tournament = await getTournamentEntity(tournamentId);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  const sportSlug = tournament.sport_slug || 'cricket';

  // Order criteria by sport: Points DESC, then NRR/Diff DESC (highest first, positive above negative), then won DESC
  let orderByClause = 'pt.points DESC, pt.point_difference DESC, pt.won DESC';
  if (sportSlug === 'football') {
    orderByClause = 'pt.points DESC, pt.goal_difference DESC, pt.won DESC, pt.goals_for DESC';
  } else if (sportSlug === 'cricket') {
    orderByClause = 'pt.points DESC, pt.net_run_rate DESC, pt.won DESC';
  }

  const rows = await db.query(
    `SELECT 
      pt.*,
      COALESCE(pt.drawn, pt.tied, 0) as draws,
      COALESCE(pt.group_name, 'Group 1') as group_name,
      tm.uuid as team_public_id,
      tm.name as team_name,
      tm.logo_url as team_logo
     FROM points_table pt
     JOIN teams tm ON pt.team_id = tm.id
     WHERE pt.tournament_id = ?
     ORDER BY pt.group_name ASC, ${orderByClause}`,
    [tournament.id]
  );

  const groups = {};
  for (const r of rows) {
    const gName = r.group_name || 'Group 1';
    if (!groups[gName]) groups[gName] = [];

    groups[gName].push({
      teamId: r.team_public_id,
      internalTeamId: r.team_id,
      name: r.team_name,
      logo: r.team_logo,
      played: r.matches_played,
      won: r.won,
      lost: r.lost,
      drawn: r.draws,
      points: r.points,
      goalsFor: r.goals_for || r.points_scored || 0,
      goalsAgainst: r.goals_against || r.points_conceded || 0,
      goalDifference: r.goal_difference != null ? r.goal_difference : (r.point_difference || 0),
      pointsFor: r.points_scored || 0,
      pointsAgainst: r.points_conceded || 0,
      pointDifference: r.point_difference || 0,
      netRunRate: parseFloat(r.net_run_rate) || 0.000,
      setsWon: r.sets_won || 0,
      setsLost: r.sets_lost || 0
    });
  }

  // Calculate ranks
  for (const gName of Object.keys(groups)) {
    groups[gName].forEach((team, idx) => {
      team.rank = idx + 1;
      team.isQualified = idx < (tournament.playoff_teams_per_group || 2);
    });
  }

  return {
    tournamentId: tournament.uuid,
    sportSlug,
    format: tournament.tournament_format || tournament.format,
    groups
  };
}

/**
 * Knockout Auto-Progression:
 * Advances the winner of a completed match to the correct next round match.
 */
async function advanceKnockoutWinner(matchId, winnerTeamId, loserTeamId = null) {
  const [match] = await db.query(
    `SELECT tm.*, t.third_place_playoff, t.uuid as tournament_uuid 
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     WHERE tm.id = ?`,
    [matchId]
  );

  if (!match || !winnerTeamId) return;

  let targetMatchId = null;
  let isTeamA = true;

  // 1. Direct next_match_id link if present
  if (match.next_match_id) {
    targetMatchId = match.next_match_id;
    isTeamA = match.bracket_target_team !== 'TEAM_B';
  } else {
    // 2. Category-based advancement: Quarter-Final -> Semi-Final -> Final
    if (match.category === 'Quarter-Final' || match.category === 'Semi-Final') {
      const nextCategory = match.category === 'Quarter-Final' ? 'Semi-Final' : 'Final';
      const nextMatches = await db.query(
        `SELECT id, match_number, team_a_id, team_b_id, bracket_slot 
         FROM tournament_matches 
         WHERE tournament_id = ? AND category = ? 
         ORDER BY match_number ASC`,
        [match.tournament_id, nextCategory]
      );

      if (nextMatches.length > 0) {
        const curMatches = await db.query(
          `SELECT id, match_number, bracket_slot 
           FROM tournament_matches 
           WHERE tournament_id = ? AND category = ? 
           ORDER BY match_number ASC`,
          [match.tournament_id, match.category]
        );
        const matchIdx = curMatches.findIndex(m => m.id === match.id);
        if (matchIdx !== -1) {
          const tIdx = Math.floor(matchIdx / 2);
          if (nextMatches[tIdx]) {
            targetMatchId = nextMatches[tIdx].id;
            isTeamA = matchIdx % 2 === 0;
          }
        }
      }
    }

    // 3. Round-based fallback
    if (!targetMatchId) {
      const currentRound = match.round_number || 1;
      const nextRound = currentRound + 1;
      const nextRoundMatches = await db.query(
        `SELECT tm.id, tm.match_number, tm.team_a_id, tm.team_b_id, tm.stage
         FROM tournament_matches tm
         WHERE tm.tournament_id = ? 
           AND tm.round_number = ?
           AND tm.stage != 'THIRD_PLACE'
         ORDER BY tm.match_number ASC`,
        [match.tournament_id, nextRound]
      );

      if (nextRoundMatches && nextRoundMatches.length > 0) {
        const currentRoundMatches = await db.query(
          `SELECT id FROM tournament_matches 
           WHERE tournament_id = ? AND round_number = ? AND stage != 'THIRD_PLACE'
           ORDER BY match_number ASC`,
          [match.tournament_id, currentRound]
        );
        const matchIdx = currentRoundMatches.findIndex(m => m.id === match.id);
        if (matchIdx !== -1) {
          const tIdx = Math.floor(matchIdx / 2);
          if (nextRoundMatches[tIdx]) {
            targetMatchId = nextRoundMatches[tIdx].id;
            isTeamA = matchIdx % 2 === 0;
          }
        }
      }
    }
  }

  // Update target match with advancing team
  if (targetMatchId) {
    if (isTeamA) {
      await db.query(`UPDATE tournament_matches SET team_a_id = ? WHERE id = ?`, [winnerTeamId, targetMatchId]);
    } else {
      await db.query(`UPDATE tournament_matches SET team_b_id = ? WHERE id = ?`, [winnerTeamId, targetMatchId]);
    }

    const io = getIO();
    if (io) {
      io.to(`tournament:${match.tournament_uuid || match.tournament_id}`).emit('tournament:matchesUpdated', {
        tournamentId: match.tournament_uuid || match.tournament_id,
        advancedWinnerId: winnerTeamId,
        targetMatchId
      });
    }
  }

  // Handle Third-Place Playoff if this was a Semi-Final
  if (match.stage === 'SEMI_FINAL' && loserTeamId && match.third_place_playoff) {
    const [thirdPlaceMatch] = await db.query(
      `SELECT id, team_a_id, team_b_id FROM tournament_matches 
       WHERE tournament_id = ? AND stage = 'THIRD_PLACE'`,
      [match.tournament_id]
    );

    if (thirdPlaceMatch) {
      if (!thirdPlaceMatch.team_a_id) {
        await db.query(`UPDATE tournament_matches SET team_a_id = ? WHERE id = ?`, [loserTeamId, thirdPlaceMatch.id]);
      } else if (!thirdPlaceMatch.team_b_id) {
        await db.query(`UPDATE tournament_matches SET team_b_id = ? WHERE id = ?`, [loserTeamId, thirdPlaceMatch.id]);
      }
    }
  }
}

module.exports = {
  getTournamentEntity,
  checkSchedulingConflicts,
  generateRoundRobinPairings,
  generateKnockoutBrackets,
  generateFixtures,
  recalculateStandings,
  getTournamentStandings,
  advanceKnockoutWinner
};
