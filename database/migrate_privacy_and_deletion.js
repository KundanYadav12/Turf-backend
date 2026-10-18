const db = require('../config/database');

async function migrate() {
  console.log('🔄 Running Privacy Policy & Account Deletion Migration...');

  try {
    // 1. Add columns to users table if they don't exist
    const [userColumns] = [await db.query('DESCRIBE users')];
    const columnNames = userColumns.map(c => c.Field);

    const alterStatements = [];

    if (!columnNames.includes('deleted_at')) {
      alterStatements.push('ADD COLUMN deleted_at DATETIME NULL');
    }
    if (!columnNames.includes('deletion_requested_at')) {
      alterStatements.push('ADD COLUMN deletion_requested_at DATETIME NULL');
    }
    if (!columnNames.includes('deletion_status')) {
      alterStatements.push("ADD COLUMN deletion_status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE'");
    }
    if (!columnNames.includes('deletion_reason')) {
      alterStatements.push('ADD COLUMN deletion_reason TEXT NULL');
    }
    if (!columnNames.includes('scheduled_permanent_deletion_at')) {
      alterStatements.push('ADD COLUMN scheduled_permanent_deletion_at DATETIME NULL');
    }

    if (alterStatements.length > 0) {
      console.log(`Adding ${alterStatements.length} columns to users table...`);
      for (const statement of alterStatements) {
        try {
          await db.query(`ALTER TABLE users ${statement}`);
        } catch (err) {
          console.warn(`Alter error (or column exists): ${err.message}`);
        }
      }
    } else {
      console.log('✅ Users table already has deletion tracking columns.');
    }

    // Modify status ENUM to include 'DELETED'
    try {
      await db.query("ALTER TABLE users MODIFY COLUMN status ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED', 'DELETED') DEFAULT 'ACTIVE'");
      console.log('✅ Users status enum modified to support DELETED.');
    } catch (enumErr) {
      console.warn('Status enum modify note:', enumErr.message);
    }

    // 2. Create privacy_policies table
    await db.query(`
      CREATE TABLE IF NOT EXISTS privacy_policies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        version INT NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT 'Official Privacy Policy',
        content LONGTEXT NOT NULL,
        status ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
        effective_date DATETIME NOT NULL,
        change_summary VARCHAR(255) NULL,
        author_id INT NULL,
        published_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_privacy_status (status),
        INDEX idx_privacy_version (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ privacy_policies table verified/created.');

    // 3. Create account_deletion_audits table
    await db.query(`
      CREATE TABLE IF NOT EXISTS account_deletion_audits (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        user_identifier VARCHAR(255) NOT NULL,
        requested_at DATETIME NULL,
        executed_by INT NULL,
        action_type VARCHAR(50) NOT NULL,
        details TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_user (user_id),
        INDEX idx_audit_action (action_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ account_deletion_audits table verified/created.');

    // 4. Seed initial official published privacy policy if none exists
    const existingPolicies = await db.query('SELECT id FROM privacy_policies WHERE status = "PUBLISHED"');
    if (existingPolicies.length === 0) {
      const initialPolicy = `# TurfSpot Privacy Policy

**Effective Date:** October 16, 2026  
**Last Updated:** October 16, 2026

Welcome to **TurfSpot** ("we," "our," or "us"). We are committed to protecting your privacy and ensuring you have complete control over your personal data. This Privacy Policy explains how we collect, use, disclose, retain, and safeguard your information when you use our web platform, mobile applications, and sports venue booking and tournament management services.

---

### 1. Information We Collect
We collect information that identifies or relates to you, including:
- **Personal Identification Details:** Full name, unique username, email address, phone number, date of birth, gender, and profile photo.
- **Athletic & Sports Profiles:** Preferred sport (Cricket, Football, Badminton, Pickleball), batting/bowling styles, primary positions, jersey numbers, and team memberships.
- **Bookings & Transactions:** Turf/court reservations, dates, time slots, payment amounts, and transaction references (we do not store raw credit/debit card numbers).
- **Match & Tournament Data:** Tournament registrations, player statistics, match scores, ball-by-ball commentary mentions, awards won, and team rosters.
- **Device & App Permissions:** 
  - *Camera & Photo Library:* Used solely when you voluntarily upload or change your profile avatar or team logo.
  - *Location (Optional):* Used solely to identify nearby turfs, courts, and sporting arenas with your permission.
  - *Push Notifications:* Used to notify you of booking confirmations, match schedules, live score updates, and team announcements.

---

### 2. How We Use Your Information
We use your data for legitimate operational and sporting purposes:
- Facilitating court and turf slot reservations with verified venue owners.
- Organizing sports tournaments, fixture generations, live match scoring, and player career statistics.
- Displaying your public athlete profile and team rosters to fellow players.
- Managing user authentication, account security, and fraud prevention.
- Fulfilling regulatory, taxation, and legal requirements.

---

### 3. Data Sharing & Third Parties
- **Venue Owners:** When you book a slot, the venue owner receives your name, booking reference, and contact details to manage court check-in.
- **Teammates & Opponents:** Your athlete username, public sporting statistics, and team affiliations are visible on public match scorecards and leaderboards.
- **Service Providers:** Cloud hosting, payment gateway providers, and image processing services bound by confidentiality obligations.
- **We never sell your personal data to data brokers or third-party advertisers.**

---

### 4. User Account Deletion & Data Retention
You retain complete control over your account and data:
- **In-App Account Deletion:** You can request account deletion at any time via **Account Settings > Profile > Delete My Account** on both the web application and mobile app.
- **Public Web Deletion Request:** Users who uninstalled the app or prefer web access can request deletion at **[https://turfspot.com/delete-account](/delete-account)** in accordance with Google Play Store data safety guidelines.
- **Soft Deletion & Grace Period:** Upon submitting a deletion request, your account is immediately deactivated. Active sessions are terminated, and your profile is removed from active searches and team listings. A 30-day grace period applies before permanent deletion.
- **Permanent Deletion:** When permanently deleted by Super Admin authorization, your personal identifiers (name, email, phone number, profile photo, address) are permanently purged or anonymized.
- **Historical Match Records:** To preserve tournament standings, fixtures, and historical scorecards for your teammates and opponents, match statistics are retained in anonymized form (e.g., "Deleted User"). Legitimate financial transaction records are retained as required by applicable commercial and tax laws.

---

### 5. Data Security
We implement industry-standard safeguards including bcrypt password hashing, encrypted SSL/TLS data transmission, role-based access control (RBAC), and continuous session validation.

---

### 6. Contact Us
If you have questions or concerns about this Privacy Policy or wish to exercise your data rights, please contact our Data Protection Officer at:
- **Email:** privacy@turfspot.com
- **Support Desk:** support@turfspot.com
- **Headquarters:** TurfSpot Sports Technologies Pvt. Ltd., Tech Park Road, Bengaluru, Karnataka, India.
`;

      await db.query(`
        INSERT INTO privacy_policies (version, title, content, status, effective_date, change_summary, author_id, published_at)
        VALUES (1, 'TurfSpot Official Privacy Policy', ?, 'PUBLISHED', NOW(), 'Initial official published policy', 1, NOW())
      `, [initialPolicy]);
      console.log('✅ Initial official published Privacy Policy seeded.');
    } else {
      console.log('ℹ️ Active published Privacy Policy already exists.');
    }

    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

migrate();
