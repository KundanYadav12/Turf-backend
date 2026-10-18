const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const { normalizeUsername, checkUsernameAvailability } = require('../services/usernameService');
const { sendWelcomeEmail } = require('../services/emailService');

const register = async (req, res, next) => {
  try {
    const { fullName, email, phone, password, role = 'PLAYER', username } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ success: false, message: 'Full name, email, and password are required.' });
    }

    // Check if user already exists
    const existingUsers = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    }

    // Determine and validate unique username
    let targetUsername = username;
    if (targetUsername) {
      const check = await checkUsernameAvailability(targetUsername);
      if (!check.valid) {
        return res.status(400).json({ success: false, message: check.reason });
      }
      if (!check.available) {
        return res.status(409).json({
          success: false,
          message: 'This username is already taken. Please choose another username.',
          suggestions: check.suggestions
        });
      }
      targetUsername = check.normalized;
    } else {
      let base = normalizeUsername(fullName || email.split('@')[0]);
      if (base.length < 3) base = `user_${Date.now().toString().slice(-4)}`;
      let candidate = base;
      let counter = 1;
      while (true) {
        const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [candidate]);
        if (existing.length === 0) break;
        candidate = `${base}_${counter++}`;
      }
      targetUsername = candidate;
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert User with unique username
    const result = await db.query(
      `INSERT INTO users (full_name, username, email, phone, password_hash, status) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      [fullName, targetUsername, email, phone || null, passwordHash]
    );

    const userId = result.insertId;

    // Get Role ID
    const targetRole = ['PLAYER', 'VENUE_OWNER'].includes(role) ? role : 'PLAYER';
    const roles = await db.query('SELECT id FROM roles WHERE name = ?', [targetRole]);
    const roleId = roles.length > 0 ? roles[0].id : 4;

    await db.query('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId]);

    // Generate JWT Token
    const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
    const token = jwt.sign(
      { id: userId, email, username: targetUsername, role: targetRole, full_name: fullName },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Send welcome email asynchronously in background (non-blocking)
    setImmediate(() => {
      sendWelcomeEmail({ email, fullName, username: targetUsername }).catch(err => {
        console.warn('[Register] Welcome email error:', err.message);
      });
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      data: {
        token,
        user: {
          id: userId,
          fullName,
          username: targetUsername,
          email,
          phone,
          role: targetRole
        }
      }
    });
  } catch (error) {

    next(error);
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Please provide both email and password.' });
    }

    // Fetch user and primary role
    const users = await db.query(
      `SELECT u.*, r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.email = ?`,
      [email]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = users[0];

    if (user.status !== 'ACTIVE' || user.deletion_status === 'SOFT_DELETED' || user.deletion_status === 'PERMANENTLY_DELETED' || user.deleted_at) {
      return res.status(403).json({
        success: false,
        message: 'Your account has been deactivated or scheduled for deletion. Please contact support or request restoration.'
      });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid email or password.' });
    }

    // Generate JWT Token
    const secret = process.env.JWT_SECRET || 'super_secret_sports_booking_jwt_key_2026_safe';
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, full_name: user.full_name },
      secret,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    res.json({
      success: true,
      message: 'Logged in successfully!',
      data: {
        token,
        user: {
          id: user.id,
          fullName: user.full_name,
          username: user.username,
          email: user.email,
          phone: user.phone,
          role: user.role,
          profilePhoto: user.profile_photo
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const users = await db.query(
      `SELECT u.id, u.full_name, u.username, u.email, u.phone, u.profile_photo, u.status, 
              u.deletion_status, u.deletion_requested_at, u.scheduled_permanent_deletion_at,
              r.name as role 
       FROM users u
       JOIN user_roles ur ON u.id = ur.user_id
       JOIN roles r ON ur.role_id = r.id
       WHERE u.id = ?`,
      [req.user.id]
    );

    if (!users || users.length === 0) {
      return res.status(404).json({ success: false, message: 'User profile not found.' });
    }

    const user = users[0];
    res.json({
      success: true,
      data: {
        id: user.id,
        fullName: user.full_name,
        username: user.username,
        email: user.email,
        phone: user.phone,
        profilePhoto: user.profile_photo,
        role: user.role,
        status: user.status,
        deletionStatus: user.deletion_status || 'ACTIVE',
        deletionRequestedAt: user.deletion_requested_at || null,
        scheduledPermanentDeletionAt: user.scheduled_permanent_deletion_at || null
      }
    });

  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  login,
  getMe
};
