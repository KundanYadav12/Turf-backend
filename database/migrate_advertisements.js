const db = require('../config/database');

async function migrateAdvertisements() {
  console.log('--- Migrating Advertisements Table ---');

  try {
    // 1. Check existing columns in advertisements
    const cols = await db.query('DESCRIBE advertisements');
    const colNames = cols.map(c => c.Field);

    // Add title if not present
    if (!colNames.includes('title')) {
      await db.query('ALTER TABLE advertisements ADD COLUMN title VARCHAR(255) NULL AFTER id');
      await db.query('UPDATE advertisements SET title = name WHERE title IS NULL');
      console.log('✓ Added title column to advertisements');
    }

    // Add display_mode if not present
    if (!colNames.includes('display_mode')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN display_mode ENUM('STATIC', 'MOTION', 'PAUSED', 'HIDDEN') NOT NULL DEFAULT 'STATIC' AFTER position");
      console.log('✓ Added display_mode column to advertisements');
    }

    // Add sort_order if not present
    if (!colNames.includes('sort_order')) {
      await db.query('ALTER TABLE advertisements ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER priority');
      await db.query('UPDATE advertisements SET sort_order = priority WHERE sort_order = 0');
      console.log('✓ Added sort_order column to advertisements');
    }

    // Add tournament_id if not present
    if (!colNames.includes('tournament_id')) {
      await db.query('ALTER TABLE advertisements ADD COLUMN tournament_id INT NULL AFTER end_date, ADD INDEX idx_ads_tournament (tournament_id)');
      console.log('✓ Added tournament_id column to advertisements');
    }

    // Add created_by if not present
    if (!colNames.includes('created_by')) {
      await db.query('ALTER TABLE advertisements ADD COLUMN created_by INT NULL AFTER tournament_id');
      console.log('✓ Added created_by column to advertisements');
    }

    // Ensure sample ads have title and valid display_mode
    await db.query("UPDATE advertisements SET display_mode = 'STATIC' WHERE position = 'TOP' AND (display_mode IS NULL OR display_mode = '')");
    await db.query("UPDATE advertisements SET display_mode = 'MOTION' WHERE position = 'BOTTOM' AND (display_mode IS NULL OR display_mode = '')");

    console.log('✓ Advertisements schema verified and updated successfully.');
  } catch (error) {
    console.error('Advertisement migration failed:', error);
  }
}

migrateAdvertisements().then(() => process.exit(0));
