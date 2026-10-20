const db = require('../config/database');

async function migrate() {
  console.log('--- Migrating Module B: Player Registration Tables ---');

  try {
    // 1. Table: tournament_player_registration_configs
    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_player_registration_configs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT UNIQUE NOT NULL,
        is_open TINYINT(1) DEFAULT 1,
        registration_deadline DATETIME NULL,
        max_players INT NULL,
        min_age INT NULL,
        max_age INT NULL,
        fields_config JSON NOT NULL,
        consent_text TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tprc_tourn (tournament_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created tournament_player_registration_configs table');

    // 2. Table: tournament_player_registrations
    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_player_registrations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(36) UNIQUE NOT NULL,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        full_name VARCHAR(120) NOT NULL,
        phone VARCHAR(20) NOT NULL,
        email VARCHAR(120) NULL,
        date_of_birth DATE NULL,
        age INT NULL,
        playing_hand VARCHAR(20) NULL,
        address TEXT NULL,
        aadhaar_encrypted TEXT NULL,
        aadhaar_last4 VARCHAR(4) NULL,
        photo_url VARCHAR(255) NULL,
        preferred_role VARCHAR(60) NULL,
        preferred_team_id INT NULL,
        jersey_size VARCHAR(10) NULL,
        custom_fields_data JSON NULL,
        status ENUM('PENDING', 'APPROVED', 'DENIED', 'WAITLISTED', 'CONFIRMED', 'WITHDRAWN') DEFAULT 'PENDING',
        denial_reason TEXT NULL,
        assigned_team_id INT NULL,
        assigned_role VARCHAR(60) NULL,
        consent_accepted TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_player_tournament (tournament_id, user_id),
        INDEX idx_tpr_status (tournament_id, status),
        INDEX idx_tpr_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created tournament_player_registrations table');

    // 3. Table: sensitive_data_access_logs
    await db.query(`
      CREATE TABLE IF NOT EXISTS sensitive_data_access_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        user_role VARCHAR(40) NOT NULL,
        registration_id INT NOT NULL,
        accessed_field VARCHAR(40) NOT NULL,
        ip_address VARCHAR(50) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sdal_reg (registration_id),
        INDEX idx_sdal_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created sensitive_data_access_logs table');

    console.log('🎉 Module B Database Migration complete!');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
