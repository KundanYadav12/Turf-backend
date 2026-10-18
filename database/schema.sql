-- Sports Booking & Management Platform - Complete Phase 1 Database Schema (MySQL)

CREATE DATABASE IF NOT EXISTS turf_sports_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE turf_sports_db;

-- 1. USERS TABLE
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone VARCHAR(20) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    profile_photo VARCHAR(255) DEFAULT NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. ROLES TABLE
CREATE TABLE IF NOT EXISTS roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    description VARCHAR(255)
) ENGINE=InnoDB;

-- 3. PERMISSIONS TABLE
CREATE TABLE IF NOT EXISTS permissions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    module VARCHAR(50) NOT NULL
) ENGINE=InnoDB;

-- 4. USER ROLES MAPPING
CREATE TABLE IF NOT EXISTS user_roles (
    user_id INT NOT NULL,
    role_id INT NOT NULL,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. ROLE PERMISSIONS MAPPING
CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INT NOT NULL,
    permission_id INT NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
    FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. SPORTS TABLE
CREATE TABLE IF NOT EXISTS sports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    icon VARCHAR(100) DEFAULT 'trophy',
    is_active TINYINT(1) DEFAULT 1,
    sort_order INT DEFAULT 0
) ENGINE=InnoDB;

-- 7. VENUES TABLE
CREATE TABLE IF NOT EXISTS venues (
    id INT AUTO_INCREMENT PRIMARY KEY,
    owner_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(150) UNIQUE NOT NULL,
    description TEXT,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100) NOT NULL,
    pincode VARCHAR(20) NOT NULL,
    latitude DECIMAL(10, 8) DEFAULT NULL,
    longitude DECIMAL(11, 8) DEFAULT NULL,
    cancellation_policy TEXT,
    rules TEXT,
    status ENUM('PENDING', 'APPROVED', 'REJECTED', 'INACTIVE') DEFAULT 'APPROVED',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8. VENUE IMAGES TABLE
