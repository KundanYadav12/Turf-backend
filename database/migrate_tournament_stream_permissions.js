const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Tournament Streaming Permissions Migration (tournament_stream_permissions)...');

  try {
    // 1. Create tournament_stream_permissions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_stream_permissions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(64) NOT NULL UNIQUE,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        match_id BIGINT NULL,
        granted_by INT NOT NULL,
        scope ENUM('TOURNAMENT', 'MATCH') NOT NULL DEFAULT 'TOURNAMENT',
        status ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
        expires_at DATETIME NULL,
        revoked_at DATETIME NULL,
        revoked_by INT NULL,
        notes VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tsp_tournament (tournament_id),
        INDEX idx_tsp_user (user_id),
        INDEX idx_tsp_match (match_id),
        INDEX idx_tsp_status (status),
        INDEX idx_tsp_scope (scope),
        INDEX idx_tsp_lookup (tournament_id, user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ tournament_stream_permissions table verified/created.');

    // 2. Ensure match_streams has tournament_id indexed
    try {
      await db.query('CREATE INDEX idx_streams_tourn ON match_streams (tournament_id)');
    } catch (e) {
      // index may already exist
    }

    console.log('🎉 Tournament Streaming Permissions Migration Completed Successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = migrate;
