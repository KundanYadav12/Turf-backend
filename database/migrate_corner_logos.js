const db = require('../config/database');

async function migrateCornerLogos() {
  console.log('--- Migrating Advertisements Table for Corner Logos (Opacity & Margin) ---');
  try {
    const cols = await db.query('DESCRIBE advertisements');
    const colNames = cols.map(c => c.Field);

    if (!colNames.includes('opacity')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN opacity INT NOT NULL DEFAULT 100 AFTER image_fit");
      console.log('✔ Added opacity column to advertisements');
    } else {
      console.log('ℹ opacity column already exists in advertisements');
    }

    if (!colNames.includes('margin')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN margin VARCHAR(30) NOT NULL DEFAULT '2%' AFTER opacity");
      console.log('✔ Added margin column to advertisements');
    } else {
      console.log('ℹ margin column already exists in advertisements');
    }

    console.log('✔ Corner logos schema migration completed successfully.');
  } catch (error) {
    console.error('❌ Corner logos migration failed:', error);
    process.exit(1);
  }
}

migrateCornerLogos().then(() => process.exit(0));

