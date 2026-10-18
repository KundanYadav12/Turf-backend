const db = require('../config/database');

async function migrate() {
  console.log('--- Migrating Cricket Live Scorer Tables ---');

  try {
    // 1. Update tournament_matches status enum to include READY and INNINGS_BREAK
    await db.query(`
      ALTER TABLE tournament_matches 
      MODIFY COLUMN status ENUM('SCHEDULED','READY','LIVE','INNINGS_BREAK','PAUSED','COMPLETED','CANCELLED','ABANDONED') 
      DEFAULT 'SCHEDULED'
    `);
    console.log('✓ Updated tournament_matches status ENUM');

    // 2. Ensure roles table has SCORER
    await db.query(`
      INSERT IGNORE INTO roles (id, name, description) 
      VALUES (5, 'SCORER', 'Official match scorer with scoring privileges')
      ON DUPLICATE KEY UPDATE name = 'SCORER'
    `);
    console.log('✓ Ensured SCORER role exists in roles table');

    // 3. Add match_id and innings_id to cricket_balls if not present
    const ballCols = await db.query('DESCRIBE cricket_balls');
    const ballColNames = ballCols.map(c => c.Field);
    
    if (!ballColNames.includes('match_id')) {
      await db.query('ALTER TABLE cricket_balls ADD COLUMN match_id INT AFTER id, ADD INDEX idx_cricket_balls_match (match_id)');
      console.log('✓ Added match_id column to cricket_balls');
    }
    if (!ballColNames.includes('innings_id')) {
      await db.query('ALTER TABLE cricket_balls ADD COLUMN innings_id INT AFTER match_id, ADD INDEX idx_cricket_balls_innings (innings_id)');
      console.log('✓ Added innings_id column to cricket_balls');
    }
    if (!ballColNames.includes('commentary')) {
      await db.query('ALTER TABLE cricket_balls ADD COLUMN commentary VARCHAR(255) AFTER extra_runs');
      console.log('✓ Added commentary column to cricket_balls');
    }

    // 4. Ensure cricket_matches has striker, non_striker, bowler, and state tracking
    const cmCols = await db.query('DESCRIBE cricket_matches');
    const cmColNames = cmCols.map(c => c.Field);
    if (!cmColNames.includes('striker_id')) {
      await db.query('ALTER TABLE cricket_matches ADD COLUMN striker_id INT, ADD COLUMN non_striker_id INT, ADD COLUMN current_bowler_id INT');
      console.log('✓ Added active players tracking columns to cricket_matches');
    }

    // 5. Seed sample players for teams if a team has fewer than 5 members
    const teams = await db.query('SELECT id, name FROM teams LIMIT 10');
    for (const t of teams) {
      const [countRow] = await db.query('SELECT COUNT(*) as count FROM team_members WHERE team_id = ?', [t.id]);
      if (countRow.count < 5) {
        console.log(`Seeding players for team ${t.name} (id: ${t.id})...`);
        const sampleNames = [
          'Rohit Sharma', 'Virat Kohli', 'KL Rahul', 'Suryakumar Yadav',
          'Hardik Pandya', 'Rishabh Pant', 'Ravindra Jadeja', 'Jasprit Bumrah',
          'Mohammed Shami', 'Kuldeep Yadav', 'Arshdeep Singh'
        ];

        for (let i = 0; i < sampleNames.length; i++) {
          const playerName = `${sampleNames[i]} (${t.name.substring(0, 3)})`;
          const email = `player_${t.id}_${i}@turf.com`;
          
          // Check or create user
          const existing = await db.query('SELECT id FROM users WHERE email = ?', [email]);
          let userId;
          if (existing.length === 0) {
            const insUser = await db.query(
              `INSERT INTO users (full_name, email, password_hash, status) 
               VALUES (?, ?, '$2b$10$w8.3fJ5928KND0PskjH30uFwJ29v4nU3lR7mX7aJ0wW1qZ9k6s6u', 'ACTIVE')`,
              [playerName, email]
            );
            userId = insUser.insertId;
          } else {
            userId = existing[0].id;
          }

          // Insert into team_members if not present
          const existingMem = await db.query('SELECT id FROM team_members WHERE team_id = ? AND user_id = ?', [t.id, userId]);
          if (existingMem.length === 0) {
            await db.query(
              `INSERT INTO team_members (team_id, user_id, role, jersey_number) 
               VALUES (?, ?, ?, ?)`,
              [t.id, userId, i === 0 ? 'CAPTAIN' : i === 1 ? 'VICE_CAPTAIN' : 'PLAYER', (i + 1) * 7 % 99 + 1]
            );
          }
        }
      }
    }
    console.log('✓ Verified team players & rosters');

    // 6. Seed sample advertisements for digital signage
    const ads = await db.query('SELECT id FROM advertisements LIMIT 1');
    if (ads.length === 0) {
      const topAd = await db.query(`
        INSERT INTO advertisements (name, image_url, position, scroll_direction, scroll_speed, priority, status)
        VALUES ('Apex Sports Arena Sponsor', 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?w=1200&h=120&fit=crop', 'TOP', 'LEFT_TO_RIGHT', 30, 10, 'ACTIVE')
      `);
      const bottomAd = await db.query(`
        INSERT INTO advertisements (name, image_url, position, scroll_direction, scroll_speed, priority, status)
        VALUES ('Energy Drink Partner', 'https://images.unsplash.com/photo-1517649763962-0c623266ddc0?w=1200&h=80&fit=crop', 'BOTTOM', 'LEFT_TO_RIGHT', 40, 10, 'ACTIVE')
      `);
      console.log('✓ Seeded stadium top and bottom advertisements');
    }

    console.log('\n--- Migration Completed Successfully ---');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
