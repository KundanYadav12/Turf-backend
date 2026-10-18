const db = require('../config/database');

async function migrate() {
  try {
    try {
      await db.query(`ALTER TABLE tournament_matches ADD COLUMN live_score_summary VARCHAR(100) DEFAULT 'Yet to Start'`);
    } catch (e) {
      console.log('live_score_summary column exists or error:', e.message);
    }
    try {
      await db.query(`ALTER TABLE tournament_matches ADD COLUMN live_subtext VARCHAR(100) DEFAULT NULL`);
    } catch (e) {
      console.log('live_subtext column exists or error:', e.message);
    }
    try {
      await db.query(`ALTER TABLE tournament_matches ADD COLUMN sport_state JSON DEFAULT NULL`);
    } catch (e) {
      console.log('sport_state column exists or error:', e.message);
    }

    // Set 2 matches to LIVE with mock score state to test simultaneous live matches
    await db.query(`
      UPDATE tournament_matches 
      SET status = 'LIVE',
          live_score_summary = '142/3 (16.2 ov)',
          live_subtext = 'CRR 8.70 | Target 178 | Kunal Warriors need 36 in 22',
          sport_state = ?
      WHERE id = 41
    `, [JSON.stringify({
      sport: 'cricket',
      currentInnings: 2,
      runs: 142,
      wickets: 3,
      overs: '16.2',
      target: 178,
      striker: { name: 'Kundan K.', runs: 56, balls: 29 },
      nonStriker: { name: 'Rahul M.', runs: 24, balls: 16 },
      bowler: { name: 'Aditya S.', overs: '3.2', runs: 30, wickets: 1 }
    })]);

    await db.query(`
      UPDATE tournament_matches 
      SET status = 'LIVE',
          live_score_summary = '98/2 (11.0 ov)',
          live_subtext = '1st Innings | Malad Kings elected to bat',
          sport_state = ?
      WHERE id = 42
    `, [JSON.stringify({
      sport: 'cricket',
      currentInnings: 1,
      runs: 98,
      wickets: 2,
      overs: '11.0',
      target: null,
      striker: { name: 'Sameer P.', runs: 44, balls: 28 },
      nonStriker: { name: 'Vikas T.', runs: 18, balls: 14 },
      bowler: { name: 'Nikhil R.', overs: '2.0', runs: 14, wickets: 0 }
    })]);

    console.log('MIGRATION_AND_SEED_COMPLETE');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
