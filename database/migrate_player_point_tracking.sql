-- Migration: Player Point Tracking & Leaderboard (Additive & Idempotent)

-- 1. Add `track_player_points` column to `tournament_matches`
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tournament_matches'
    AND COLUMN_NAME = 'track_player_points'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE tournament_matches ADD COLUMN track_player_points TINYINT(1) NOT NULL DEFAULT 0 COMMENT \'When enabled, points are attributed to individual players\'',
  'SELECT "Column track_player_points already exists on tournament_matches."'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. Add `scored_by_player_id` column to `pickleball_score_logs`
SET @col_exists_log = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'pickleball_score_logs'
    AND COLUMN_NAME = 'scored_by_player_id'
);
SET @sql_log = IF(@col_exists_log = 0,
  'ALTER TABLE pickleball_score_logs ADD COLUMN scored_by_player_id INT NULL COMMENT \'Credited team_members.id for this point\'',
  'SELECT "Column scored_by_player_id already exists on pickleball_score_logs."'
);
PREPARE stmt_log FROM @sql_log;
EXECUTE stmt_log;
DEALLOCATE PREPARE stmt_log;

-- 3. Create `match_point_attributions` table
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
