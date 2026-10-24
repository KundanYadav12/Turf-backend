-- ==============================================================================
-- Production Database Migration: Live Match Streaming
-- TurfSpot / Playzo Platform (MySQL 8.0+ / MariaDB)
-- 
-- Run this script on production database:
-- mysql -u root -p turf_sports_db < backend/database/migrate_streaming_production.sql
-- ==============================================================================

-- 1. Create match_streams table (lifecycle, stream keys, viewer counts, YouTube/RTMP/Mobile configs)
CREATE TABLE IF NOT EXISTS `match_streams` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `uuid` VARCHAR(64) NOT NULL UNIQUE,
  `match_id` BIGINT NOT NULL,
  `tournament_id` BIGINT NULL,
  `user_id` INT NOT NULL,
  `streaming_method` ENUM('MOBILE_CAMERA', 'EXTERNAL_RTMP', 'YOUTUBE_LIVE') NOT NULL DEFAULT 'MOBILE_CAMERA',
  `status` ENUM('IDLE', 'PREVIEW', 'LIVE', 'PAUSED', 'ENDED', 'ERROR') NOT NULL DEFAULT 'IDLE',
  `stream_key` VARCHAR(128) NULL,
  `ingest_url` VARCHAR(255) NULL,
  `playback_url` VARCHAR(500) NULL,
  `youtube_broadcast_id` VARCHAR(100) NULL,
  `youtube_video_id` VARCHAR(100) NULL,
  `youtube_live_url` VARCHAR(500) NULL,
  `title` VARCHAR(255) NULL,
  `description` TEXT NULL,
  `privacy_status` ENUM('PUBLIC', 'UNLISTED', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
  `overlay_config` JSON NULL,
  `viewer_count` INT NOT NULL DEFAULT 0,
  `peak_viewers` INT NOT NULL DEFAULT 0,
  `actual_start` DATETIME NULL,
  `actual_end` DATETIME NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_streams_match` (`match_id`),
  INDEX `idx_streams_tournament` (`tournament_id`),
  INDEX `idx_streams_status` (`status`),
  INDEX `idx_streams_key` (`stream_key`),
  INDEX `idx_streams_method` (`streaming_method`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Create tournament_stream_permissions table (delegated streamer access)
CREATE TABLE IF NOT EXISTS `tournament_stream_permissions` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `uuid` VARCHAR(64) NOT NULL UNIQUE,
  `tournament_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `match_id` BIGINT NULL,
  `granted_by` INT NOT NULL,
  `scope` ENUM('TOURNAMENT', 'MATCH') NOT NULL DEFAULT 'TOURNAMENT',
  `status` ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
  `expires_at` DATETIME NULL,
  `revoked_at` DATETIME NULL,
  `revoked_by` INT NULL,
  `notes` VARCHAR(255) NULL,
  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_tsp_tournament` (`tournament_id`),
  INDEX `idx_tsp_user` (`user_id`),
  INDEX `idx_tsp_match` (`match_id`),
  INDEX `idx_tsp_status` (`status`),
  INDEX `idx_tsp_scope` (`scope`),
  INDEX `idx_tsp_lookup` (`tournament_id`, `user_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Add additive streaming columns to tournament_matches if not already present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'tournament_matches' 
    AND COLUMN_NAME = 'has_live_stream'
);

SET @stmt = IF(@col_exists = 0, 
  'ALTER TABLE `tournament_matches` ADD COLUMN `has_live_stream` TINYINT(1) NOT NULL DEFAULT 0 AFTER `audit_trail`', 
  'SELECT "Column has_live_stream already exists" AS notice'
);
PREPARE alter_stmt FROM @stmt;
EXECUTE alter_stmt;
DEALLOCATE PREPARE alter_stmt;

SET @col_exists_id = (
  SELECT COUNT(*) FROM information_schema.COLUMNS 
  WHERE TABLE_SCHEMA = DATABASE() 
    AND TABLE_NAME = 'tournament_matches' 
    AND COLUMN_NAME = 'live_stream_id'
);

SET @stmt_id = IF(@col_exists_id = 0, 
  'ALTER TABLE `tournament_matches` ADD COLUMN `live_stream_id` BIGINT NULL AFTER `has_live_stream`', 
  'SELECT "Column live_stream_id already exists" AS notice'
);
PREPARE alter_stmt_id FROM @stmt_id;
EXECUTE alter_stmt_id;
DEALLOCATE PREPARE alter_stmt_id;
