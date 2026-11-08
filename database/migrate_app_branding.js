const db = require('../config/database');

async function migrate() {
  try {
    console.log('--- Migrating Application Branding Tables ---');

    // 1. Create app_branding table
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_branding (
        id INT PRIMARY KEY,
        app_name VARCHAR(100) NOT NULL DEFAULT 'TurfSpot',
        app_tagline VARCHAR(255) NOT NULL DEFAULT 'Sports Hub',
        logo_url VARCHAR(500) NOT NULL DEFAULT '/logo.png',
        favicon_url VARCHAR(500) NOT NULL DEFAULT '/favicon.ico',
        logo_dark_url VARCHAR(500) NULL,
        contact_email VARCHAR(255) NULL,
        updated_by INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_updated_at (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created app_branding table');

    // 2. Insert default row if not exists
    const [existing] = await db.query('SELECT id FROM app_branding WHERE id = 1');
    if (!existing) {
      await db.query(`
        INSERT INTO app_branding (id, app_name, app_tagline, logo_url, favicon_url)
        VALUES (1, 'TurfSpot', 'Sports Hub', '/logo.png', '/favicon.ico')
      `);
      console.log('✅ Seeded default app branding record');
    }

    // 3. Create app_branding_audit_logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_branding_audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        user_email VARCHAR(255) NULL,
        user_role VARCHAR(50) NULL,
        action VARCHAR(50) NOT NULL,
        details JSON NULL,
        ip_address VARCHAR(45) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ Created app_branding_audit_logs table');

    console.log('🎉 Application Branding Migration Finished Successfully.');
  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = migrate;

