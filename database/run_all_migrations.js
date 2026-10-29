const { execSync } = require('child_process');
const path = require('path');

const migrations = [
  'migrate_module_b_player_registrations.js',
  'migrate_module_c.js',
  'migrate_module_d_and_j.js',
  'migrate_module_e_and_h.js',
  'migrate_module_f.js',
  'migrate_module_g.js',
  'migrate_module_i.js',
  'migrate_module_j.js',
  'migrate_tournament_analytics.js',
  'migrate_match_streams.js',
  'migrate_tournament_stream_permissions.js',
  'migrate_multi_live_matches.js',
  'migrate_team_joining_links.js',
  'migrate_standings_frozen_columns.js',
  'seed_superadmin.js'
];

console.log('🚀 Starting Turf Database Migration Runner...');

let hasError = false;
for (const file of migrations) {
  console.log(`\n--------------------------------------------------`);
  console.log(`▶ Executing: database/${file}`);
  console.log(`--------------------------------------------------`);
  try {
    const filePath = path.join(__dirname, file);
    execSync(`node "${filePath}"`, { stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Error executing ${file}:`, err.message);
    hasError = true;
  }
}

if (hasError) {
  console.error('\n⚠️ Some migrations encountered errors. Please check the logs above.');
  process.exit(1);
} else {
  console.log('\n🎉 ALL DATABASE MIGRATIONS COMPLETED SUCCESSFULLY!');
  process.exit(0);
}
