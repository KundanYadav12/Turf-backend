-- Sports Booking & Management Platform - Seed Data Script (MySQL)

USE turf_sports_db;

-- 1. SEED ROLES
INSERT IGNORE INTO roles (id, name, description) VALUES
(1, 'ADMIN', 'Super administrator with platform-wide access'),
(2, 'VENUE_OWNER', 'Venue owner who manages turfs, courts, and slot bookings'),
(3, 'VENUE_STAFF', 'Staff member managing walk-ins and court operations'),
(4, 'PLAYER', 'End customer / player who searches and books slots');

-- 2. SEED SPORTS
INSERT IGNORE INTO sports (id, name, slug, icon, is_active, sort_order) VALUES
(1, 'Cricket', 'cricket', 'trophy', 1, 1),
(2, 'Football', 'football', 'activity', 1, 2),
(3, 'Badminton', 'badminton', 'zap', 1, 3),
(4, 'Tennis', 'tennis', 'circle', 0, 4),
(5, 'Basketball', 'basketball', 'dribbble', 0, 5);

-- 3. SEED AMENITIES
INSERT IGNORE INTO amenities (id, name, icon) VALUES
(1, 'Parking', 'car'),
(2, 'Washroom', 'toilet'),
(3, 'Changing Room', 'shirt'),
(4, 'Drinking Water', 'droplet'),
(5, 'Flood Lights', 'sun'),
(6, 'Equipment Provided', 'briefcase'),
(7, 'Seating Area', 'users'),
(8, 'Canteen / Cafe', 'coffee');

-- 4. SEED DEMO USERS (Password for all demo accounts: 'admin123')
INSERT IGNORE INTO users (id, full_name, email, phone, password_hash, status) VALUES
(1, 'Super Admin', 'admin@turf.com', '+919876543210', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE'),
(2, 'Rajesh Sharma (Owner)', 'owner@turf.com', '+919876543211', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE'),
(3, 'Kundan Kumar (Player)', 'player@turf.com', '+919876543212', '$2a$10$/QhVuxwBem9QCvSv8yFkfepBkBpBEgUSYumF1fVfRhcv3WlgOXsYy', 'ACTIVE');

-- 5. SEED USER ROLES
INSERT IGNORE INTO user_roles (user_id, role_id) VALUES
(1, 1),
(2, 2),
(3, 4);

-- 6. SEED DEMO VENUES
INSERT IGNORE INTO venues (id, owner_id, name, slug, description, address, city, state, pincode, latitude, longitude, cancellation_policy, rules, status) VALUES
(1, 2, 'ABC Apex Sports Arena', 'abc-apex-sports-arena', 'Premier multi-sport turf facility featuring professional FIFA-approved turf, high-lux flood lights, and spacious air-conditioned changing rooms.', 'Plot 45, Off Link Road, Andheri West', 'Mumbai', 'Maharashtra', '400053', 19.1363, 72.8277, 'Full refund up to 12 hours before slot start time. 50% refund between 6 to 12 hours.', 'Spikes are strictly prohibited on artificial turf. Non-marking shoes required for badminton.', 'APPROVED'),
(2, 2, 'Skyline Turf & Badminton Club', 'skyline-turf-badminton-club', 'State-of-the-art sports arena offering dual box-cricket turfs and 4 indoor BWF-standard synthetic badminton courts.', '100 Feet Ring Road, Indiranagar', 'Bengaluru', 'Karnataka', '560038', 12.9784, 77.6408, 'Full refund up to 24 hours prior to booking.', 'Smoking and alcohol strictly prohibited on premises.', 'APPROVED');

-- 7. SEED VENUE IMAGES
INSERT IGNORE INTO venue_images (id, venue_id, image_url, is_primary, sort_order) VALUES
(1, 1, 'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80', 1, 1),
(2, 1, 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80', 0, 2),
(3, 2, 'https://images.unsplash.com/photo-1626248801379-51a0748a5f96?auto=format&fit=crop&w=1200&q=80', 1, 1);

-- 8. SEED VENUE AMENITIES & SPORTS
INSERT IGNORE INTO venue_amenities (venue_id, amenity_id) VALUES
(1, 1), (1, 2), (1, 3), (1, 4), (1, 5), (1, 6), (1, 7), (1, 8),
(2, 1), (2, 2), (2, 4), (2, 5), (2, 8);

INSERT IGNORE INTO venue_sports (venue_id, sport_id) VALUES
(1, 1), (1, 2),
(2, 1), (2, 3);

-- 9. SEED COURTS
INSERT IGNORE INTO courts (id, venue_id, sport_id, name, surface_type, slot_duration_minutes, base_price_per_hour, status) VALUES
(1, 1, 1, 'Cricket Turf 1 (Pro Pitch)', 'Artificial Turf with Box Netting', 60, 1400.00, 'ACTIVE'),
(2, 1, 1, 'Cricket Turf 2 (Standard)', 'Artificial Turf', 60, 1200.00, 'ACTIVE'),
(3, 1, 2, 'Main Football Pitch 7v7', 'FIFA Grade 40mm Turf', 60, 2000.00, 'ACTIVE'),
(4, 2, 3, 'Badminton Synthetic Court 1', 'BWF Approved Wooden Mat', 60, 500.00, 'ACTIVE'),
(5, 2, 3, 'Badminton Synthetic Court 2', 'BWF Approved Wooden Mat', 60, 500.00, 'ACTIVE');

-- 10. SEED OPERATING HOURS FOR COURTS (6 AM to 11 PM)
INSERT IGNORE INTO court_operating_hours (court_id, day_of_week, open_time, close_time, is_closed) VALUES
(1, 0, '06:00:00', '23:00:00', 0), (1, 1, '06:00:00', '23:00:00', 0), (1, 2, '06:00:00', '23:00:00', 0), (1, 3, '06:00:00', '23:00:00', 0), (1, 4, '06:00:00', '23:00:00', 0), (1, 5, '06:00:00', '23:00:00', 0), (1, 6, '06:00:00', '23:00:00', 0),
(2, 0, '06:00:00', '23:00:00', 0), (2, 1, '06:00:00', '23:00:00', 0), (2, 2, '06:00:00', '23:00:00', 0), (2, 3, '06:00:00', '23:00:00', 0), (2, 4, '06:00:00', '23:00:00', 0), (2, 5, '06:00:00', '23:00:00', 0), (2, 6, '06:00:00', '23:00:00', 0),
(3, 0, '06:00:00', '23:00:00', 0), (3, 1, '06:00:00', '23:00:00', 0), (3, 2, '06:00:00', '23:00:00', 0), (3, 3, '06:00:00', '23:00:00', 0), (3, 4, '06:00:00', '23:00:00', 0), (3, 5, '06:00:00', '23:00:00', 0), (3, 6, '06:00:00', '23:00:00', 0);

-- 11. SEED COUPONS
INSERT IGNORE INTO coupons (id, venue_id, code, discount_type, discount_value, min_booking_amount, max_discount_amount, valid_from, valid_until, usage_limit, is_active) VALUES
(1, NULL, 'WELCOME20', 'PERCENTAGE', 20.00, 500.00, 300.00, '2026-01-01', '2026-12-31', 1000, 1),
(2, 1, 'APEX50', 'FIXED', 50.00, 1000.00, 50.00, '2026-01-01', '2026-12-31', 500, 1);
