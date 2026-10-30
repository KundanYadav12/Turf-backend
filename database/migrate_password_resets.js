const db = require('../config/database');

async function migratePasswordResets() {
  console.log('--- Migrating Password Resets Schema ---');
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(150) NOT NULL,
        otp_code VARCHAR(10) NOT NULL,
        token VARCHAR(128) NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email),
        INDEX idx_token (token),
        INDEX idx_otp (email, otp_code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    console.log('password_resets table ensured successfully.');
    console.log('--- Password Resets Migration Completed Successfully ---');
  } catch (err) {
    console.error('Error during migratePasswordResets:', err);
    throw err;
  }
}

if (require.main === module) {
  migratePasswordResets()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = migratePasswordResets;
