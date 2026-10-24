const db = require('../config/database');
const migrateMatchStreams = require('./migrate_match_streams');
const migrateTournamentStreamPermissions = require('./migrate_tournament_stream_permissions');

async function runStreamingMigrations() {
  console.log('====================================================');
  console.log('🎥 Live Streaming Database Migration (Idempotent)');
  console.log('====================================================');

  try {
    // 1. Run match_streams migration
    await migrateMatchStreams();

    // 2. Run tournament_stream_permissions migration
    await migrateTournamentStreamPermissions();

    console.log('====================================================');
    console.log('✅ ALL STREAMING MIGRATIONS COMPLETED SUCCESSFULLY');
    console.log('====================================================');
    return true;
  } catch (error) {
    console.error('❌ Streaming migration failed:', error.message);
    throw error;
  }
}

if (require.main === module) {
  runStreamingMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = runStreamingMigrations;
