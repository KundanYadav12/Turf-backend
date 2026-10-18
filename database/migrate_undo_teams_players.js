const db = require('../config/database');

async function migrateUndoTeamsPlayers() {
  console.log('🚀 Running Universal Undo, Teams & Comprehensive Player Details Migration...');

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

  // 1. Users table enhancements
  console.log('\n[1] Extending users table for comprehensive player profile...');
  await addColumnIfNotExists('users', 'dob', "DATE NULL");
  await addColumnIfNotExists('users', 'gender', "VARCHAR(20) NULL");
  await addColumnIfNotExists('users', 'city', "VARCHAR(100) NULL");
  await addColumnIfNotExists('users', 'state', "VARCHAR(100) NULL");
  await addColumnIfNotExists('users', 'country', "VARCHAR(100) DEFAULT 'India'");
  await addColumnIfNotExists('users', 'address', "TEXT NULL");
  await addColumnIfNotExists('users', 'postal_code', "VARCHAR(20) NULL");
  await addColumnIfNotExists('users', 'emergency_contact_name', "VARCHAR(100) NULL");
  await addColumnIfNotExists('users', 'emergency_contact_phone', "VARCHAR(30) NULL");
  await addColumnIfNotExists('users', 'primary_sport_slug', "VARCHAR(50) DEFAULT 'cricket'");
  await addColumnIfNotExists('users', 'batting_style', "VARCHAR(50) NULL");
  await addColumnIfNotExists('users', 'bowling_style', "VARCHAR(50) NULL");
  await addColumnIfNotExists('users', 'preferred_hand_foot', "VARCHAR(50) NULL");
  await addColumnIfNotExists('users', 'experience_level', "VARCHAR(50) DEFAULT 'Club'");
  await addColumnIfNotExists('users', 'skill_category', "VARCHAR(50) DEFAULT 'Amateur'");
  await addColumnIfNotExists('users', 'jersey_number', "INT NULL");
  await addColumnIfNotExists('users', 'primary_position', "VARCHAR(50) NULL");

  // 2. Teams table enhancements
  console.log('\n[2] Extending teams table...');
  await addColumnIfNotExists('teams', 'coach_name', "VARCHAR(100) NULL");
  await addColumnIfNotExists('teams', 'contact_phone', "VARCHAR(30) NULL");
  await addColumnIfNotExists('teams', 'home_location', "VARCHAR(150) NULL");
  await addColumnIfNotExists('teams', 'division', "VARCHAR(50) DEFAULT 'Open'");
  await addColumnIfNotExists('teams', 'tournament_id', "INT NULL");

  // 3. Team Members table enhancements
  console.log('\n[3] Extending team_members table...');
  await addColumnIfNotExists('team_members', 'position', "VARCHAR(50) NULL");
  await addColumnIfNotExists('team_members', 'is_captain', "TINYINT(1) DEFAULT 0");
  await addColumnIfNotExists('team_members', 'is_vice_captain', "TINYINT(1) DEFAULT 0");

  // 4. Scoring Undo Audit Table
  console.log('\n[4] Creating scoring_undo_audit table...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS scoring_undo_audit (
      id INT AUTO_INCREMENT PRIMARY KEY,
      match_id INT NOT NULL,
      sport_slug VARCHAR(50) NOT NULL,
      undone_event_type VARCHAR(100) NOT NULL,
      event_description VARCHAR(255) NULL,
      previous_state JSON NULL,
      restored_state JSON NULL,
      performed_by_id INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sua_match (match_id),
      INDEX idx_sua_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('  ✓ Table scoring_undo_audit verified.');

  console.log('\n🎉 Universal Undo, Teams & Player Migration Completed Successfully!\n');
}

if (require.main === module) {
  migrateUndoTeamsPlayers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrateUndoTeamsPlayers;
