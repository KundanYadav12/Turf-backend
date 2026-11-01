import tournamentEngineService from './services/tournamentEngineService.js';
import db from './config/database.js';

async function runAcceptanceTests() {
  console.log('🧪 Running Standings Acceptance Test Suite for Tournament "XYZ"...\n');

  const tournamentUuid = 'b295f542-a87d-4e94-a7e5-bfff541de7b6';

  // 1. Initial Standings Retrieval (should auto-recompute dynamically and self-heal)
  const standings = await tournamentEngineService.getTournamentStandings(tournamentUuid);

  console.log('--- TEST 1: Groups Count & Group Names ---');
  const groupNames = Object.keys(standings.groups);
  console.log('Found groups:', groupNames);
  if (!groupNames.includes('Group 1') || !groupNames.includes('Group 2')) {
    throw new Error(`FAIL: Expected both 'Group 1' and 'Group 2' to be displayed, got: ${groupNames.join(', ')}`);
  }
  console.log('✅ PASS: Both Group 1 and Group 2 are present.\n');

  console.log('--- TEST 2: Team Stats in Group 1 ---');
  const group1 = standings.groups['Group 1'];
  console.table(group1.map(r => ({
    Rank: r.rank,
    Team: r.name,
    Played: r.played,
    Won: r.won,
    Lost: r.lost,
    PF: r.pointsFor,
    PA: r.pointsAgainst,
    Diff: r.pointDifference,
    Points: r.points
  })));

  // Verify A4 stats
  const a4 = group1.find(t => t.name === 'A4');
  if (!a4) throw new Error('FAIL: Team A4 not found in Group 1 standings!');
  console.log('A4 stats:', {
    played: a4.played,
    won: a4.won,
    lost: a4.lost,
    pf: a4.pointsFor,
    pa: a4.pointsAgainst,
    diff: a4.pointDifference,
    points: a4.points
  });

  if (a4.played !== 2 || a4.won !== 2 || a4.lost !== 0 || a4.pointsFor !== 34 || a4.pointsAgainst !== 26 || a4.pointDifference !== 8 || a4.points !== 4) {
    throw new Error(`FAIL: Expected A4 to have P:2, W:2, L:0, PF:34, PA:26, Diff:+8, Pts:4. Got: ${JSON.stringify(a4)}`);
  }
  console.log('✅ PASS: A4 has correct stats (P:2, W:2, L:0, PF:34, PA:26, Diff:+8, Pts:4).\n');

  // Verify Borivali Blasters stats
  const bb = group1.find(t => t.name === 'Borivali Blasters');
  if (!bb) throw new Error('FAIL: Team "Borivali Blasters" not found in Group 1 standings!');
  console.log('Borivali Blasters stats:', {
    played: bb.played,
    won: bb.won,
    lost: bb.lost,
    pf: bb.pointsFor,
    pa: bb.pointsAgainst,
    diff: bb.pointDifference,
    points: bb.points
  });

  if (bb.played !== 2 || bb.won !== 0 || bb.lost !== 2 || bb.pointsFor !== 26 || bb.pointsAgainst !== 34 || bb.pointDifference !== -8 || bb.points !== 0) {
    throw new Error(`FAIL: Expected Borivali Blasters to have P:2, W:0, L:2, PF:26, PA:34, Diff:-8, Pts:0. Got: ${JSON.stringify(bb)}`);
  }
  console.log('✅ PASS: Borivali Blasters has correct stats (P:2, W:0, L:2, PF:26, PA:34, Diff:-8, Pts:0).\n');

  // Verify other teams have 0 played
  const unplayedTeams = group1.filter(t => t.name !== 'A4' && t.name !== 'Borivali Blasters');
  for (const t of unplayedTeams) {
    if (t.played !== 0 || t.points !== 0) {
      throw new Error(`FAIL: Expected unplayed team ${t.name} to have 0 played and 0 points!`);
    }
  }
  console.log(`✅ PASS: All other ${unplayedTeams.length} teams have 0 played and 0 points.\n`);

  // Verify rank 1 is A4
  if (group1[0].name !== 'A4') {
    throw new Error(`FAIL: Expected A4 to be rank #1, but found: ${group1[0].name}`);
  }
  console.log('✅ PASS: Team A4 is ranked #1 in Group 1.\n');

  // 3. Match edit / reopen test
  console.log('--- TEST 3: Match Reopen / Edit updates standings ---');
  // Reopen Match #1 (set status to LIVE)
  const [tRow] = await db.query('SELECT id FROM tournaments WHERE uuid = ?', [tournamentUuid]);
  const tId = tRow.id;
  await db.query("UPDATE tournament_matches SET status = 'LIVE' WHERE tournament_id = ? AND match_number = 1", [tId]);

  const standingsAfterReopen = await tournamentEngineService.getTournamentStandings(tournamentUuid);
  const a4AfterReopen = standingsAfterReopen.groups['Group 1'].find(t => t.name === 'A4');
  console.log('A4 after Match #1 reopened to LIVE:', {
    played: a4AfterReopen.played,
    won: a4AfterReopen.won,
    pf: a4AfterReopen.pointsFor,
    pa: a4AfterReopen.pointsAgainst,
    points: a4AfterReopen.points
  });

  if (a4AfterReopen.played !== 1 || a4AfterReopen.won !== 1 || a4AfterReopen.pointsFor !== 19 || a4AfterReopen.pointsAgainst !== 17 || a4AfterReopen.points !== 2) {
    throw new Error(`FAIL: Expected A4 after reopening match #1 to have P:1, W:1, PF:19, PA:17, Pts:2. Got: ${JSON.stringify(a4AfterReopen)}`);
  }
  console.log('✅ PASS: Match reopen dynamically updated standings (A4 now has 1W, 2 pts).\n');

  // Restore Match #1 back to COMPLETED
  await db.query("UPDATE tournament_matches SET status = 'COMPLETED' WHERE tournament_id = ? AND match_number = 1", [tId]);
  const standingsAfterRestore = await tournamentEngineService.getTournamentStandings(tournamentUuid);
  const a4AfterRestore = standingsAfterRestore.groups['Group 1'].find(t => t.name === 'A4');
  if (a4AfterRestore.played !== 2 || a4AfterRestore.points !== 4) {
    throw new Error('FAIL: Re-completing match did not restore A4 stats to P:2, Pts:4!');
  }
  console.log('✅ PASS: Re-completing match correctly restored A4 stats to 4 pts.\n');

  // 4. Idempotency test: repeated calls produce identical results
  console.log('--- TEST 4: Idempotency ---');
  await tournamentEngineService.recalculateStandings(tId, { force: true });
  await tournamentEngineService.recalculateStandings(tId, { force: true });
  const finalStandings = await tournamentEngineService.getTournamentStandings(tournamentUuid);
  const a4Final = finalStandings.groups['Group 1'].find(t => t.name === 'A4');
  if (a4Final.points !== 4 || a4Final.played !== 2) {
    throw new Error('FAIL: Recalculate standings is not idempotent!');
  }
  console.log('✅ PASS: Recalculate standings is completely idempotent.\n');

  console.log('🎉 ALL ACCEPTANCE TESTS PASSED SUCCESSFULLY! 🎉');
  process.exit(0);
}

runAcceptanceTests().catch(err => {
  console.error('\n❌ TEST SUITE FAILED:', err);
  process.exit(1);
});
