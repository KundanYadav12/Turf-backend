const db = require('../config/database');

async function migrate() {
  console.log('--- Migrating Module E & H: court_color and tournament_ids ---');

  // 1. Add court_color to tournaments
  const tournCols = await db.query('SHOW COLUMNS FROM tournaments');
  const hasCourtColor = tournCols.some(c => c.Field === 'court_color');
  if (!hasCourtColor) {
    await db.query("ALTER TABLE tournaments ADD COLUMN court_color VARCHAR(30) DEFAULT '#0d5c3a' AFTER banner_url");
    console.log('Added court_color column to tournaments.');
  } else {
    console.log('court_color column already exists in tournaments.');
  }

  // 2. Add tournament_ids to advertisements
  const adCols = await db.query('SHOW COLUMNS FROM advertisements');
  const hasTournIds = adCols.some(c => c.Field === 'tournament_ids');
  if (!hasTournIds) {
    await db.query("ALTER TABLE advertisements ADD COLUMN tournament_ids JSON NULL DEFAULT NULL AFTER tournament_id");
    console.log('Added tournament_ids JSON column to advertisements.');
  } else {
    console.log('tournament_ids column already exists in advertisements.');
  }

  // Backfill existing tournament_id into tournament_ids if empty
  await db.query(`
    UPDATE advertisements 
    SET tournament_ids = JSON_ARRAY(tournament_id) 
    WHERE tournament_id IS NOT NULL AND (tournament_ids IS NULL OR JSON_LENGTH(tournament_ids) = 0)
  `);
  console.log('Backfilled existing tournament_id into tournament_ids where applicable.');

  console.log('--- Migration Module E & H Complete! ---');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
