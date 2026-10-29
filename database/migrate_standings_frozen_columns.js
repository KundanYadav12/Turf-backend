const db = require('../config/database');

async function migrateStandingsFrozenColumns() {
  console.log('🔄 Checking points_table and tournaments for standings frozen columns...');
  try {
    // 1. tournaments.is_standings_frozen
    const tCols = await db.query("SHOW COLUMNS FROM tournaments LIKE 'is_standings_frozen'");
    if (!tCols || tCols.length === 0) {
      await db.query("ALTER TABLE tournaments ADD COLUMN is_standings_frozen TINYINT(1) NOT NULL DEFAULT 0 AFTER status");
      console.log('✅ Added column is_standings_frozen to tournaments table.');
    } else {
      console.log('ℹ️ tournaments.is_standings_frozen already exists.');
    }

    // 2. points_table.is_frozen
    const pCols = await db.query("SHOW COLUMNS FROM points_table LIKE 'is_frozen'");
    if (!pCols || pCols.length === 0) {
      await db.query("ALTER TABLE points_table ADD COLUMN is_frozen TINYINT(1) NOT NULL DEFAULT 0 AFTER point_difference");
      console.log('✅ Added column is_frozen to points_table table.');
    } else {
      console.log('ℹ️ points_table.is_frozen already exists.');
    }

    console.log('🎉 Standings frozen columns migration completed successfully!');
    if (require.main === module) {
      process.exit(0);
    }
  } catch (err) {
    console.error('❌ Migration failed:', err);
    if (require.main === module) {
      process.exit(1);
    }
    throw err;
  }
}

if (require.main === module) {
  migrateStandingsFrozenColumns();
}

module.exports = migrateStandingsFrozenColumns;
