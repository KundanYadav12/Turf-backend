const db = require('../config/database');

async function migrateAdSizingAndSidebars() {
  console.log('--- Migrating Advertisements Table for Sizing & Sidebars ---');

  try {
    const cols = await db.query('DESCRIBE advertisements');
    const colNames = cols.map((c) => c.Field);

    // 1. Expand position column to VARCHAR(50) so it supports 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'BOTH_SIDEBARS'
    const positionCol = cols.find(c => c.Field === 'position');
    if (positionCol && positionCol.Type.includes('enum')) {
      await db.query("ALTER TABLE advertisements MODIFY COLUMN position VARCHAR(50) NOT NULL DEFAULT 'TOP'");
      console.log("✓ Modified 'position' column to VARCHAR(50)");
    }

    // 2. Add width column
    if (!colNames.includes('width')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN width VARCHAR(50) NOT NULL DEFAULT '100%' AFTER image_url");
      console.log("✓ Added 'width' column");
    }

    // 3. Add height column
    if (!colNames.includes('height')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN height VARCHAR(50) NOT NULL DEFAULT 'auto' AFTER width");
      console.log("✓ Added 'height' column");
    }

    // 4. Add size_preset column
    if (!colNames.includes('size_preset')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN size_preset VARCHAR(50) NOT NULL DEFAULT 'RESPONSIVE' AFTER height");
      console.log("✓ Added 'size_preset' column");
    }

    // 5. Add image_fit column
    if (!colNames.includes('image_fit')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN image_fit VARCHAR(30) NOT NULL DEFAULT 'contain' AFTER size_preset");
      console.log("✓ Added 'image_fit' column");
    }

    // 6. Add motion_type column (STATIC, SCROLL, SLIDE, CAROUSEL, MARQUEE, CROSSFADE)
    if (!colNames.includes('motion_type')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN motion_type VARCHAR(50) NOT NULL DEFAULT 'STATIC' AFTER display_mode");
      console.log("✓ Added 'motion_type' column");
    }

    // 7. Add movement_direction column
    if (!colNames.includes('movement_direction')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN movement_direction VARCHAR(50) NOT NULL DEFAULT 'RIGHT_TO_LEFT' AFTER motion_type");
      console.log("✓ Added 'movement_direction' column");
    }

    // 8. Add slide_interval column (for carousel / rotating slides)
    if (!colNames.includes('slide_interval')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN slide_interval INT NOT NULL DEFAULT 6 AFTER speed");
      console.log("✓ Added 'slide_interval' column");
    }

    // 9. Add pause_on_hover column
    if (!colNames.includes('pause_on_hover')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN pause_on_hover TINYINT(1) NOT NULL DEFAULT 1 AFTER slide_interval");
      console.log("✓ Added 'pause_on_hover' column");
    }

    // 10. Add target_page column
    if (!colNames.includes('target_page')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN target_page VARCHAR(100) NOT NULL DEFAULT 'ALL' AFTER tournament_id");
      console.log("✓ Added 'target_page' column");
    }

    // 11. Add device_target column
    if (!colNames.includes('device_target')) {
      await db.query("ALTER TABLE advertisements ADD COLUMN device_target VARCHAR(50) NOT NULL DEFAULT 'ALL' AFTER target_page");
      console.log("✓ Added 'device_target' column");
    }

    // 12. Migrate legacy display_mode values to motion_type for consistency
    await db.query("UPDATE advertisements SET motion_type = 'SCROLL' WHERE position = 'BOTTOM' AND (motion_type = 'STATIC' OR motion_type IS NULL)");
    await db.query("UPDATE advertisements SET motion_type = 'STATIC' WHERE position = 'TOP' AND (motion_type IS NULL OR motion_type = '')");

    console.log('✓ All advertisement schema updates applied successfully.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrateAdSizingAndSidebars().then(() => process.exit(0));
