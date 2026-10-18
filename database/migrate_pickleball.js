const db = require('../config/database');

async function migrate() {
  console.log('🔄 Starting Pickleball Database Migration...');

  try {
    // 1. Ensure Pickleball sport exists
    await db.query(`
      INSERT INTO sports (id, name, slug, icon, is_active, sort_order)
      VALUES (6, 'Pickleball', 'pickleball', 'zap', 1, 6)
      ON DUPLICATE KEY UPDATE name = 'Pickleball', is_active = 1, sort_order = 6;
    `);
    console.log('✅ Pickleball sport verified in `sports` table.');

    // 2. Add pickleball columns to `tournaments`
    const tournamentCols = [
      { col: 'match_format', ddl: `ALTER TABLE tournaments ADD COLUMN match_format VARCHAR(20) DEFAULT 'DOUBLES'` },
      { col: 'target_score', ddl: `ALTER TABLE tournaments ADD COLUMN target_score INT DEFAULT 15` },
      { col: 'win_by_two', ddl: `ALTER TABLE tournaments ADD COLUMN win_by_two TINYINT(1) DEFAULT 1` },
      { col: 'max_score', ddl: `ALTER TABLE tournaments ADD COLUMN max_score INT DEFAULT NULL` },
      { col: 'roster_size', ddl: `ALTER TABLE tournaments ADD COLUMN roster_size INT DEFAULT 12` },
      { col: 'groups_count', ddl: `ALTER TABLE tournaments ADD COLUMN groups_count INT DEFAULT 2` }
    ];

    for (const item of tournamentCols) {
      try {
        await db.query(item.ddl);
        console.log(`✅ Added ${item.col} to tournaments.`);
      } catch (e) {
        if (!e.message.includes('Duplicate column') && !e.message.includes('already exists')) {
          console.log(`Notice on tournaments.${item.col}:`, e.message);
        }
      }
    }

    // 3. Add group_name to `tournament_teams`
    try {
      await db.query(`ALTER TABLE tournament_teams ADD COLUMN group_name VARCHAR(50) DEFAULT 'Group 1'`);
      console.log('✅ Added group_name to tournament_teams.');
    } catch (e) {
      if (!e.message.includes('Duplicate column') && !e.message.includes('already exists')) {
        console.log('Notice on tournament_teams.group_name:', e.message);
      }
    }

    // 4. Add columns to `tournament_matches`
    const matchCols = [
      { col: 'group_name', ddl: `ALTER TABLE tournament_matches ADD COLUMN group_name VARCHAR(50) DEFAULT 'Group 1'` },
      { col: 'team_a_score', ddl: `ALTER TABLE tournament_matches ADD COLUMN team_a_score INT DEFAULT 0` },
      { col: 'team_b_score', ddl: `ALTER TABLE tournament_matches ADD COLUMN team_b_score INT DEFAULT 0` },
      { col: 'team_a_lineup', ddl: `ALTER TABLE tournament_matches ADD COLUMN team_a_lineup JSON DEFAULT NULL` },
      { col: 'team_b_lineup', ddl: `ALTER TABLE tournament_matches ADD COLUMN team_b_lineup JSON DEFAULT NULL` }
    ];

    for (const item of matchCols) {
      try {
        await db.query(item.ddl);
        console.log(`✅ Added ${item.col} to tournament_matches.`);
      } catch (e) {
        if (!e.message.includes('Duplicate column') && !e.message.includes('already exists')) {
          console.log(`Notice on tournament_matches.${item.col}:`, e.message);
        }
      }
    }

    // 5. Add columns to `points_table`
    const ptCols = [
      { col: 'group_name', ddl: `ALTER TABLE points_table ADD COLUMN group_name VARCHAR(50) DEFAULT 'Group 1'` },
      { col: 'points_scored', ddl: `ALTER TABLE points_table ADD COLUMN points_scored INT DEFAULT 0` },
      { col: 'points_conceded', ddl: `ALTER TABLE points_table ADD COLUMN points_conceded INT DEFAULT 0` },
      { col: 'point_difference', ddl: `ALTER TABLE points_table ADD COLUMN point_difference INT DEFAULT 0` }
    ];

    for (const item of ptCols) {
      try {
        await db.query(item.ddl);
        console.log(`✅ Added ${item.col} to points_table.`);
      } catch (e) {
        if (!e.message.includes('Duplicate column') && !e.message.includes('already exists')) {
          console.log(`Notice on points_table.${item.col}:`, e.message);
        }
      }
    }

    // 6. Create `pickleball_score_logs` table
    await db.query(`
      CREATE TABLE IF NOT EXISTS pickleball_score_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        match_id BIGINT NOT NULL,
        sequence_number INT NOT NULL,
        point_to VARCHAR(20) NOT NULL,
        team_a_score INT NOT NULL,
        team_b_score INT NOT NULL,
        scorer_id INT DEFAULT NULL,
        event_type VARCHAR(50) DEFAULT 'POINT',
        notes VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_pb_logs_match (match_id, sequence_number)
      ) ENGINE=InnoDB;
    `);
    console.log('✅ Created pickleball_score_logs table.');

    console.log('🎉 Pickleball Database Migration Completed Successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  }
}

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(() => process.exit(1));
}

module.exports = migrate;
