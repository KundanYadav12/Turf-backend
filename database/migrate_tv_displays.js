const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Smart TV Mode & Displays Migration...');

  try {
    // 1. Create tv_displays table
    await db.query(`
      CREATE TABLE IF NOT EXISTS tv_displays (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(64) NOT NULL UNIQUE,
        name VARCHAR(150) NOT NULL DEFAULT 'Main Arena Smart TV',
        venue_id INT NULL,
        tournament_id INT NULL,
        pairing_code VARCHAR(10) NULL,
        pairing_code_expires_at DATETIME NULL,
        is_paired BOOLEAN NOT NULL DEFAULT TRUE,
        display_token VARCHAR(128) NULL,
        layout_type VARCHAR(50) NOT NULL DEFAULT 'AUTO',
        match_count INT NOT NULL DEFAULT 4,
        selected_match_ids JSON NULL,
        featured_match_id INT NULL,
        show_completed_matches BOOLEAN NOT NULL DEFAULT FALSE,
        rotation_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        rotation_interval INT NOT NULL DEFAULT 15,
        active_scenes JSON NULL,
        ad_top_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ad_bottom_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ad_sidebars_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        ad_center_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        theme VARCHAR(20) NOT NULL DEFAULT 'dark',
        animation_speed VARCHAR(20) NOT NULL DEFAULT 'normal',
        created_by INT NULL,
        last_seen_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tv_venue (venue_id),
        INDEX idx_tv_tournament (tournament_id),
        INDEX idx_tv_pairing (pairing_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ tv_displays table verified/created.');

    // 2. Seed a default TV display for the first ongoing tournament if none exists
    const existing = await db.query('SELECT id FROM tv_displays LIMIT 1');
    if (existing.length === 0) {
      const tournaments = await db.query('SELECT id FROM tournaments ORDER BY id ASC LIMIT 1');
      const tourId = tournaments.length > 0 ? tournaments[0].id : null;

      const scenesJson = JSON.stringify(['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'SPONSORS', 'RESULTS']);
      await db.query(`
        INSERT INTO tv_displays (
          uuid, name, tournament_id, layout_type, match_count, 
          rotation_enabled, rotation_interval, active_scenes,
          ad_top_enabled, ad_bottom_enabled, ad_sidebars_enabled, theme
        ) VALUES (
          'tv_arena_main_01', 'Stadium Center Court Smart TV', ?, 'AUTO', 4,
          TRUE, 15, ?,
          TRUE, TRUE, TRUE, 'dark'
        )
      `, [tourId, scenesJson]);
      console.log('✅ Default Smart TV display profile seeded.');
    } else {
      console.log('ℹ️ Smart TV display profiles already exist.');
    }

    console.log('🎉 Smart TV Mode migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Smart TV Mode migration failed:', error);
    process.exit(1);
  }
}

migrate();
