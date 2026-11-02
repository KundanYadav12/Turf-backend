const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Player Point Tracking & Leaderboard Migration...');

  try {
    // 1. Check & Add `track_player_points` column on `tournament_matches`
    const matchCols = await db.query("SHOW COLUMNS FROM tournament_matches LIKE 'track_player_points'");
    if (matchCols.length === 0) {
      console.log('Adding column track_player_points to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN track_player_points TINYINT(1) NOT NULL DEFAULT 0 
        COMMENT 'When enabled, points are attributed to individual players'
      `);
      console.log('✅ Added column track_player_points.');
    } else {
      console.log('ℹ️ Column track_player_points already exists on tournament_matches.');
    }

    // 2. Check & Add `scored_by_player_id` column on `pickleball_score_logs`
    const logCols = await db.query("SHOW COLUMNS FROM pickleball_score_logs LIKE 'scored_by_player_id'");
    if (logCols.length === 0) {
      console.log('Adding column scored_by_player_id to pickleball_score_logs...');
      await db.query(`
        ALTER TABLE pickleball_score_logs 
        ADD COLUMN scored_by_player_id INT NULL 
        COMMENT 'Credited team_members.id for this point'
      `);
      console.log('✅ Added column scored_by_player_id.');
    } else {
      console.log('ℹ️ Column scored_by_player_id already exists on pickleball_score_logs.');
    }

    // 3. Create `match_point_attributions` table
    console.log('Ensuring match_point_attributions table exists...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS match_point_attributions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        match_id INT NOT NULL,
        tournament_id INT NOT NULL,
        team_id INT NOT NULL,
        player_id INT NOT NULL,
        game_number INT NOT NULL DEFAULT 1,
        score_after VARCHAR(32) NOT NULL,
        point_to VARCHAR(16) NOT NULL,
        sequence_number INT NOT NULL,
        log_id INT NULL,
        is_voided TINYINT(1) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mpa_match (match_id, sequence_number),
        INDEX idx_mpa_tournament_player (tournament_id, player_id, is_voided),
        INDEX idx_mpa_team (team_id),
        CONSTRAINT fk_mpa_match FOREIGN KEY (match_id) REFERENCES tournament_matches(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✅ match_point_attributions table verified.');

    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
