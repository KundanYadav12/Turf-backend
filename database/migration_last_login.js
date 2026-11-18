const db = require('../config/database');

async function run() {
  try {
    const cols = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'users' 
        AND COLUMN_NAME = 'last_login_at'
    `);
    if (!cols || cols.length === 0) {
      await db.query(`ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL`);
      console.log('✓ Added last_login_at column to users table');
    } else {
      console.log('✓ last_login_at column already exists in users table');
    }
    process.exit(0);
  } catch (err) {
    console.error('Migration error:', err.message);
    process.exit(1);
  }
}

run();

