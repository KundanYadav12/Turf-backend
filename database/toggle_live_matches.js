const db = require('../config/database');

async function setLiveCount(count) {
  const num = parseInt(count, 10) || 1;
  console.log(`Setting ${num} live match(es) for Tournament 2...`);

  const tUuid = 'ed354683-3ee4-4620-adfc-53680b9d3f15';
  const [t] = await db.query('SELECT id FROM tournaments WHERE uuid = ?', [tUuid]);
  if (!t) return;

  const matches = await db.query(
    'SELECT id, match_number FROM tournament_matches WHERE tournament_id = ? ORDER BY match_number ASC',
    [t.id]
  );

  for (let i = 0; i < matches.length; i++) {
    const status = i < num ? 'LIVE' : 'SCHEDULED';
    await db.query('UPDATE tournament_matches SET status = ? WHERE id = ?', [status, matches[i].id]);
    console.log(`Match #${matches[i].match_number} -> ${status}`);
  }
}

const countArg = process.argv[2] || '1';
setLiveCount(countArg).then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