CREATE TABLE IF NOT EXISTS venue_images (
    id INT AUTO_INCREMENT PRIMARY KEY,
    venue_id INT NOT NULL,
    image_url VARCHAR(255) NOT NULL,
    is_primary TINYINT(1) DEFAULT 0,
    sort_order INT DEFAULT 0,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 9. AMENITIES TABLE
CREATE TABLE IF NOT EXISTS amenities (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    icon VARCHAR(100) DEFAULT 'check-circle'
) ENGINE=InnoDB;

-- 10. VENUE AMENITIES MAPPING
CREATE TABLE IF NOT EXISTS venue_amenities (
    venue_id INT NOT NULL,
    amenity_id INT NOT NULL,
    PRIMARY KEY (venue_id, amenity_id),
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
    FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 11. VENUE SPORTS MAPPING
CREATE TABLE IF NOT EXISTS venue_sports (
    venue_id INT NOT NULL,
    sport_id INT NOT NULL,
    PRIMARY KEY (venue_id, sport_id),
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
    FOREIGN KEY (sport_id) REFERENCES sports(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 12. COURTS TABLE
CREATE TABLE IF NOT EXISTS courts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    venue_id INT NOT NULL,
    sport_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    surface_type VARCHAR(100) DEFAULT 'Artificial Turf',
    slot_duration_minutes INT DEFAULT 60,
    base_price_per_hour DECIMAL(10, 2) NOT NULL,
    status ENUM('ACTIVE', 'INACTIVE', 'MAINTENANCE') DEFAULT 'ACTIVE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
    FOREIGN KEY (sport_id) REFERENCES sports(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 13. COURT OPERATING HOURS
CREATE TABLE IF NOT EXISTS court_operating_hours (
    id INT AUTO_INCREMENT PRIMARY KEY,
    court_id INT NOT NULL,
    day_of_week TINYINT NOT NULL COMMENT '0=Sunday, 1=Monday, ..., 6=Saturday',
    open_time TIME NOT NULL,
    close_time TIME NOT NULL,
    is_closed TINYINT(1) DEFAULT 0,
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 14. COURT PRICING OVERRIDES
CREATE TABLE IF NOT EXISTS court_pricing (
    id INT AUTO_INCREMENT PRIMARY KEY,
    court_id INT NOT NULL,
    day_type ENUM('WEEKDAY', 'WEEKEND', 'SPECIFIC_DATE') DEFAULT 'WEEKDAY',
    specific_date DATE DEFAULT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    price_per_hour DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15. SLOTS TABLE (CONCURRENCY LOCKED)
CREATE TABLE IF NOT EXISTS slots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    court_id INT NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    status ENUM('AVAILABLE', 'BOOKED', 'BLOCKED', 'OFFLINE_BOOKED') DEFAULT 'AVAILABLE',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_court_slot (court_id, date, start_time, end_time),
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 16. BOOKINGS TABLE
CREATE TABLE IF NOT EXISTS bookings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    booking_number VARCHAR(50) UNIQUE NOT NULL,
    user_id INT NOT NULL,
    venue_id INT NOT NULL,
    court_id INT NOT NULL,
    sport_id INT NOT NULL,
    booking_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    subtotal_amount DECIMAL(10, 2) NOT NULL,
    discount_amount DECIMAL(10, 2) DEFAULT 0.00,
    tax_amount DECIMAL(10, 2) DEFAULT 0.00,
    final_amount DECIMAL(10, 2) NOT NULL,
    platform_commission_amount DECIMAL(10, 2) DEFAULT 0.00,
    booking_type ENUM('ONLINE', 'OFFLINE_WALKIN', 'OFFLINE_PHONE') DEFAULT 'ONLINE',
    booking_status ENUM('PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED', 'EXPIRED') DEFAULT 'CONFIRMED',
    payment_status ENUM('PENDING', 'PAID', 'FAILED', 'REFUNDED') DEFAULT 'PAID',
    qr_code_token VARCHAR(255) NOT NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
    FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE,
    FOREIGN KEY (sport_id) REFERENCES sports(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17. BOOKING SLOTS MAPPING
CREATE TABLE IF NOT EXISTS booking_slots (
    booking_id INT NOT NULL,
    slot_id INT NOT NULL,
    PRIMARY KEY (booking_id, slot_id),
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 18. PAYMENTS TABLE
CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    booking_id INT NOT NULL,
    transaction_reference VARCHAR(100) UNIQUE NOT NULL,
    gateway_name VARCHAR(50) DEFAULT 'RAZORPAY_MOCK',
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'INR',
    payment_method VARCHAR(50) DEFAULT 'UPI',
    status ENUM('CREATED', 'PENDING', 'SUCCESS', 'FAILED', 'REFUNDED') DEFAULT 'SUCCESS',
    raw_response JSON DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 19. COUPONS TABLE
CREATE TABLE IF NOT EXISTS coupons (
    id INT AUTO_INCREMENT PRIMARY KEY,
    venue_id INT DEFAULT NULL COMMENT 'NULL means global coupon',
    code VARCHAR(50) UNIQUE NOT NULL,
    discount_type ENUM('PERCENTAGE', 'FIXED') DEFAULT 'PERCENTAGE',
    discount_value DECIMAL(10, 2) NOT NULL,
    min_booking_amount DECIMAL(10, 2) DEFAULT 0.00,
    max_discount_amount DECIMAL(10, 2) DEFAULT NULL,
    valid_from DATE NOT NULL,
    valid_until DATE NOT NULL,
    usage_limit INT DEFAULT 1000,
    user_usage_limit INT DEFAULT 1,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 20. COUPON USAGES TABLE
CREATE TABLE IF NOT EXISTS coupon_usages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    coupon_id INT NOT NULL,
    user_id INT NOT NULL,
    booking_id INT NOT NULL,
    used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 21. REVIEWS TABLE
CREATE TABLE IF NOT EXISTS reviews (
    id INT AUTO_INCREMENT PRIMARY KEY,
    booking_id INT NOT NULL UNIQUE,
    venue_id INT NOT NULL,
    user_id INT NOT NULL,
    rating TINYINT NOT NULL CHECK (rating >= 1 AND rating <= 5),
    ground_quality_rating TINYINT DEFAULT 5,
    cleanliness_rating TINYINT DEFAULT 5,
    staff_rating TINYINT DEFAULT 5,
    facilities_rating TINYINT DEFAULT 5,
    comment TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
    FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 22. NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    title VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    type VARCHAR(50) DEFAULT 'BOOKING',
    is_read TINYINT(1) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- INDEXES FOR SEARCH AND PERFORMANCE
CREATE INDEX idx_venues_city_status ON venues(city, status);
CREATE INDEX idx_courts_venue_sport ON courts(venue_id, sport_id);
CREATE INDEX idx_slots_court_date ON slots(court_id, date);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_venue_date ON bookings(venue_id, booking_date);
