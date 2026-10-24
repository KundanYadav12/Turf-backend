const db = require('../config/database');

async function migrateTournamentAnalytics() {
  console.log('🔄 Running Tournament View Analytics Migration...');

  try {
    // 1. Create tournament_view_events table
    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_view_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        tournament_uuid VARCHAR(64) NOT NULL,
        user_id INT NULL,
        viewer_identifier VARCHAR(64) NOT NULL,
        platform ENUM('WEB', 'MOBILE') NOT NULL DEFAULT 'WEB',
        ip_hash VARCHAR(64) NULL,
        user_agent VARCHAR(255) NULL,
        viewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        view_date DATE NOT NULL,
        INDEX idx_tve_tournament (tournament_id),
        INDEX idx_tve_uuid (tournament_uuid),
        INDEX idx_tve_dedup (tournament_id, viewer_identifier, viewed_at),
        INDEX idx_tve_view_date (view_date),
        INDEX idx_tve_platform (platform),
        INDEX idx_tve_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ tournament_view_events table created or verified.');

    // 2. Check and add additive columns to tournaments table for instant O(1) performance
    const tourneyCols = await db.query('DESCRIBE tournaments');
    const colNames = tourneyCols.map(c => c.Field);

    const columnsToAdd = [];
    if (!colNames.includes('total_views')) {
      columnsToAdd.push('ADD COLUMN total_views INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!colNames.includes('unique_viewers')) {
      columnsToAdd.push('ADD COLUMN unique_viewers INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!colNames.includes('last_viewed_at')) {
      columnsToAdd.push('ADD COLUMN last_viewed_at DATETIME NULL');
    }

    if (columnsToAdd.length > 0) {
      await db.query(`
        ALTER TABLE tournaments 
        ${columnsToAdd.join(',\n        ')}
      `);
      console.log(`✅ Added additive columns (${columnsToAdd.length}) to tournaments table.`);
    } else {
      console.log('ℹ️ tournaments table already contains view analytics columns.');
    }

    console.log('🎉 Tournament Analytics Migration Completed Successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    throw err;
  }
}

if (require.main === module) {
  migrateTournamentAnalytics()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = migrateTournamentAnalytics;
