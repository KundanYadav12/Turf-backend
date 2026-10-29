const db = require('../config/database');

async function migrateMultiLiveMatches() {
  console.log('\n=============================================================');
  console.log('🚀 Running Multi-Live Matches Optimization & Schema Migration');
  console.log('=============================================================');

  try {
    // 1. Inspect existing indexes on tournament_matches
    const indexes = await db.query('SHOW INDEX FROM tournament_matches');
    const existingIndexNames = new Set(indexes.map(i => i.Key_name));

    // 2. Drop any accidental unique index that might restrict multiple live matches
    for (const idx of indexes) {
      if (idx.Non_unique === 0 && idx.Key_name !== 'PRIMARY' && idx.Key_name !== 'uuid') {
        const col = idx.Column_name;
        if (col === 'status' || col === 'tournament_id') {
          console.warn(`⚠️ Dropping restrictive unique index ${idx.Key_name}...`);
          try {
            await db.query(`ALTER TABLE tournament_matches DROP INDEX \`${idx.Key_name}\``);
            console.log(`✅ Dropped restrictive unique index ${idx.Key_name}`);
          } catch (e) {
            console.warn(`Could not drop index ${idx.Key_name}:`, e.message);
          }
        }
      }
    }

    // 3. Ensure non-unique performance indexes for simultaneous live matches
    if (!existingIndexNames.has('idx_matches_status')) {
      console.log('➕ Creating index idx_matches_status (status)...');
      try {
        await db.query('CREATE INDEX idx_matches_status ON tournament_matches (status)');
        console.log('✅ Created idx_matches_status index.');
      } catch (err) {
        console.warn('Index note (or exists):', err.message);
      }
    } else {
      console.log('ℹ️ Index idx_matches_status already exists.');
    }

    if (!existingIndexNames.has('idx_matches_live_lookup')) {
      console.log('➕ Creating index idx_matches_live_lookup (status, updated_at)...');
      try {
        await db.query('CREATE INDEX idx_matches_live_lookup ON tournament_matches (status, updated_at)');
        console.log('✅ Created idx_matches_live_lookup index.');
      } catch (err) {
        console.warn('Index note (or exists):', err.message);
      }
    } else {
      console.log('ℹ️ Index idx_matches_live_lookup already exists.');
    }

    // 4. Ensure status enum contains all required states
    try {
      await db.query(`
        ALTER TABLE tournament_matches 
        MODIFY COLUMN status ENUM('SCHEDULED','READY','LIVE','INNINGS_BREAK','PAUSED','COMPLETED','CANCELLED','ABANDONED') 
        DEFAULT 'SCHEDULED'
      `);
      console.log('✅ Status ENUM verified with full support for LIVE and concurrent match lifecycles.');
    } catch (enumErr) {
      console.warn('Status ENUM check notice:', enumErr.message);
    }

    // 5. Ensure show_on_display has default 1
    const cols = await db.query('DESCRIBE tournament_matches');
    const showCol = cols.find(c => c.Field === 'show_on_display');
    if (showCol && showCol.Default !== '1') {
      try {
        await db.query("ALTER TABLE tournament_matches ALTER COLUMN show_on_display SET DEFAULT 1");
        console.log('✅ show_on_display default set to 1.');
      } catch (e) {
        console.warn('show_on_display default notice:', e.message);
      }
    }

    console.log('\n🎉 Multi-Live Matches Database Optimization Completed Successfully!\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Multi-Live Matches Migration Error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  migrateMultiLiveMatches();
}

module.exports = migrateMultiLiveMatches;
