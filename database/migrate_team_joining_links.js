const db = require('../config/database');
const crypto = require('crypto');

async function migrateTeamJoiningLinks() {
  console.log('--- Migrating Team Joining Links Schema ---');
  try {
    // 1. Check if invite_code column exists on teams
    const teamCols = await db.query('DESCRIBE teams');
    const hasInviteCode = teamCols.some((c) => c.Field === 'invite_code');

    if (!hasInviteCode) {
      console.log('Adding invite_code column to teams table...');
      await db.query(`
        ALTER TABLE teams 
        ADD COLUMN invite_code VARCHAR(64) NULL UNIQUE AFTER status
      `);
      console.log('Added invite_code column successfully.');
    } else {
      console.log('invite_code column already exists on teams table.');
    }

    // 2. Populate invite_code for any existing teams without one
    const teamsWithoutCode = await db.query('SELECT id, uuid FROM teams WHERE invite_code IS NULL OR invite_code = ""');
    console.log(`Found ${teamsWithoutCode.length} teams without an invite code. Generating unique codes...`);

    for (const team of teamsWithoutCode) {
      const code = crypto.randomBytes(8).toString('hex'); // 16 alphanumeric characters
      await db.query('UPDATE teams SET invite_code = ? WHERE id = ?', [code, team.id]);
    }

    console.log('--- Team Joining Links Migration Completed Successfully ---');
  } catch (err) {
    console.error('Error during migrateTeamJoiningLinks:', err);
    throw err;
  }
}

if (require.main === module) {
  migrateTeamJoiningLinks()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrateTeamJoiningLinks;
