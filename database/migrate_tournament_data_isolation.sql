-- =========================================================================
-- Tournament Data Isolation & Safety Migration
-- Safe & Idempotent SQL script
-- =========================================================================

-- 1. Ensure `is_standalone` column exists on `tournament_matches`
SET @col_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'tournament_matches' 
    AND COLUMN_NAME = 'is_standalone'
);

SET @stmt = IF(@col_exists = 0,
  'ALTER TABLE tournament_matches ADD COLUMN is_standalone BOOLEAN NOT NULL DEFAULT FALSE COMMENT ''Explicitly marks matches not affiliated with any tournament''',
  'SELECT "Column is_standalone already exists" AS info'
);
PREPARE run_stmt FROM @stmt;
EXECUTE run_stmt;
DEALLOCATE PREPARE run_stmt;

-- 2. Ensure index `idx_matches_tournament_id` exists
SET @idx_exists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'tournament_matches' 
    AND INDEX_NAME = 'idx_matches_tournament_id'
);

SET @stmt = IF(@idx_exists = 0,
  'CREATE INDEX idx_matches_tournament_id ON tournament_matches (tournament_id)',
  'SELECT "Index idx_matches_tournament_id already exists" AS info'
);
PREPARE run_stmt FROM @stmt;
EXECUTE run_stmt;
DEALLOCATE PREPARE run_stmt;

-- Note on UNIQUE (tournament_id, match_number):
-- Run the following only after duplicate rows in tournament 1 (matches 1, 5..41) are re-sequenced:
-- ALTER TABLE tournament_matches ADD CONSTRAINT uq_tournament_match_number UNIQUE (tournament_id, match_number);
