const db = require('../config/database');

async function migrateModuleJ() {
  console.log('--- Migrating MODULE J: Fixture Categories, Standings Filter & Bracket Advancement ---');

  try {
    const columns = await db.query('DESCRIBE tournament_matches');
    const existingColNames = columns.map(c => c.Field.toLowerCase());

    // 1. counts_in_standings (TINYINT(1) DEFAULT 1)
    if (!existingColNames.includes('counts_in_standings')) {
      console.log('Adding counts_in_standings column to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN counts_in_standings TINYINT(1) NOT NULL DEFAULT 1 
        AFTER category
      `);
      console.log('✅ counts_in_standings column added.');
    } else {
      console.log('ℹ️ counts_in_standings column already exists.');
    }

    // 2. next_match_id (INT NULL)
    if (!existingColNames.includes('next_match_id')) {
      console.log('Adding next_match_id column to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN next_match_id INT NULL 
        AFTER counts_in_standings
      `);
      console.log('✅ next_match_id column added.');
    } else {
      console.log('ℹ️ next_match_id column already exists.');
    }

    // 3. bracket_slot (VARCHAR(50) NULL)
    if (!existingColNames.includes('bracket_slot')) {
      console.log('Adding bracket_slot column to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN bracket_slot VARCHAR(50) NULL 
        AFTER next_match_id
      `);
      console.log('✅ bracket_slot column added.');
    } else {
      console.log('ℹ️ bracket_slot column already exists.');
    }

    // 4. bracket_target_team (ENUM('TEAM_A', 'TEAM_B') NULL)
    if (!existingColNames.includes('bracket_target_team')) {
      console.log('Adding bracket_target_team column to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN bracket_target_team ENUM('TEAM_A', 'TEAM_B') NULL 
        AFTER bracket_slot
      `);
      console.log('✅ bracket_target_team column added.');
    } else {
      console.log('ℹ️ bracket_target_team column already exists.');
    }

    // 4b. Allow team_a_id and team_b_id to be NULL (for bracket placeholders before previous rounds finish)
    console.log('Modifying team_a_id and team_b_id to allow NULL for bracket placeholders...');
    await db.query(`ALTER TABLE tournament_matches MODIFY COLUMN team_a_id INT NULL`);
    await db.query(`ALTER TABLE tournament_matches MODIFY COLUMN team_b_id INT NULL`);
    console.log('✅ team_a_id and team_b_id nullability updated.');

    // 5. Backfill: Existing fixtures with NULL or empty category set to 'League'
    await db.query(`
      UPDATE tournament_matches 
      SET category = 'League' 
      WHERE category IS NULL OR category = ''
    `);

    // Ensure non-league matches have counts_in_standings = 0 by default
    await db.query(`
      UPDATE tournament_matches 
      SET counts_in_standings = 0 
      WHERE category IN ('Knockout', 'Quarter-Final', 'Semi-Final', 'Final') 
        AND counts_in_standings = 1
    `);

    console.log('✅ Module J Migration Completed Cleanly.');
  } catch (err) {
    console.error('❌ Migration Error:', err);
    throw err;
  }
}

if (require.main === module) {
  migrateModuleJ().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = migrateModuleJ;
