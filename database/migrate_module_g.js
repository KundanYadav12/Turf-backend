const db = require('../config/database');
const { recalculateStandings } = require('../services/tournamentEngineService');

async function migrate() {
  try {
    console.log('--- Migrating Module G: Fixing NRR and Standings Calculations ---');

    // 1. Ensure Innings 1 exists for Match 1 so recalculation from match data matches
    const [existingInn1] = await db.query(
      'SELECT id FROM cricket_innings WHERE match_id = 1 AND innings_number = 1'
    );
    if (!existingInn1) {
      console.log('Inserting Innings 1 for Match 1 in cricket_innings...');
      await db.query(`
        INSERT INTO cricket_innings (match_id, innings_number, batting_team_id, bowling_team_id, total_runs, total_wickets, total_overs_bowled, is_completed)
        VALUES (1, 1, 2, 1, 322, 4, '20.0', 1)
      `);
    }

    // 2. Run authoritative recalculation for tournament 1
    console.log('Recalculating tournament 1 standings...');
    await recalculateStandings(1);

    // 3. Verify points table in tournament 1
    const pts = await db.query(`
      SELECT pt.team_id, t.name as team_name, pt.matches_played, pt.won, pt.lost, pt.points, pt.net_run_rate
      FROM points_table pt
      JOIN teams t ON pt.team_id = t.id
      WHERE pt.tournament_id = 1
      ORDER BY pt.points DESC, pt.net_run_rate DESC
    `);
    console.log('Tournament 1 Standings after recalculation:');
    console.table(pts);

    console.log('Module G migration completed successfully!');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

migrate();
