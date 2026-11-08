const db = require('../config/database');

async function addIndexIfNotExists(table, indexName, columns) {
  try {
    const [existing] = await db.query(
      `SELECT COUNT(1) as count 
       FROM INFORMATION_SCHEMA.STATISTICS 
       WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = ? 
         AND INDEX_NAME = ?`,
      [table, indexName]
    );

    if (existing && existing.count > 0) {
      console.log(`[INFO] Index ${indexName} on ${table} already exists.`);
      return;
    }

    console.log(`[ADDING] Index ${indexName} on ${table} (${columns})...`);
    await db.query(`ALTER TABLE \`${table}\` ADD INDEX \`${indexName}\` (${columns})`);
    console.log(`[SUCCESS] Added index ${indexName} on ${table}`);
  } catch (err) {
    if (err.message && err.message.includes('Duplicate key name')) {
      console.log(`[INFO] Index ${indexName} on ${table} already exists.`);
    } else {
      console.warn(`[WARN] Could not add index ${indexName} on ${table}:`, err.message);
    }
  }
}

async function run() {
  console.log('--- Starting Performance Index Migration ---');

  // cricket_balls
  await addIndexIfNotExists('cricket_balls', 'idx_cb_striker', '`striker_id`');
  await addIndexIfNotExists('cricket_balls', 'idx_cb_bowler', '`bowler_id`');
  await addIndexIfNotExists('cricket_balls', 'idx_cb_dismissed', '`dismissed_player_id`');
  await addIndexIfNotExists('cricket_balls', 'idx_cb_match_striker', '`match_id`, `striker_id`');

  // sport_match_events
  await addIndexIfNotExists('sport_match_events', 'idx_sme_player', '`player_id`');
  await addIndexIfNotExists('sport_match_events', 'idx_sme_assist', '`assist_player_id`');
  await addIndexIfNotExists('sport_match_events', 'idx_sme_sport_player', '`sport_slug`, `player_id`');

  // team_members
  await addIndexIfNotExists('team_members', 'idx_tm_user_captain', '`user_id`, `is_captain`');
  await addIndexIfNotExists('team_members', 'idx_tm_team_user', '`team_id`, `user_id`');

  // tournament_matches
  await addIndexIfNotExists('tournament_matches', 'idx_tm_status_tourn', '`status`, `tournament_id`');
  await addIndexIfNotExists('tournament_matches', 'idx_tm_scorer', '`scorer_id`');

  // bookings
  await addIndexIfNotExists('bookings', 'idx_bk_user_date', '`user_id`, `booking_date`');
  await addIndexIfNotExists('bookings', 'idx_bk_venue_status', '`venue_id`, `status`');

  // tournament_awards
  await addIndexIfNotExists('tournament_awards', 'idx_ta_recipient', '`recipient_id`, `recipient_type`');

  console.log('--- Performance Index Migration Completed ---');
  process.exit(0);
}

run().catch((err) => {
  console.error('[ERROR] Performance Index Migration failed:', err);
  process.exit(1);
});

