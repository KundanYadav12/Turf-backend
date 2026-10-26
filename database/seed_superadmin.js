const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

// Load environment variables from backend/.env or root .env
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env') });

const db = require('../config/database');

/**
 * Migration & Seeder: Idempotently creates or updates the production Super Admin account.
 * Reads credentials securely from environment variables.
 */
async function up() {
  const targetEmail = (process.env.SEED_SUPERADMIN_EMAIL || 'kundanyadav96197@gmail.com').trim().toLowerCase();
  const targetName = (process.env.SEED_SUPERADMIN_NAME || 'Kundan').trim();
  const targetPassword = process.env.SEED_SUPERADMIN_PASSWORD;
  const shouldResetPassword = String(process.env.SEED_SUPERADMIN_RESET_PASSWORD || '').toLowerCase() === 'true';

  console.log('\n======================================================');
  console.log('🛡️  Super Admin Production Account Seeder / Migration');
  console.log('======================================================');
  console.log(`Target Email: ${targetEmail}`);

  // 1. Check if SEED_SUPERADMIN_PASSWORD is provided
  if (!targetPassword || !targetPassword.trim()) {
    console.warn('⚠️  [seed_superadmin] SEED_SUPERADMIN_PASSWORD environment variable is not set.');
    console.warn('⚠️  [seed_superadmin] Skipping Super Admin account seeding safely.');
    console.warn('ℹ️  To seed this account, set SEED_SUPERADMIN_PASSWORD in backend/.env or production environment and re-run migrations.\n');
    return { skipped: true, reason: 'SEED_SUPERADMIN_PASSWORD_NOT_SET' };
  }

  // 2. Ensure ADMIN role exists in `roles` table
  let adminRoleId = null;
  const existingRoles = await db.query(
    "SELECT id, name FROM roles WHERE UPPER(name) IN ('ADMIN', 'SUPER_ADMIN') ORDER BY (UPPER(name) = 'ADMIN') DESC LIMIT 1"
  );

  if (existingRoles && existingRoles.length > 0) {
    adminRoleId = existingRoles[0].id;
  } else {
    // Insert ADMIN role with fallback ID 1
    const roleInsert = await db.query(
      "INSERT IGNORE INTO roles (id, name, description) VALUES (1, 'ADMIN', 'Super administrator with platform-wide access')"
    );
    adminRoleId = roleInsert.insertId || 1;
  }

  // 3. Check if user already exists
  const existingUsers = await db.query(
    'SELECT id, email, full_name, username, status, deletion_status FROM users WHERE LOWER(email) = ?',
    [targetEmail]
  );

  let userId = null;

  if (existingUsers && existingUsers.length > 0) {
    const existingUser = existingUsers[0];
    userId = existingUser.id;
    console.log(`ℹ️  [seed_superadmin] User with email ${targetEmail} already exists (ID: ${userId}).`);

    // Ensure account is ACTIVE and NOT soft-deleted
    await db.query(
      `UPDATE users 
       SET status = 'ACTIVE', 
           deletion_status = 'ACTIVE', 
           deleted_at = NULL, 
           deletion_requested_at = NULL, 
           scheduled_permanent_deletion_at = NULL
       WHERE id = ?`,
      [userId]
    );
    console.log(`✅ [seed_superadmin] Account status verified as ACTIVE (and not deleted).`);

    // Check / Update password if requested
    if (shouldResetPassword) {
      const salt = await bcrypt.genSalt(10);
      const passwordHash = await bcrypt.hash(targetPassword, salt);
      await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
      console.log(`🔑 [seed_superadmin] Password successfully updated because SEED_SUPERADMIN_RESET_PASSWORD=true.`);
    } else {
      console.log(`🔒 [seed_superadmin] Existing password preserved (set SEED_SUPERADMIN_RESET_PASSWORD=true to overwrite).`);
    }
  } else {
    // 4. Create new Super Admin user
    // Determine unique username
    let targetUsername = 'kundan';
    const existingUsernames = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [targetUsername]);
    if (existingUsernames && existingUsernames.length > 0) {
      targetUsername = `kundan_${Date.now().toString().slice(-4)}`;
    }

    // Hash password with bcryptjs salt 10
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(targetPassword, salt);

    const userInsert = await db.query(
      `INSERT INTO users (
        full_name, username, email, password_hash, status, deletion_status
      ) VALUES (?, ?, ?, ?, 'ACTIVE', 'ACTIVE')`,
      [targetName, targetUsername, targetEmail, passwordHash]
    );

    userId = userInsert.insertId;
    console.log(`✅ [seed_superadmin] Successfully created new user record (ID: ${userId}, Username: ${targetUsername}).`);
  }

  // 5. Ensure user has the ADMIN role in `user_roles`
  const userRoles = await db.query(
    'SELECT user_id, role_id FROM user_roles WHERE user_id = ? AND role_id = ?',
    [userId, adminRoleId]
  );

  if (!userRoles || userRoles.length === 0) {
    // If user has other roles, replace with ADMIN or add ADMIN role
    await db.query('DELETE FROM user_roles WHERE user_id = ?', [userId]);
    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, adminRoleId]);
    console.log(`✅ [seed_superadmin] Assigned ADMIN role (Role ID: ${adminRoleId}) to user.`);
  } else {
    console.log(`✅ [seed_superadmin] User already has active ADMIN role mapping.`);
  }

  console.log(`🎉 [seed_superadmin] Super Admin setup complete for ${targetEmail}.\n`);
  return { success: true, userId, email: targetEmail };
}

/**
 * Down / Rollback step:
 * Strictly preserves all user accounts and does not delete or modify any user data.
 */
async function down() {
  console.log('ℹ️  [seed_superadmin] Rollback requested: strictly preserving all user accounts. No users deleted or modified.');
  return Promise.resolve();
}

if (require.main === module) {
  up()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ [seed_superadmin] Execution failed:', err);
      process.exit(1);
    });
}

module.exports = up;
module.exports.up = up;
module.exports.down = down;
