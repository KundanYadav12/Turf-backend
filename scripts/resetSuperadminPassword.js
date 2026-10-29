const bcrypt = require('bcryptjs');
const {
  db,
  promptText,
  promptPassword,
  validateEmail,
  validatePassword,
  recordAudit,
  cleanupAndExit
} = require('./cliUtils');

async function main() {
  console.log('\n================================================================');
  console.log('🔑   TURF PLATFORM: RESET SUPERADMIN PASSWORD (CLI UTILITY)');
  console.log('================================================================');
  console.log('This utility securely resets the password of an existing Superadmin.');
  console.log('It will strictly verify that the account possesses the ADMIN role.');
  console.log('No passwords or credentials will be stored in plaintext or logged.\n');

  try {
    // 1. Prompt for Superadmin Email Address
    const rawEmail = await promptText('📧 Enter Superadmin Email Address: ');
    const emailValidation = validateEmail(rawEmail);
    if (!emailValidation.valid) {
      console.error(`\n❌ Error: ${emailValidation.message}`);
      return await cleanupAndExit(1);
    }
    const email = emailValidation.email;

    // 2. Fetch user and verify existence
    const users = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.status, u.deletion_status, r.name as role
       FROM users u
       LEFT JOIN user_roles ur ON u.id = ur.user_id
       LEFT JOIN roles r ON ur.role_id = r.id
       WHERE LOWER(u.email) = ?`,
      [email]
    );

    if (!users || users.length === 0) {
      console.error(`\n❌ Error: No user account found with email "${email}".`);
      console.error('   Please check the email address or create a new Superadmin using:');
      console.error('   npm run superadmin:create\n');
      return await cleanupAndExit(1);
    }

    const user = users[0];
    const roleUpper = String(user.role || '').toUpperCase();

    // 3. Strictly verify Superadmin role
    if (roleUpper !== 'ADMIN' && roleUpper !== 'SUPER_ADMIN') {
      console.error(`\n🚫 Security Access Denied:`);
      console.error(`   The account "${email}" (ID: ${user.id}) does NOT have the Superadmin role.`);
      console.error(`   Current assigned role: "${user.role || 'NONE'}"`);
      console.error(`   Password resetting via this utility is strictly restricted to Superadmin accounts.`);
      console.error(`   Non-admin accounts cannot be modified or elevated using this command.\n`);
      return await cleanupAndExit(1);
    }

    console.log(`\n✅ Verified Superadmin Account:`);
    console.log(`   Account ID: ${user.id}`);
    console.log(`   Full Name:  ${user.full_name}`);
    console.log(`   Username:   ${user.username || '(not set)'}`);
    console.log(`   Role:       ${user.role}`);
    console.log(`   Status:     ${user.status}`);

    // 4. Prompt for New Password (hidden/masked)
    console.log('\n🔒 Enter new secure password (minimum 8 characters, with letters and numbers):');
    const newPassword = await promptPassword('🔑 New Password: ');
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      console.error(`\n❌ Password Validation Failed: ${passwordValidation.message}`);
      return await cleanupAndExit(1);
    }

    // 5. Prompt for New Password Confirmation (hidden/masked)
    const confirmPassword = await promptPassword('🔑 Confirm New Password: ');
    if (newPassword !== confirmPassword) {
      console.error('\n❌ Password Confirmation Failed: Passwords do not match.');
      return await cleanupAndExit(1);
    }

    // 6. Hash new password securely with bcryptjs (10 rounds)
    console.log('\n⏳ Hashing new password securely with bcrypt...');
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // 7. Update password and reactivate account if previously deactivated/soft-deleted
    console.log('⏳ Updating password in database...');
    await db.query(
      `UPDATE users 
       SET password_hash = ?,
           status = 'ACTIVE',
           deletion_status = 'ACTIVE',
           deleted_at = NULL,
           deletion_requested_at = NULL,
           scheduled_permanent_deletion_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [passwordHash, user.id]
    );

    // 8. Record structured administrative audit log (no passwords exposed)
    recordAudit('RESET_SUPERADMIN_PASSWORD', {
      userId: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      status: 'ACTIVE'
    });

    // 9. Display success summary
    console.log('\n================================================================');
    console.log('🎉 SUCCESS: SUPERADMIN PASSWORD RESET SUCCESSFULLY');
    console.log('================================================================');
    console.log(`   Account ID:     ${user.id}`);
    console.log(`   Full Name:      ${user.full_name}`);
    console.log(`   Username:       ${user.username || '(none)'}`);
    console.log(`   Email:          ${user.email}`);
    console.log(`   Role:           ${user.role} (Super Administrator)`);
    console.log(`   Account Status: ACTIVE`);
    console.log('================================================================');
    console.log('ℹ️  The Superadmin password has been updated.');
    console.log('   The account can now log in immediately with the new password.');
    console.log('   The old password has been invalidated.\n');

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
