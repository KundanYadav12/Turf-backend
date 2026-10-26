const db = require('./config/database');

async function addFrozenCols() {
  try {
    const tCols = await db.query("SHOW COLUMNS FROM tournaments WHERE Field = 'is_standings_frozen'");
    if (tCols.length === 0) {
      await db.query("ALTER TABLE tournaments ADD COLUMN is_standings_frozen TINYINT(1) NOT NULL DEFAULT 0");
      console.log('✅ Added is_standings_frozen to tournaments table.');
    } else {
      console.log('ℹ️ tournaments.is_standings_frozen already exists.');
    }

    const pCols = await db.query("SHOW COLUMNS FROM points_table WHERE Field = 'is_frozen'");
    if (pCols.length === 0) {
      await db.query("ALTER TABLE points_table ADD COLUMN is_frozen TINYINT(1) NOT NULL DEFAULT 0");
      console.log('✅ Added is_frozen to points_table table.');
    } else {
      console.log('ℹ️ points_table.is_frozen already exists.');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error adding columns:', err);
    process.exit(1);
  }
}

addFrozenCols();
