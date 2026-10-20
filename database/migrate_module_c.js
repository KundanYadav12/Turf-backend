const db = require('../config/database');

async function migrateModuleC() {
  console.log('Running Module C migration...');
  try {
    // Add deleted_at column to team_members if not exists
    const cols = await db.query('DESCRIBE team_members');
    const hasDeletedAt = cols.some(c => c.Field === 'deleted_at');
    if (!hasDeletedAt) {
      await db.query('ALTER TABLE team_members ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER is_vice_captain');
      console.log('Added deleted_at column to team_members.');
    } else {
      console.log('deleted_at column already exists on team_members.');
    }
    console.log('Module C migration completed successfully.');
    process.exit(0);
  } catch (err) {
    console.error('Module C migration error:', err);
    process.exit(1);
  }
}

migrateModuleC();
