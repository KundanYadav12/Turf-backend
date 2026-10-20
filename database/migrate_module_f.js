const db = require('../config/database');

async function migrateModuleF() {
  console.log('--- Migrating Module F (Orientation & Portrait Display Support) ---');
  try {
    const cols = await db.query('SHOW COLUMNS FROM tv_displays');
    const colNames = cols.map(c => c.Field);

    if (!colNames.includes('orientation')) {
      await db.query("ALTER TABLE tv_displays ADD COLUMN orientation VARCHAR(20) DEFAULT 'AUTO' AFTER layout_type");
      console.log("Added 'orientation' column to tv_displays.");
    } else {
      console.log("'orientation' column already exists in tv_displays.");
    }

    if (!colNames.includes('sidebars_mode')) {
      await db.query("ALTER TABLE tv_displays ADD COLUMN sidebars_mode VARCHAR(20) DEFAULT 'STRIP' AFTER ad_sidebars_enabled");
      console.log("Added 'sidebars_mode' column to tv_displays.");
    } else {
      console.log("'sidebars_mode' column already exists in tv_displays.");
    }

    console.log('Module F migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrateModuleF();
