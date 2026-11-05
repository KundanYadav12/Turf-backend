const db = require('../config/database');

async function migrate() {
  try {
    console.log('--- Migrating Mobile App Update Management Tables ---');

    // 1. Create app_releases table
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_releases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version VARCHAR(50) NOT NULL,
        build_number INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        release_notes TEXT NOT NULL,
        update_type ENUM('OTA', 'NATIVE') NOT NULL DEFAULT 'OTA',
        min_app_version VARCHAR(50) DEFAULT '1.0.0',
        is_mandatory TINYINT(1) DEFAULT 0,
        status ENUM('DRAFT', 'PUBLISHED', 'ROLLED_BACK', 'ARCHIVED') DEFAULT 'DRAFT',
        platform VARCHAR(20) DEFAULT 'android',
        bundle_url VARCHAR(500) NULL,
        apk_url VARCHAR(500) NULL,
        bundle_hash VARCHAR(128) NULL,
        bundle_size_bytes BIGINT NULL,
        runtime_version VARCHAR(50) DEFAULT '1.0.0',
        created_by INT NULL,
        published_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_platform_status (platform, status),
        INDEX idx_version_build (version, build_number)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created app_releases table');

    // 2. Create app_device_installations table
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_device_installations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_id VARCHAR(100) NOT NULL UNIQUE,
        user_id INT NULL,
        platform VARCHAR(20) DEFAULT 'android',
        current_version VARCHAR(50) NOT NULL,
        current_build_number INT DEFAULT 1,
        installed_release_id INT NULL,
        last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(45) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_current_version (current_version),
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created app_device_installations table');

    // 3. Create app_update_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_update_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        release_id INT NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        user_id INT NULL,
        event_type ENUM('NOTIFIED', 'ACCEPTED', 'DOWNLOADED', 'INSTALLED', 'FAILED', 'DISMISSED_LATER', 'APK_CLICKED') NOT NULL,
        error_message TEXT NULL,
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_release_event (release_id, event_type),
        INDEX idx_device_id (device_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created app_update_logs table');

    // 4. Seed initial baseline release 1.0.0 if empty
    const existing = await db.query('SELECT id FROM app_releases WHERE version = ? AND build_number = ?', ['1.0.0', 1]);
    if (!existing || existing.length === 0) {
      await db.query(`
        INSERT INTO app_releases (
          version, build_number, title, release_notes, update_type,
          min_app_version, is_mandatory, status, platform, published_at
        ) VALUES (
          '1.0.0', 1, 'Initial Mobile Release',
          '• Full Sports Booking, Live Tournaments & Real-time Scoring\\n• Push notifications & Live Court View\\n• Video Streaming & Player Profiles',
          'NATIVE', '1.0.0', 0, 'PUBLISHED', 'android', NOW()
        )
      `);
      console.log('✅ Seeded baseline app release v1.0.0 (Build 1)');
    }

    console.log('🎉 Mobile App Update Management migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();

