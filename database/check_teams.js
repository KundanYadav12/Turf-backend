const db = require('../config/database');

async function check() {
  const fks = await db.query(`
    SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME 
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE 
    WHERE TABLE_SCHEMA = 'turf_sports_db' AND (REFERENCED_TABLE_NAME = 'teams' OR TABLE_NAME = 'teams')
  `);
  console.log('FKS:', fks);

  const descTeams = await db.query('DESCRIBE teams');
  console.log('DESC TEAMS:', descTeams);

  const descTeamMembers = await db.query('DESCRIBE team_members');
  console.log('DESC TEAM MEMBERS:', descTeamMembers);

  const descVenues = await db.query('DESCRIBE venues');
  console.log('DESC VENUES:', descVenues);

  const users = await db.query('SELECT u.id, u.email, u.full_name, r.name as role FROM users u JOIN user_roles ur ON u.id = ur.user_id JOIN roles r ON ur.role_id = r.id');
  console.log('USERS:', users);

  const venues = await db.query('SELECT v.id, v.owner_id, v.name, u.email as owner_email FROM venues v JOIN users u ON v.owner_id = u.id');
  console.log('VENUES:', venues);

  process.exit(0);
}

check();
