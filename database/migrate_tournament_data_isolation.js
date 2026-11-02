const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Tournament Data Isolation & Constraint Migration...');

  try {
    // 1. Verify / Add `is_standalone` column on `tournament_matches`
    const cols = await db.query("SHOW COLUMNS FROM tournament_matches LIKE 'is_standalone'");
    if (cols.length === 0) {
      console.log('Adding column is_standalone to tournament_matches...');
      await db.query(`
        ALTER TABLE tournament_matches 
        ADD COLUMN is_standalone BOOLEAN NOT NULL DEFAULT FALSE 
        COMMENT 'Explicitly marks matches not affiliated with any tournament'
      `);
      console.log('✅ Added column is_standalone.');
    } else {
      console.log('ℹ️ Column is_standalone already exists on tournament_matches.');
    }

    // 2. Ensure index on tournament_id exists
    const indexes = await db.query("SHOW INDEX FROM tournament_matches WHERE Column_name = 'tournament_id'");
    const hasStandaloneTournIdx = indexes.some(idx => idx.Key_name === 'idx_matches_tournament_id');
    if (!hasStandaloneTournIdx) {
      console.log('Creating index idx_matches_tournament_id on tournament_matches(tournament_id)...');
      await db.query(`
        CREATE INDEX idx_matches_tournament_id ON tournament_matches (tournament_id)
      `);
      console.log('✅ Created index idx_matches_tournament_id.');
    } else {
      console.log('ℹ️ Index idx_matches_tournament_id already exists.');
    }

    // 3. Check for duplicates on (tournament_id, match_number)
    const duplicates = await db.query(`
      SELECT tournament_id, match_number, COUNT(*) as count, GROUP_CONCAT(id) as match_ids
      FROM tournament_matches
      WHERE tournament_id IS NOT NULL AND is_standalone = FALSE
      GROUP BY tournament_id, match_number
      HAVING count > 1
    `);

    if (duplicates.length > 0) {
      console.warn('⚠️ AUDIT WARNING: Duplicate (tournament_id, match_number) rows exist in the database:');
      console.table(duplicates);
      console.warn('Per safety requirements, duplicate rows are NOT auto-reassigned without explicit confirmation.');
      console.warn('Skipping addition of UNIQUE constraint uq_tournament_match_number until duplicates are resolved.');
    } else {
      // Check if unique index already exists
      const uniqueIndexes = await db.query("SHOW INDEX FROM tournament_matches WHERE Key_name = 'uq_tournament_match_number'");
      if (uniqueIndexes.length === 0) {
        console.log('Adding UNIQUE constraint uq_tournament_match_number (tournament_id, match_number)...');
        await db.query(`
          ALTER TABLE tournament_matches 
          ADD CONSTRAINT uq_tournament_match_number UNIQUE (tournament_id, match_number)
        `);
        console.log('✅ Added UNIQUE constraint uq_tournament_match_number.');
      } else {
        console.log('ℹ️ UNIQUE constraint uq_tournament_match_number already exists.');
      }
    }

    console.log('🎉 Tournament data isolation migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
