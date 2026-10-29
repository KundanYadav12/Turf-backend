const bcrypt = require('bcryptjs');
const {
  db,
  promptText,
  promptPassword,
  validateEmail,
  validatePassword,
  generateUniqueUsername,
  recordAudit,
  cleanupAndExit
} = require('./cliUtils');

async function main() {
  console.log('\n================================================================');
  console.log('🛡️   TURF PLATFORM: CREATE SUPERADMIN ACCOUNT (CLI UTILITY)');
  console.log('================================================================');
  console.log('This utility securely provisions a new Superadmin account.');
  console.log('No passwords or credentials will be stored in plaintext or logged.\n');

  try {
    // 1. Prompt for Full Name
    let fullName = await promptText('👤 Enter Full Name [default: Super Admin]: ');
    if (!fullName) {
      fullName = 'Super Admin';
    }

    // 2. Prompt for Email Address
    const rawEmail = await promptText('📧 Enter Email Address: ');
    const emailValidation = validateEmail(rawEmail);
    if (!emailValidation.valid) {
      console.error(`\n❌ Error: ${emailValidation.message}`);
      return await cleanupAndExit(1);
    }
    const email = emailValidation.email;

    // 3. Check if user already exists
    const existingUsers = await db.query(
      `SELECT u.id, u.email, u.full_name, u.status, r.name as role
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE LOWER(u.email) = ?`,
      [email]
    );

    if (existingUsers && existingUsers.length > 0) {
      const existing = existingUsers[0];
      console.error(`\n❌ Account Creation Aborted:`);
      console.error(`   An account with email "${email}" already exists in the system.`);
      console.error(`   Account ID: ${existing.id}`);
      console.error(`   Full Name:  ${existing.full_name}`);
      console.error(`   Role:       ${existing.role || 'Unassigned'}`);
      console.error(`   Status:     ${existing.status}`);
      console.error(`\nℹ️  If you are an authorized administrator attempting to reset this account's password, run:`);
      console.error(`   npm run superadmin:reset-password\n`);
      return await cleanupAndExit(1);
    }

    // 4. Prompt for Username (optional, default auto-generated)
    let username = await promptText('🏷️  Enter Username [press Enter to auto-generate]: ');
    if (username) {
      username = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (username.length < 3 || username.length > 30) {
        console.error('\n❌ Error: Username must be between 3 and 30 alphanumeric characters.');
        return await cleanupAndExit(1);
      }
      const existingUsernames = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [username]);
      if (existingUsernames && existingUsernames.length > 0) {
        console.error(`\n❌ Error: Username "${username}" is already taken.`);
        return await cleanupAndExit(1);
      }
    } else {
      username = await generateUniqueUsername(fullName, email);
      console.log(`ℹ️  Auto-assigned unique username: ${username}`);
    }

    // 5. Prompt for Phone (optional)
    const phoneInput = await promptText('📱 Enter Phone Number [optional, press Enter to skip]: ');
    const phone = phoneInput ? phoneInput.trim() : null;

    if (phone) {
      const existingPhone = await db.query('SELECT id FROM users WHERE phone = ?', [phone]);
      if (existingPhone && existingPhone.length > 0) {
        console.error(`\n❌ Error: Phone number "${phone}" is already registered to another user.`);
        return await cleanupAndExit(1);
      }
    }

    // 6. Prompt for Password (hidden/masked)
    console.log('\n🔒 Enter a secure password (minimum 8 characters, with letters and numbers):');
    const password = await promptPassword('🔑 Password: ');
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      console.error(`\n❌ Password Validation Failed: ${passwordValidation.message}`);
      return await cleanupAndExit(1);
    }

    // 7. Prompt for Password Confirmation (hidden/masked)
    const confirmPassword = await promptPassword('🔑 Confirm Password: ');
    if (password !== confirmPassword) {
      console.error('\n❌ Password Confirmation Failed: Passwords do not match.');
      return await cleanupAndExit(1);
    }

    // 8. Hash password using bcryptjs (salt rounds: 10)
    console.log('\n⏳ Hashing password securely with bcrypt...');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 9. Fetch or ensure ADMIN role exists in roles table
    let adminRoleId = null;
    const existingRoles = await db.query(
      "SELECT id, name FROM roles WHERE UPPER(name) = 'ADMIN' LIMIT 1"
    );

    if (existingRoles && existingRoles.length > 0) {
      adminRoleId = existingRoles[0].id;
    } else {
      const roleInsert = await db.query(
        "INSERT INTO roles (id, name, description) VALUES (1, 'ADMIN', 'Super administrator with platform-wide access')"
      );
      adminRoleId = roleInsert.insertId || 1;
    }

    // 10. Insert user and assign ADMIN role atomically via transaction
    console.log('⏳ Creating Superadmin user record in database...');
    let newUserId = null;

    await db.transaction(async (conn) => {
      // Re-verify email inside transaction for race-condition safety
      const [duplicateCheck] = await conn.query('SELECT id FROM users WHERE LOWER(email) = ?', [email]);
      if (duplicateCheck && duplicateCheck.length > 0) {
        throw new Error(`Account with email "${email}" was concurrently created.`);
      }

      const [insertUser] = await conn.query(
        `INSERT INTO users (
          full_name, username, email, phone, password_hash, status, deletion_status
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 'ACTIVE')`,
        [fullName, username, email, phone, passwordHash]
      );

      newUserId = insertUser.insertId;

      await conn.query(
        `INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)`,
        [newUserId, adminRoleId]
      );
    });

    // 11. Record structured administrative audit log (no sensitive credentials exposed)
    recordAudit('CREATE_SUPERADMIN', {
      userId: newUserId,
      email,
      username,
      role: 'ADMIN',
      status: 'ACTIVE'
    });

    // 12. Display success summary
    console.log('\n================================================================');
    console.log('🎉 SUCCESS: SUPERADMIN ACCOUNT CREATED SUCCESSFULLY');
    console.log('================================================================');
    console.log(`   Account ID:     ${newUserId}`);
    console.log(`   Full Name:      ${fullName}`);
    console.log(`   Username:       ${username}`);
    console.log(`   Email:          ${email}`);
    console.log(`   Role:           ADMIN (Super Administrator)`);
    console.log(`   Account Status: ACTIVE`);
    if (phone) {
      console.log(`   Phone:          ${phone}`);
    }
    console.log('================================================================');
    console.log('ℹ️  You can now log in using the email and password provided.');
    console.log('   Credentials have been securely encrypted and stored.\n');

    await cleanupAndExit(0);
  } catch (error) {
    console.error('\n❌ Unexpected Database / System Error:');
    console.error(`   ${error.message || error}`);
    await cleanupAndExit(1);
  }
}

// Execute CLI
if (require.main === module) {
  main().catch(async (err) => {
    console.error('Fatal CLI Error:', err.message || err);
    await cleanupAndExit(1);
  });
}

module.exports = main;
