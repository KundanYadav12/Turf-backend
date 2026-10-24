const db = require('../config/database');

async function migrateMobileAndCourtMiddleAds() {
  console.log('--- Migrating Advertisements Table for Mobile & Court Middle Strip Ads ---');

  try {
    const cols = await db.query('DESCRIBE advertisements');
    const colNames = cols.map((c) => c.Field);

    // 1. Add devices column (JSON array, e.g. ['MOBILE', 'TV', 'SIGNAGE'])
    if (!colNames.includes('devices')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN devices JSON NULL AFTER device_target");
      console.log("✓ Added 'devices' column");
    }

    // 2. Add description column (VARCHAR(500) for short descriptive text, e.g. for Court Middle Strip cards)
    if (!colNames.includes('description')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN description VARCHAR(500) NULL AFTER title");
      console.log("✓ Added 'description' column");
    }

    // 3. Add link_url column (VARCHAR(500) for optional click-through destination)
    if (!colNames.includes('link_url')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN link_url VARCHAR(500) NULL AFTER image_url");
      console.log("✓ Added 'link_url' column");
    }

    // 4. Ensure position column is VARCHAR(50)
    const posCol = cols.find(c => c.Field === 'position');
    if (posCol && posCol.Type.includes('enum')) {
      await db.query("ALTER TABLE advertisements MODIFY COLUMN position VARCHAR(50) NOT NULL DEFAULT 'TOP'");
      console.log("✓ Updated 'position' to VARCHAR(50)");
    }

    console.log('✓ Mobile & Court Middle Ads migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    throw err;
  }
}

if (require.main === module) {
  migrateMobileAndCourtMiddleAds()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrateMobileAndCourtMiddleAds;
