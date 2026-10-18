const db = require('../config/database');

async function migrate() {
  console.log('Running Auction Migration...');

  // 1. tournament_auctions
  await db.query(`
    CREATE TABLE IF NOT EXISTS tournament_auctions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uuid VARCHAR(36) NOT NULL UNIQUE,
      tournament_id INT NOT NULL,
      name VARCHAR(150) NOT NULL,
      status ENUM('DRAFT', 'UPCOMING', 'LIVE', 'PAUSED', 'COMPLETED') DEFAULT 'DRAFT',
      currency VARCHAR(10) DEFAULT 'INR',
      currency_symbol VARCHAR(5) DEFAULT '₹',
      default_wallet_amount DECIMAL(14,2) NOT NULL DEFAULT 10000000.00,
      min_squad_size INT NOT NULL DEFAULT 11,
      max_squad_size INT NULL DEFAULT 15,
      bid_increment_type ENUM('FIXED', 'CATEGORY', 'TIERED') DEFAULT 'TIERED',
      default_bid_increment DECIMAL(14,2) DEFAULT 50000.00,
      bid_timer_seconds INT DEFAULT 30,
      timer_extension_seconds INT DEFAULT 15,
      bidding_mode ENUM('OPERATOR_ONLY', 'TEAM_REP_AND_OPERATOR') DEFAULT 'TEAM_REP_AND_OPERATOR',
      current_player_id INT NULL,
      current_bid DECIMAL(14,2) DEFAULT 0.00,
      current_bidder_team_id INT NULL,
      timer_end_at TIMESTAMP NULL,
      start_date_time DATETIME NULL,
      rules TEXT NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_tournament_auction (tournament_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created tournament_auctions');

  // 2. auction_categories
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      name VARCHAR(50) NOT NULL,
      description VARCHAR(255) NULL,
      base_price DECIMAL(14,2) NOT NULL DEFAULT 100000.00,
      bid_increment DECIMAL(14,2) NOT NULL DEFAULT 50000.00,
      display_order INT DEFAULT 0,
      is_active TINYINT(1) DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_auction_cat (auction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_categories');

  // 3. auction_teams
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      team_id INT NOT NULL,
      representative_user_id INT NULL,
      total_budget DECIMAL(14,2) NOT NULL DEFAULT 10000000.00,
      amount_spent DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      remaining_balance DECIMAL(14,2) NOT NULL DEFAULT 10000000.00,
      reserved_budget DECIMAL(14,2) NOT NULL DEFAULT 0.00,
      available_bidding_budget DECIMAL(14,2) NOT NULL DEFAULT 10000000.00,
      min_squad_size INT NOT NULL DEFAULT 11,
      max_squad_size INT NULL DEFAULT 15,
      players_purchased INT NOT NULL DEFAULT 0,
      status ENUM('ACTIVE', 'DISQUALIFIED') DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_auction_team (auction_id, team_id),
      INDEX idx_auction_teams (auction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_teams');

  // 4. auction_players
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_players (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      user_id INT NULL,
      player_name VARCHAR(100) NOT NULL,
      profile_photo VARCHAR(255) NULL,
      player_registration_id VARCHAR(50) NULL,
      role ENUM('BATTER', 'BOWLER', 'ALL_ROUNDER', 'WICKET_KEEPER') DEFAULT 'ALL_ROUNDER',
      batting_style VARCHAR(50) DEFAULT 'Right-hand bat',
      bowling_style VARCHAR(50) DEFAULT 'Right-arm medium',
      previous_team VARCHAR(100) NULL,
      category_id INT NULL,
      base_price DECIMAL(14,2) NOT NULL DEFAULT 100000.00,
      status ENUM('AVAILABLE', 'IN_AUCTION', 'SOLD', 'UNSOLD', 'WITHDRAWN') DEFAULT 'AVAILABLE',
      winning_auction_team_id INT NULL,
      sold_price DECIMAL(14,2) NULL,
      lot_number INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_auction_players (auction_id),
      INDEX idx_player_status (auction_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_players');

  // 5. auction_bids
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_bids (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      player_id INT NOT NULL,
      auction_team_id INT NOT NULL,
      bid_amount DECIMAL(14,2) NOT NULL,
      previous_bid_amount DECIMAL(14,2) DEFAULT 0.00,
      placed_by_user_id INT NOT NULL,
      bid_status ENUM('ACCEPTED', 'OUTBID', 'WINNING', 'REJECTED') DEFAULT 'ACCEPTED',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_auction_bids (auction_id, player_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_bids');

  // 6. auction_squads
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_squads (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      auction_team_id INT NOT NULL,
      player_id INT NOT NULL,
      purchase_price DECIMAL(14,2) NOT NULL,
      acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_squad_player (auction_id, player_id),
      INDEX idx_squad_team (auction_id, auction_team_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_squads');

  // 7. auction_audit_logs
  await db.query(`
    CREATE TABLE IF NOT EXISTS auction_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      auction_id INT NOT NULL,
      action_type VARCHAR(50) NOT NULL,
      player_id INT NULL,
      team_id INT NULL,
      amount DECIMAL(14,2) NULL,
      acting_user_id INT NOT NULL,
      details JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_auction (auction_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('✓ Created auction_audit_logs');

  console.log('Auction migration completed successfully!');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration error:', e);
  process.exit(1);
});
