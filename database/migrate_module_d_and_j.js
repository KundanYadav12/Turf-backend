const db = require('../config/database');

async function migrateModuleDandJ() {
  console.log('Running Module D & J migration...');
  try {
    const cols = await db.query('DESCRIBE tournament_matches');
    const hasShowOnDisplay = cols.some(c => c.Field === 'show_on_display');
    if (!hasShowOnDisplay) {
      await db.query("ALTER TABLE tournament_matches ADD COLUMN show_on_display TINYINT(1) NOT NULL DEFAULT 1 AFTER status");
      console.log('Added show_on_display column to tournament_matches.');
    } else {
      console.log('show_on_display column already exists.');
    }

    const hasCategory = cols.some(c => c.Field === 'category');
    if (!hasCategory) {
      await db.query("ALTER TABLE tournament_matches ADD COLUMN category VARCHAR(50) NOT NULL DEFAULT 'League' AFTER show_on_display");
      console.log('Added category column to tournament_matches.');
    } else {
      console.log('category column already exists.');
    }

    console.log('Migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  }
}

migrateModuleDandJ();
