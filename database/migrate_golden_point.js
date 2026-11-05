const db = require('../config/database');

async function migrate() {
  try {
    console.log('--- Migrating Golden Point Fields for Pickleball ---');

    // 1. Check & Add golden_point_target column to tournament_matches
    const cols = await db.query(`
      SELECT COLUMN_NAME 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'tournament_matches' 
        AND COLUMN_NAME = 'golden_point_target'
    `);

    if (!cols || cols.length === 0) {
      await db.query(`ALTER TABLE tournament_matches ADD COLUMN golden_point_target INT NULL DEFAULT NULL AFTER track_player_points`);
      console.log('✅ Added golden_point_target column to tournament_matches');
    } else {
      console.log('ℹ️ Column golden_point_target already exists in tournament_matches');
    }

    console.log('🎉 Golden Point migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
