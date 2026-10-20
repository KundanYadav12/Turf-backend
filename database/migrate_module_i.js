const db = require('../config/database');

async function migrate() {
  try {
    console.log('--- Migrating Module I: Scorer Access Control ---');

    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_scorers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        match_id INT NULL,
        assigned_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tourn_user (tournament_id, user_id),
        INDEX idx_match_user (match_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('✓ tournament_scorers table created / verified');
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
