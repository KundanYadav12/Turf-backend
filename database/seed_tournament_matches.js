const db = require('../config/database');
const crypto = require('crypto');

async function seedTournamentMatches() {
  console.log('--- Ensuring Matches 1, 2, 3, 4 exist for Tournament 2 ---');
  const tournamentUuid = 'ed354683-3ee4-4620-adfc-53680b9d3f15';
  const [t] = await db.query('SELECT id FROM tournaments WHERE uuid = ?', [tournamentUuid]);
  if (!t) {
    console.error('Tournament not found');
    return;
  }
  const tId = t.id;

  const matchesData = [
    {
      matchNumber: 2,
      teamAId: 2, // Mumbai Warriors
      teamBId: 8, // Thane Tigers
      courtId: 2,
      status: 'SCHEDULED',
      summary: '98/3 (12.2 ov)',
      subtext: 'Mumbai Warriors Batting',
      sportState: {
        totalRuns: 98,
        wickets: 3,
        overs: '12.2',
        crr: 7.95,
        target: 145,
        rrr: 6.13,
        battingTeamName: 'Mumbai Warriors',
        striker: { name: 'K. Rahul', runs: 42, balls: 28, fours: 3, sixes: 2, strikeRate: 150 },
        nonStriker: { name: 'S. Yadav', runs: 24, balls: 18, fours: 2, sixes: 1, strikeRate: 133.3 },
        bowler: { name: 'J. Bumrah', overs: '2.2', maidens: 0, runs: 18, wickets: 1, economy: 7.71 },
        currentOverBalls: ['1', '•', 'W', '4', '1']
      }
    },
    {
      matchNumber: 3,
      teamAId: 5, // Andheri Strikers
      teamBId: 6, // Borivali Blasters
      courtId: 3,
      status: 'SCHEDULED',
      summary: '76/2 (8.4 ov)',
      subtext: 'Andheri Strikers Batting',
      sportState: {
        totalRuns: 76,
        wickets: 2,
        overs: '8.4',
        crr: 8.77,
        target: null,
        rrr: null,
        battingTeamName: 'Andheri Strikers',
        striker: { name: 'H. Pandya', runs: 31, balls: 14, fours: 2, sixes: 3, strikeRate: 221.4 },
        nonStriker: { name: 'R. Jadeja', runs: 15, balls: 10, fours: 1, sixes: 0, strikeRate: 150 },
        bowler: { name: 'M. Shami', overs: '1.4', maidens: 0, runs: 14, wickets: 1, economy: 8.4 },
        currentOverBalls: ['6', '1', '2', '•']
      }
    },
    {
      matchNumber: 4,
      teamAId: 7, // Powai Panthers
      teamBId: 4, // Kandivali XI
      courtId: 1,
      status: 'SCHEDULED',
      summary: '121/6 (16.1 ov)',
      subtext: 'Powai Panthers Batting',
      sportState: {
        totalRuns: 121,
        wickets: 6,
        overs: '16.1',
        crr: 7.48,
        target: 160,
        rrr: 10.17,
        battingTeamName: 'Powai Panthers',
        striker: { name: 'R. Pant', runs: 38, balls: 22, fours: 4, sixes: 1, strikeRate: 172.7 },
        nonStriker: { name: 'A. Patel', runs: 8, balls: 6, fours: 1, sixes: 0, strikeRate: 133.3 },
        bowler: { name: 'K. Yadav', overs: '3.1', maidens: 0, runs: 22, wickets: 2, economy: 6.95 },
        currentOverBalls: ['1', 'W', '•', '4', '1']
      }
    }
  ];

  for (const m of matchesData) {
    const existing = await db.query(
      'SELECT id FROM tournament_matches WHERE tournament_id = ? AND match_number = ?',
      [tId, m.matchNumber]
    );
    if (existing.length === 0) {
      const matchUuid = crypto.randomUUID();
      await db.query(
        `INSERT INTO tournament_matches 
         (uuid, tournament_id, match_number, team_a_id, team_b_id, venue_id, court_id, match_date, start_time, end_time, status, live_score_summary, live_subtext, sport_state)
         VALUES (?, ?, ?, ?, ?, 2, ?, '2026-08-22', '10:00:00', '13:00:00', ?, ?, ?, ?)`,
        [
          matchUuid,
          tId,
          m.matchNumber,
          m.teamAId,
          m.teamBId,
          m.courtId,
          m.status,
          m.summary,
          m.subtext,
          JSON.stringify(m.sportState)
        ]
      );
      console.log(`✓ Seeded match #${m.matchNumber} (${matchUuid})`);
    } else {
      console.log(`Match #${m.matchNumber} already exists`);
    }
  }

  console.log('✓ Seeding complete.');
}

seedTournamentMatches().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
