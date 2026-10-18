const db = require('../config/database');

async function migrateMultiSportPlatform() {
  console.log('🚀 Running Multi-Sport Platform Database Migration...');

  // Helper to add column if it does not exist
  const addColumnIfNotExists = async (table, column, definition) => {
    try {
      const cols = await db.query(`SHOW COLUMNS FROM \`${table}\` LIKE '${column}'`);
      if (!cols || cols.length === 0) {
        await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        console.log(`  ✓ Added column ${table}.${column}`);
      } else {
        console.log(`  - Column ${table}.${column} already exists`);
      }
    } catch (err) {
      console.warn(`  ⚠️ Column check/add for ${table}.${column}:`, err.message);
    }
  };

  // 1. Ensure sports table has all required sports active
  console.log('\n[1] Updating Sports Catalog...');
  const defaultSports = [
    { name: 'Cricket', slug: 'cricket', icon: 'trophy', sort_order: 1 },
    { name: 'Football', slug: 'football', icon: 'activity', sort_order: 2 },
    { name: 'Badminton', slug: 'badminton', icon: 'zap', sort_order: 3 },
    { name: 'Pickleball', slug: 'pickleball', icon: 'zap', sort_order: 4 },
    { name: 'Tennis', slug: 'tennis', icon: 'circle', sort_order: 5 },
    { name: 'Table Tennis', slug: 'table-tennis', icon: 'disc', sort_order: 6 },
    { name: 'Volleyball', slug: 'volleyball', icon: 'target', sort_order: 7 },
    { name: 'Basketball', slug: 'basketball', icon: 'dribbble', sort_order: 8 }
  ];

  for (const s of defaultSports) {
    const existing = await db.query('SELECT id FROM sports WHERE slug = ?', [s.slug]);
    if (existing && existing.length > 0) {
      await db.query(
        'UPDATE sports SET is_active = 1, icon = ?, sort_order = ? WHERE slug = ?',
        [s.icon, s.sort_order, s.slug]
      );
      console.log(`  ✓ Sport ${s.name} updated (active)`);
    } else {
      await db.query(
        'INSERT INTO sports (name, slug, icon, is_active, sort_order) VALUES (?, ?, ?, 1, ?)',
        [s.name, s.slug, s.icon, s.sort_order]
      );
      console.log(`  ✓ Sport ${s.name} inserted (active)`);
    }
  }

  // 2. Extend tournaments table
  console.log('\n[2] Extending tournaments table...');
  await addColumnIfNotExists('tournaments', 'tournament_format', "VARCHAR(50) DEFAULT 'ROUND_ROBIN'");
  await addColumnIfNotExists('tournaments', 'playoff_teams_per_group', "INT DEFAULT 2");
  await addColumnIfNotExists('tournaments', 'third_place_playoff', "TINYINT(1) DEFAULT 0");
  await addColumnIfNotExists('tournaments', 'points_config', "JSON DEFAULT NULL");
  await addColumnIfNotExists('tournaments', 'sport_config', "JSON DEFAULT NULL");
  await addColumnIfNotExists('tournaments', 'scheduling_config', "JSON DEFAULT NULL");
  await addColumnIfNotExists('tournaments', 'registration_type', "VARCHAR(20) DEFAULT 'TEAM'");

  // 3. Extend tournament_matches table
  console.log('\n[3] Extending tournament_matches table...');
  await addColumnIfNotExists('tournament_matches', 'stage', "VARCHAR(50) DEFAULT 'GROUP'");
  await addColumnIfNotExists('tournament_matches', 'round_number', "INT DEFAULT 1");
  await addColumnIfNotExists('tournament_matches', 'court_name', "VARCHAR(100) DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'referee_id', "INT DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'player_of_match_id', "INT DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'team_a_score_text', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'team_b_score_text', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'period_state', "VARCHAR(50) DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'match_timer', "JSON DEFAULT NULL");
  await addColumnIfNotExists('tournament_matches', 'audit_trail', "JSON DEFAULT NULL");

  // 4. Extend points_table
  console.log('\n[4] Extending points_table table...');
  await addColumnIfNotExists('points_table', 'drawn', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'goals_for', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'goals_against', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'goal_difference', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'sets_won', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'sets_lost', "INT DEFAULT 0");
  await addColumnIfNotExists('points_table', 'set_ratio', "DECIMAL(6,3) DEFAULT 0.000");
  await addColumnIfNotExists('points_table', 'points_ratio', "DECIMAL(6,3) DEFAULT 0.000");

  // 5. Extend tournament_teams table
  console.log('\n[5] Extending tournament_teams table...');
  await addColumnIfNotExists('tournament_teams', 'registration_type', "VARCHAR(20) DEFAULT 'TEAM'");
  await addColumnIfNotExists('tournament_teams', 'player_1_id', "INT DEFAULT NULL");
  await addColumnIfNotExists('tournament_teams', 'player_2_id', "INT DEFAULT NULL");
  await addColumnIfNotExists('tournament_teams', 'roster_json', "JSON DEFAULT NULL");
  await addColumnIfNotExists('tournament_teams', 'approval_notes', "TEXT DEFAULT NULL");
  await addColumnIfNotExists('tournament_teams', 'paid_amount', "DECIMAL(10,2) DEFAULT 0.00");

  // 6. Create sport_match_events table
  console.log('\n[6] Creating sport_match_events table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS sport_match_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      match_id INT NOT NULL,
      sport_slug VARCHAR(50) NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      period VARCHAR(30) DEFAULT NULL,
      minute INT DEFAULT NULL,
      second INT DEFAULT NULL,
      team_id INT DEFAULT NULL,
      player_id INT DEFAULT NULL,
      assist_player_id INT DEFAULT NULL,
      player_off_id INT DEFAULT NULL,
      player_on_id INT DEFAULT NULL,
      payload JSON DEFAULT NULL,
      commentary VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_match_events (match_id, created_at),
      INDEX idx_sport_events (sport_slug, event_type)
    ) ENGINE=InnoDB;
  `);
  console.log('  ✓ Table sport_match_events ready');

  // 7. Create tournament_awards table
  console.log('\n[7] Creating tournament_awards table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS tournament_awards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT NOT NULL,
      award_key VARCHAR(60) NOT NULL,
      award_name VARCHAR(120) NOT NULL,
      sport_slug VARCHAR(50) NOT NULL,
      recipient_type ENUM('PLAYER', 'TEAM') DEFAULT 'PLAYER',
      recipient_id INT DEFAULT NULL,
      recipient_name VARCHAR(150) NOT NULL,
      team_id INT DEFAULT NULL,
      team_name VARCHAR(150) DEFAULT NULL,
      stat_value VARCHAR(100) DEFAULT NULL,
      calculation_method VARCHAR(255) DEFAULT NULL,
      is_manual_override TINYINT(1) DEFAULT 0,
      override_reason VARCHAR(255) DEFAULT NULL,
      overridden_by INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_tourn_awards (tournament_id, award_key)
    ) ENGINE=InnoDB;
  `);
  console.log('  ✓ Table tournament_awards ready');

  // 8. Create player_sport_profiles table
  console.log('\n[8] Creating player_sport_profiles table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS player_sport_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      sport_slug VARCHAR(50) NOT NULL,
      jersey_number INT DEFAULT NULL,
      primary_position VARCHAR(50) DEFAULT NULL,
      secondary_position VARCHAR(50) DEFAULT NULL,
      dominant_hand_foot VARCHAR(20) DEFAULT NULL,
      matches_played INT DEFAULT 0,
      stats JSON DEFAULT NULL,
      bio TEXT DEFAULT NULL,
      achievements JSON DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_user_sport (user_id, sport_slug),
      INDEX idx_sport_players (sport_slug)
    ) ENGINE=InnoDB;
  `);
  console.log('  ✓ Table player_sport_profiles ready');

  // 9. Create tournament_audit_logs table
  console.log('\n[9] Creating tournament_audit_logs table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS tournament_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id INT DEFAULT NULL,
      match_id INT DEFAULT NULL,
      action_type VARCHAR(60) NOT NULL,
      user_id INT NOT NULL,
      user_role VARCHAR(40) NOT NULL,
      previous_state JSON DEFAULT NULL,
      new_state JSON DEFAULT NULL,
      notes VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_tourn (tournament_id, action_type),
      INDEX idx_audit_match (match_id)
    ) ENGINE=InnoDB;
  `);
  console.log('  ✓ Table tournament_audit_logs ready');

  console.log('\n🎉 Multi-Sport Platform Database Migration Completed Successfully!');
}

if (require.main === module) {
  migrateMultiSportPlatform()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrateMultiSportPlatform;
