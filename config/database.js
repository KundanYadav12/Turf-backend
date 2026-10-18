const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// Load .env FIRST before any pool creation
dotenv.config({ path: path.join(__dirname, '../.env') });

let mysqlPool = null;
let sqliteDb = null;
let useSqlite = false;

// Build MySQL pool config from env
const mysqlConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'turf_sports_db',
  waitForConnections: true,
  connectionLimit: 10
};

function getMysqlPool() {
  if (!mysqlPool) {
    mysqlPool = mysql.createPool(mysqlConfig);
  }
  return mysqlPool;
}

// Initialize SQLite fallback database if MySQL fails
function initSqliteFallback() {
  if (sqliteDb) return sqliteDb;

  const sqlite3 = require('sqlite3').verbose();
  const dbPath = path.join(__dirname, '../database/turf_sports_db.sqlite');
  
  sqliteDb = new sqlite3.Database(dbPath);

  // Auto-create SQLite schema tables & seeds if newly created
  sqliteDb.serialize(() => {
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      profile_photo TEXT,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS user_roles (
      user_id INTEGER NOT NULL,
      role_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, role_id)
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS sports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT 'trophy',
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      pincode TEXT NOT NULL,
      cancellation_policy TEXT,
      rules TEXT,
      status TEXT DEFAULT 'APPROVED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS venue_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      is_primary INTEGER DEFAULT 0,
      sort_order INTEGER DEFAULT 0
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS amenities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT 'check-circle'
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS venue_amenities (
      venue_id INTEGER NOT NULL,
      amenity_id INTEGER NOT NULL,
      PRIMARY KEY (venue_id, amenity_id)
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS venue_sports (
      venue_id INTEGER NOT NULL,
      sport_id INTEGER NOT NULL,
      PRIMARY KEY (venue_id, sport_id)
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS courts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER NOT NULL,
      sport_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      surface_type TEXT DEFAULT 'Artificial Turf',
      slot_duration_minutes INTEGER DEFAULT 60,
      base_price_per_hour REAL NOT NULL,
      status TEXT DEFAULT 'ACTIVE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS court_operating_hours (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      open_time TEXT NOT NULL,
      close_time TEXT NOT NULL,
      is_closed INTEGER DEFAULT 0
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      court_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      price REAL NOT NULL,
      status TEXT DEFAULT 'AVAILABLE',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (court_id, date, start_time, end_time)
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_number TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      venue_id INTEGER NOT NULL,
      court_id INTEGER NOT NULL,
      sport_id INTEGER NOT NULL,
      booking_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      subtotal_amount REAL NOT NULL,
      discount_amount REAL DEFAULT 0.00,
      tax_amount REAL DEFAULT 0.00,
      final_amount REAL NOT NULL,
      platform_commission_amount REAL DEFAULT 0.00,
      booking_type TEXT DEFAULT 'ONLINE',
      booking_status TEXT DEFAULT 'CONFIRMED',
      payment_status TEXT DEFAULT 'PAID',
      qr_code_token TEXT NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS booking_slots (
      booking_id INTEGER NOT NULL,
      slot_id INTEGER NOT NULL,
      PRIMARY KEY (booking_id, slot_id)
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL,
      transaction_reference TEXT UNIQUE NOT NULL,
      gateway_name TEXT DEFAULT 'RAZORPAY_MOCK',
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      payment_method TEXT DEFAULT 'UPI',
      status TEXT DEFAULT 'SUCCESS',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT DEFAULT 'PERCENTAGE',
      discount_value REAL NOT NULL,
      min_booking_amount REAL DEFAULT 0.00,
      max_discount_amount REAL,
      valid_from TEXT NOT NULL,
      valid_until TEXT NOT NULL,
      usage_limit INTEGER DEFAULT 1000,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    sqliteDb.run(`CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id INTEGER NOT NULL UNIQUE,
      venue_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Seed default roles, sports, users, venues & courts
    sqliteDb.run(`INSERT OR IGNORE INTO roles (id, name, description) VALUES 
      (1, 'ADMIN', 'Administrator'),
      (2, 'VENUE_OWNER', 'Owner'),
      (4, 'PLAYER', 'Customer')`);

    sqliteDb.run(`INSERT OR IGNORE INTO sports (id, name, slug, icon, is_active, sort_order) VALUES 
      (1, 'Cricket', 'cricket', 'trophy', 1, 1),
      (2, 'Football', 'football', 'activity', 1, 2),
      (3, 'Badminton', 'badminton', 'zap', 1, 3)`);

    sqliteDb.run(`INSERT OR IGNORE INTO users (id, full_name, email, phone, password_hash, status) VALUES 
      (1, 'Super Admin', 'admin@turf.com', '+919876543210', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE'),
      (2, 'Rajesh Owner', 'owner@turf.com', '+919876543211', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE'),
      (3, 'Kundan Player', 'player@turf.com', '+919876543212', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE')`);

    sqliteDb.run(`INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (1, 1), (2, 2), (3, 4)`);

    sqliteDb.run(`INSERT OR IGNORE INTO venues (id, owner_id, name, slug, description, address, city, state, pincode, cancellation_policy, rules, status) VALUES 
      (1, 2, 'ABC Apex Sports Arena', 'abc-apex-sports-arena', 'Premier multi-sport turf facility featuring professional FIFA-approved turf, high-lux flood lights, and spacious air-conditioned changing rooms.', 'Plot 45, Off Link Road, Andheri West', 'Mumbai', 'Maharashtra', '400053', 'Full refund up to 12 hours before slot.', 'No spikes allowed.', 'APPROVED'),
      (2, 2, 'Skyline Turf & Badminton Club', 'skyline-turf-badminton-club', 'State-of-the-art sports arena offering dual box-cricket turfs and 4 indoor BWF-standard synthetic badminton courts.', '100 Feet Ring Road, Indiranagar', 'Bengaluru', 'Karnataka', '560038', 'Full refund up to 24 hours prior.', 'Smoking prohibited.', 'APPROVED')`);

    sqliteDb.run(`INSERT OR IGNORE INTO venue_images (id, venue_id, image_url, is_primary) VALUES 
      (1, 1, 'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80', 1),
      (2, 2, 'https://images.unsplash.com/photo-1626248801379-51a0748a5f96?auto=format&fit=crop&w=1200&q=80', 1)`);

    sqliteDb.run(`INSERT OR IGNORE INTO venue_sports (venue_id, sport_id) VALUES (1, 1), (1, 2), (2, 1), (2, 3)`);

    sqliteDb.run(`INSERT OR IGNORE INTO courts (id, venue_id, sport_id, name, surface_type, base_price_per_hour, status) VALUES 
      (1, 1, 1, 'Cricket Turf 1 (Pro Pitch)', 'Artificial Turf', 1400.00, 'ACTIVE'),
      (2, 1, 2, 'Main Football Pitch 7v7', 'FIFA Grade Turf', 2000.00, 'ACTIVE'),
      (3, 2, 3, 'Badminton Court 1', 'Wooden Mat', 500.00, 'ACTIVE')`);

    sqliteDb.run(`INSERT OR IGNORE INTO coupons (id, code, discount_type, discount_value, min_booking_amount, valid_from, valid_until, is_active) VALUES
      (1, 'WELCOME20', 'PERCENTAGE', 20.00, 500.00, '2026-01-01', '2026-12-31', 1)`);
  });

  return sqliteDb;
}

// Convert MySQL SQL dialect to SQLite compatible format if needed
function formatSql(sql) {
  let s = sql.replace(/FOR UPDATE/gi, '');
  s = s.replace(/CONCAT\(([^)]+)\)/gi, (match, p1) => p1.split(',').join(' || '));
  return s;
}

async function sqliteQuery(sql, params = []) {
  const db = initSqliteFallback();
  const cleanSql = formatSql(sql);
  return new Promise((resolve, reject) => {
    if (cleanSql.trim().toUpperCase().startsWith('SELECT')) {
      db.all(cleanSql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    } else {
      db.run(cleanSql, params, function (err) {
        if (err) reject(err);
        else resolve({ insertId: this.lastID, affectedRows: this.changes });
      });
    }
  });
}

async function isMysqlReachable() {
  try {
    const pool = getMysqlPool();
    const conn = await pool.getConnection();
    conn.release();
    return true;
  } catch {
    return false;
  }
}

async function query(sql, params = []) {
  if (useSqlite) {
    return sqliteQuery(sql, params);
  }

  try {
    const pool = getMysqlPool();
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    // Only fall back to SQLite for connection-level errors (ECONNREFUSED, ER_ACCESS_DENIED etc)
    const isConnError = error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || 
                        error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' ||
                        error.message.includes('connect');
    if (isConnError) {
      console.warn('⚠️ MySQL Unavailable:', error.message, '--> Switching to local SQLite engine.');
      useSqlite = true;
      return sqliteQuery(sql, params);
    }
    // Re-throw SQL/constraint errors - don't fall back
    throw error;
  }
}

async function transaction(callback) {
  if (useSqlite) {
    const db = initSqliteFallback();
    return new Promise((resolve, reject) => {
      db.serialize(async () => {
        db.run('BEGIN TRANSACTION;');
        try {
          const fakeConnection = {
            // Wrap results in array to match mysql2 [rows, fields] signature
            query: async (sql, params = []) => {
              const rows = await sqliteQuery(sql, params);
              return [rows];
            },
            execute: async (sql, params = []) => {
              const rows = await sqliteQuery(sql, params);
              return [rows];
            }
          };
          const result = await callback(fakeConnection);
          db.run('COMMIT;');
          resolve(result);
        } catch (err) {
          db.run('ROLLBACK;');
          reject(err);
        }
      });
    });
  }

  // Test if MySQL is actually reachable before trying to get connection
  const mysqlUp = await isMysqlReachable();
  if (!mysqlUp) {
    console.warn('⚠️ MySQL not reachable --> Falling back to SQLite for this transaction.');
    useSqlite = true;
    return transaction(callback);
  }

  try {
    const pool = getMysqlPool();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      // Re-throw - this is likely a SQL/constraint error, not a connection error
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    // Only fall back if it's a genuine connection error
    const isConnError = error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || 
                        error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT';
    if (isConnError) {
      console.warn('⚠️ MySQL Connection Error during transaction --> Fallback to SQLite engine.');
      useSqlite = true;
      return transaction(callback);
    }
    throw error;
  }
}

module.exports = {
  query,
  transaction
};
