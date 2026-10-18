const db = require('../config/database');

async function migrateMultiTenantTeams() {
  console.log('🚀 Running Multi-Tenant Team Data Isolation Migration...');

  // 1. Ensure Owner 2 has a venue
  const owner2Venues = await db.query('SELECT id FROM venues WHERE owner_id = 4');
  let owner2VenueId;
  if (!owner2Venues || owner2Venues.length === 0) {
    const res = await db.query(`
      INSERT INTO venues (owner_id, name, slug, address, city, state, pincode, status)
      VALUES (4, 'Pune Sports Arena', 'pune-sports-arena', 'Baner Road, Near High Street', 'Pune', 'Maharashtra', '411045', 'APPROVED')
    `);
    owner2VenueId = res.insertId;
    console.log('✅ Created Pune Sports Arena for Owner 2 (id: 4), Venue ID:', owner2VenueId);
  } else {
    owner2VenueId = owner2Venues[0].id;
  }

  // 2. Add owner_id, venue_id, sport_id columns to teams table if not present
  const descTeams = await db.query('DESCRIBE teams');
  const cols = descTeams.map(c => c.Field);

  if (!cols.includes('owner_id')) {
    await db.query(`ALTER TABLE teams ADD COLUMN owner_id INT DEFAULT NULL AFTER captain_id`);
    console.log('✅ Added owner_id column to teams table');
  }

  if (!cols.includes('venue_id')) {
    await db.query(`ALTER TABLE teams ADD COLUMN venue_id INT DEFAULT NULL AFTER owner_id`);
    console.log('✅ Added venue_id column to teams table');
  }

  if (!cols.includes('sport_id')) {
    await db.query(`ALTER TABLE teams ADD COLUMN sport_id INT NOT NULL DEFAULT 1 AFTER venue_id`);
    console.log('✅ Added sport_id column to teams table');
  }

  // 3. Setup Indexes & Foreign Keys
  try {
    await db.query(`CREATE INDEX idx_teams_owner_tenant ON teams(owner_id)`);
  } catch (e) { /* index may already exist */ }
  try {
    await db.query(`CREATE INDEX idx_teams_venue_tenant ON teams(venue_id)`);
  } catch (e) { /* index may already exist */ }

  // 4. Update existing teams:
  // Owner 1 (id: 2, owner@turf.com) gets Teams 1 to 8 (affiliated with Venue 1)
  await db.query(`UPDATE teams SET owner_id = 2, venue_id = 1 WHERE id IN (1, 2, 3, 4, 5, 6, 7, 8, 12)`);

  // Owner 2 (id: 4, owner2@turf.com) gets Teams 9, 10, 11 (affiliated with Venue 2 or Pune Arena)
  await db.query(`UPDATE teams SET owner_id = 4, venue_id = ? WHERE id IN (9, 10, 11)`, [owner2VenueId]);

  // 5. Ensure specific test teams for Owner A and Owner B as required by prompt Section 16
  // Check if A-Team-1 exists
  const [aTeam1] = await db.query(`SELECT id FROM teams WHERE name = 'A-Team-1'`);
  if (!aTeam1) {
    await db.query(`
      INSERT INTO teams (uuid, name, logo_url, captain_id, owner_id, venue_id, sport_id, description, status)
      VALUES (UUID(), 'A-Team-1', 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=200&q=80', 3, 2, 1, 1, 'Owner A Flagship Squad 1', 'ACTIVE')
    `);
  }
  const [aTeam2] = await db.query(`SELECT id FROM teams WHERE name = 'A-Team-2'`);
  if (!aTeam2) {
    await db.query(`
      INSERT INTO teams (uuid, name, logo_url, captain_id, owner_id, venue_id, sport_id, description, status)
      VALUES (UUID(), 'A-Team-2', 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?auto=format&fit=crop&w=200&q=80', 3, 2, 1, 1, 'Owner A Flagship Squad 2', 'ACTIVE')
    `);
  }

  // Check if B-Team-1 exists
  const [bTeam1] = await db.query(`SELECT id FROM teams WHERE name = 'B-Team-1'`);
  if (!bTeam1) {
    await db.query(`
      INSERT INTO teams (uuid, name, logo_url, captain_id, owner_id, venue_id, sport_id, description, status)
      VALUES (UUID(), 'B-Team-1', 'https://images.unsplash.com/photo-1512716676840-92882356da39?auto=format&fit=crop&w=200&q=80', 4, 4, ?, 1, 'Owner B Flagship Squad 1', 'ACTIVE')
    `, [owner2VenueId]);
  }
  const [bTeam2] = await db.query(`SELECT id FROM teams WHERE name = 'B-Team-2'`);
  if (!bTeam2) {
    await db.query(`
      INSERT INTO teams (uuid, name, logo_url, captain_id, owner_id, venue_id, sport_id, description, status)
      VALUES (UUID(), 'B-Team-2', 'https://images.unsplash.com/photo-1589487391730-58f20eb2c308?auto=format&fit=crop&w=200&q=80', 4, 4, ?, 1, 'Owner B Flagship Squad 2', 'ACTIVE')
    `, [owner2VenueId]);
  }

  // 6. Verify isolation
  const ownerATeams = await db.query(`SELECT id, uuid, name, owner_id, venue_id FROM teams WHERE owner_id = 2`);
  const ownerBTeams = await db.query(`SELECT id, uuid, name, owner_id, venue_id FROM teams WHERE owner_id = 4`);

  console.log('✅ Owner A (id: 2) Teams Count:', ownerATeams.length);
  console.log('✅ Owner B (id: 4) Teams Count:', ownerBTeams.length);
  console.log('🎉 Multi-Tenant Migration Finished Successfully!');
  process.exit(0);
}

migrateMultiTenantTeams().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
