const db = require('../config/database');

function normalizeUsernameBase(name, email, id) {
  if (!name && email) {
    name = email.split('@')[0];
  }
  let base = (name || `user_${id}`)
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, '') // remove (Kun), (Mum), (Owner) etc
    .trim()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (base.length < 3) {
    base = `user_${base || id}`;
  }
  return base.slice(0, 40);
}

async function runMigration() {
  console.log('====================================================');
  console.log('🚀 Running User Profiles, Usernames & Mentions Migration');
  console.log('====================================================');

  try {
    // 1. Add username to users table if not exists
    const userColumns = await db.query('DESCRIBE users');
    const hasUsername = userColumns.some(c => c.Field === 'username');
    if (!hasUsername) {
      console.log('➕ Adding username column to users table...');
      await db.query(`ALTER TABLE users ADD COLUMN username VARCHAR(60) NULL AFTER full_name`);
      await db.query(`ALTER TABLE users ADD UNIQUE INDEX idx_users_username_unique (username)`);
    } else {
      console.log('ℹ️ username column already exists on users table');
    }

    // 2. Populate usernames for users that have NULL username
    const usersWithoutUsername = await db.query('SELECT id, full_name, email, username FROM users WHERE username IS NULL OR username = ""');
    console.log(`🔍 Found ${usersWithoutUsername.length} users needing usernames...`);

    const existingUsernames = new Set(
      (await db.query('SELECT username FROM users WHERE username IS NOT NULL AND username != ""'))
        .map(u => u.username.toLowerCase())
    );

    // Reserved/special names mapping
    const specificAssignments = {
      1: 'admin',
      2: 'owner_rajesh',
      3: 'kundan_player',
      4: 'owner_two'
    };

    for (const u of usersWithoutUsername) {
      let desired = specificAssignments[u.id];
      if (!desired) {
        desired = normalizeUsernameBase(u.full_name, u.email, u.id);
      }

      let candidate = desired;
      let counter = 1;
      while (existingUsernames.has(candidate.toLowerCase())) {
        candidate = `${desired}_${counter}`;
        counter++;
      }

      existingUsernames.add(candidate.toLowerCase());
      await db.query('UPDATE users SET username = ? WHERE id = ?', [candidate, u.id]);
      console.log(`   Assigned username @${candidate} to user #${u.id} (${u.full_name})`);
    }

    // 3. Add photo_url to team_members if not exists
    const teamMemberCols = await db.query('DESCRIBE team_members');
    const hasPhoto = teamMemberCols.some(c => c.Field === 'photo_url');
    if (!hasPhoto) {
      console.log('➕ Adding photo_url column to team_members...');
      await db.query(`ALTER TABLE team_members ADD COLUMN photo_url VARCHAR(255) DEFAULT NULL AFTER position`);
    }

    // 4. Create match_mentions table
    console.log('➕ Creating match_mentions table if not exists...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS match_mentions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        match_id BIGINT NOT NULL,
        event_id BIGINT DEFAULT NULL,
        author_id INT DEFAULT NULL,
        mentioned_user_id INT NOT NULL,
        commentary_text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_mentions_user (mentioned_user_id),
        INDEX idx_mentions_match (match_id)
      ) ENGINE=InnoDB;
    `);

    // 5. Add metadata and action_url to notifications table
    const notificationCols = await db.query('DESCRIBE notifications');
    const hasMetadata = notificationCols.some(c => c.Field === 'metadata');
    if (!hasMetadata) {
      console.log('➕ Adding metadata JSON column to notifications...');
      await db.query(`ALTER TABLE notifications ADD COLUMN metadata JSON DEFAULT NULL`);
    }
    const hasActionUrl = notificationCols.some(c => c.Field === 'action_url');
    if (!hasActionUrl) {
      console.log('➕ Adding action_url column to notifications...');
      await db.query(`ALTER TABLE notifications ADD COLUMN action_url VARCHAR(255) DEFAULT NULL`);
    }

    console.log('====================================================');
    console.log('✅ Migration Finished Successfully!');
    console.log('====================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

runMigration();
