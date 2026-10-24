const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Live Match Streaming Migration (match_streams)...');

  try {
    // 1. Create match_streams table
    await db.query(`
      CREATE TABLE IF NOT EXISTS match_streams (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(64) NOT NULL UNIQUE,
        match_id BIGINT NOT NULL,
        tournament_id BIGINT NULL,
        user_id INT NOT NULL,
        streaming_method ENUM('MOBILE_CAMERA', 'EXTERNAL_RTMP', 'YOUTUBE_LIVE') NOT NULL DEFAULT 'MOBILE_CAMERA',
        status ENUM('IDLE', 'PREVIEW', 'LIVE', 'PAUSED', 'ENDED', 'ERROR') NOT NULL DEFAULT 'IDLE',
        stream_key VARCHAR(128) NULL,
        ingest_url VARCHAR(255) NULL,
        playback_url VARCHAR(500) NULL,
        youtube_broadcast_id VARCHAR(100) NULL,
        youtube_video_id VARCHAR(100) NULL,
        youtube_live_url VARCHAR(500) NULL,
        title VARCHAR(255) NULL,
        description TEXT NULL,
        privacy_status ENUM('PUBLIC', 'UNLISTED', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
        overlay_config JSON NULL,
        viewer_count INT NOT NULL DEFAULT 0,
        peak_viewers INT NOT NULL DEFAULT 0,
        actual_start DATETIME NULL,
        actual_end DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_streams_match (match_id),
        INDEX idx_streams_tournament (tournament_id),
        INDEX idx_streams_status (status),
        INDEX idx_streams_key (stream_key),
        INDEX idx_streams_method (streaming_method)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ match_streams table verified/created.');

    // 2. Check if tournament_matches has live_stream_id or stream_status columns (optional additive enhancement)
    const tmCols = await db.query('DESCRIBE tournament_matches');
    const colNames = tmCols.map(c => c.Field);

    if (!colNames.includes('has_live_stream')) {
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN has_live_stream TINYINT(1) NOT NULL DEFAULT 0,
        ADD COLUMN live_stream_id BIGINT NULL
      `);
      console.log('✅ Added has_live_stream and live_stream_id columns to tournament_matches.');
    } else {
      console.log('ℹ️ tournament_matches already has live streaming columns.');
    }

    console.log('🎉 Live Match Streaming Migration Completed Successfully!');
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
