-- Sports Booking & Management Platform - Phase 2 Scalable Multi-Tournament Schema (MySQL)

USE turf_sports_db;

-- 1. TEAMS TABLE
CREATE TABLE IF NOT EXISTS teams (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(32) UNIQUE NOT NULL,
    sport_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    short_name VARCHAR(10) NOT NULL,
    slug VARCHAR(160) NOT NULL,
    logo_url VARCHAR(255) DEFAULT NULL,
    city VARCHAR(100) DEFAULT NULL,
    manager_id INT DEFAULT NULL,
    status ENUM('ACTIVE', 'INACTIVE') DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sport_id) REFERENCES sports(id),
    FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_teams_sport_status (sport_id, status),
    INDEX idx_teams_public_id (public_id)
) ENGINE=InnoDB;

-- 2. TEAM MEMBERS TABLE
CREATE TABLE IF NOT EXISTS team_members (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    team_id BIGINT NOT NULL,
    user_id INT DEFAULT NULL,
    player_name VARCHAR(100) NOT NULL,
    jersey_number INT DEFAULT NULL,
    role ENUM('CAPTAIN', 'VICE_CAPTAIN', 'PLAYER', 'SUBSTITUTE') DEFAULT 'PLAYER',
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_team_members_team (team_id)
) ENGINE=InnoDB;

-- 3. TOURNAMENTS TABLE
CREATE TABLE IF NOT EXISTS tournaments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(32) UNIQUE NOT NULL,
    sport_id INT NOT NULL,
    organizer_id INT NOT NULL,
    name VARCHAR(180) NOT NULL,
    slug VARCHAR(200) UNIQUE NOT NULL,
    description TEXT,
    format ENUM('LEAGUE', 'KNOCKOUT', 'LEAGUE_KNOCKOUT') NOT NULL DEFAULT 'KNOCKOUT',
    city VARCHAR(100) NOT NULL,
    banner_url VARCHAR(255) DEFAULT NULL,
    logo_url VARCHAR(255) DEFAULT NULL,
    max_teams INT NOT NULL DEFAULT 16,
    registered_teams_count INT NOT NULL DEFAULT 0,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status ENUM('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ONGOING', 'COMPLETED', 'CANCELLED') DEFAULT 'REGISTRATION_OPEN',
    rules_and_regulations TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (sport_id) REFERENCES sports(id),
    FOREIGN KEY (organizer_id) REFERENCES users(id),
    INDEX idx_tournaments_city_sport_status (city, sport_id, status),
    INDEX idx_tournaments_status_dates (status, start_date, end_date),
    INDEX idx_tournaments_public_id (public_id)
) ENGINE=InnoDB;

-- 4. TOURNAMENT VENUES MAPPING
CREATE TABLE IF NOT EXISTS tournament_venues (
    tournament_id BIGINT NOT NULL,
    venue_id INT NOT NULL,
    PRIMARY KEY (tournament_id, venue_id),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. TOURNAMENT TEAMS MAPPING
CREATE TABLE IF NOT EXISTS tournament_teams (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tournament_id BIGINT NOT NULL,
    team_id BIGINT NOT NULL,
    group_name VARCHAR(20) DEFAULT NULL,
    seed_number INT DEFAULT NULL,
    registration_status ENUM('PENDING', 'APPROVED', 'REJECTED', 'DISQUALIFIED') DEFAULT 'APPROVED',
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_tournament_team (tournament_id, team_id),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
    INDEX idx_tourn_teams_status (tournament_id, registration_status)
) ENGINE=InnoDB;

-- 6. TOURNAMENT ROUNDS TABLE
CREATE TABLE IF NOT EXISTS tournament_rounds (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    tournament_id BIGINT NOT NULL,
    round_number INT NOT NULL,
    name VARCHAR(50) NOT NULL,
    round_type ENUM('GROUP', 'ROUND_OF_64', 'ROUND_OF_32', 'ROUND_OF_16', 'QUARTER_FINAL', 'SEMI_FINAL', 'FINAL') NOT NULL,
    sequence_order INT NOT NULL DEFAULT 1,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    INDEX idx_tourn_rounds_order (tournament_id, sequence_order)
) ENGINE=InnoDB;

-- 7. MATCHES TABLE
CREATE TABLE IF NOT EXISTS matches (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(32) UNIQUE NOT NULL,
    tournament_id BIGINT NOT NULL,
    round_id BIGINT NOT NULL,
    venue_id INT NOT NULL,
    court_id INT NOT NULL,
    team_a_id BIGINT NOT NULL,
    team_b_id BIGINT NOT NULL,
    match_number INT NOT NULL,
    scheduled_date DATE NOT NULL,
    scheduled_start TIME NOT NULL,
    scheduled_end TIME NOT NULL,
    actual_start DATETIME DEFAULT NULL,
    actual_end DATETIME DEFAULT NULL,
    status ENUM('SCHEDULED', 'WARMUP', 'LIVE', 'INNINGS_BREAK', 'COMPLETED', 'POSTPONED', 'ABANDONED') DEFAULT 'SCHEDULED',
    winner_team_id BIGINT DEFAULT NULL,
    result_summary VARCHAR(255) DEFAULT NULL,
    live_score_summary VARCHAR(100) DEFAULT 'Yet to Start',
    live_subtext VARCHAR(100) DEFAULT NULL,
    sport_state JSON DEFAULT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES tournament_rounds(id),
    FOREIGN KEY (venue_id) REFERENCES venues(id),
    FOREIGN KEY (court_id) REFERENCES courts(id),
    FOREIGN KEY (team_a_id) REFERENCES teams(id),
    FOREIGN KEY (team_b_id) REFERENCES teams(id),
    FOREIGN KEY (winner_team_id) REFERENCES teams(id) ON DELETE SET NULL,
    INDEX idx_matches_tourn_status (tournament_id, status),
    INDEX idx_matches_court_schedule (court_id, scheduled_date, scheduled_start, scheduled_end),
    INDEX idx_matches_public_id (public_id),
    INDEX idx_matches_status_date (status, scheduled_date)
) ENGINE=InnoDB;

-- 8. SCORE EVENTS TABLE
CREATE TABLE IF NOT EXISTS score_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    match_id BIGINT NOT NULL,
    sequence_number INT NOT NULL,
    period_or_innings TINYINT NOT NULL DEFAULT 1,
    unit_time VARCHAR(20) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    primary_player_id INT DEFAULT NULL,
    secondary_player_id INT DEFAULT NULL,
    score_delta INT NOT NULL DEFAULT 0,
    raw_payload JSON NOT NULL,
    commentary_text VARCHAR(255) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
    UNIQUE KEY uk_match_seq (match_id, sequence_number),
    INDEX idx_events_match_pagination (match_id, sequence_number DESC)
) ENGINE=InnoDB;
