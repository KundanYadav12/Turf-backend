const db = require('../config/database');
const { recalculateStandings } = require('../services/tournamentEngineService');

async function main() {
  console.log('🔄 Starting tournament standings backfill...');

  const targetUuidOrId = process.argv[2];
  let tournaments;

  if (targetUuidOrId) {
    tournaments = await db.query(
      'SELECT id, uuid, name, status FROM tournaments WHERE uuid = ? OR id = ?',
      [targetUuidOrId, targetUuidOrId]
    );
  } else {
    tournaments = await db.query(
      'SELECT id, uuid, name, status FROM tournaments ORDER BY id DESC'
    );
  }

  console.log(`Found ${tournaments.length} tournament(s) to process.\n`);

  for (const t of tournaments) {
    try {
      console.log(`▶ Processing tournament #${t.id} [${t.uuid}] "${t.name}" (Status: ${t.status})...`);
      await recalculateStandings(t.id, { force: true });
      console.log(`  ✅ Done for #${t.id}\n`);
    } catch (err) {
      console.error(`  ❌ Failed for #${t.id}:`, err.message);
    }
  }

  console.log('🏁 Standings backfill completed.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error in backfill:', err);
  process.exit(1);
});
