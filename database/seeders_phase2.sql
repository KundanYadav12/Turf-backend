-- Sports Booking & Management Platform - Phase 2 Demo Seeders

USE turf_sports_db;

-- 1. SEED TEAMS (Public IDs formatted as team_<ulid>)
INSERT IGNORE INTO teams (id, public_id, sport_id, name, short_name, slug, logo_url, city, status) VALUES
(1, 'team_01J9CRIC01MUMBAIBLASTERS', 1, 'Mumbai Blasters', 'MB', 'mumbai-blasters', 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=200&q=80', 'Mumbai', 'ACTIVE'),
(2, 'team_01J9CRIC02ANDHERIACES', 1, 'Andheri Aces', 'AA', 'andheri-aces', 'https://images.unsplash.com/photo-1531415074868-036b107e7752?auto=format&fit=crop&w=200&q=80', 'Mumbai', 'ACTIVE'),
(3, 'team_01J9CRIC03BANDRABULLS', 1, 'Bandra Bulls', 'BB', 'bandra-bulls', 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=200&q=80', 'Mumbai', 'ACTIVE'),
(4, 'team_01J9CRIC04THANEWARRIORS', 1, 'Thane Warriors', 'TW', 'thane-warriors', 'https://images.unsplash.com/photo-1512719994953-9ab1b2001525?auto=format&fit=crop&w=200&q=80', 'Mumbai', 'ACTIVE'),
(5, 'team_01J9FOOT05PUNEPANTHERS', 2, 'Pune Panthers FC', 'PPFC', 'pune-panthers-fc', 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=200&q=80', 'Pune', 'ACTIVE'),
(6, 'team_01J9FOOT06DECCANDYNAMOS', 2, 'Deccan Dynamos', 'DD', 'deccan-dynamos', 'https://images.unsplash.com/photo-1517649763962-0c623266ddc0?auto=format&fit=crop&w=200&q=80', 'Pune', 'ACTIVE'),
(7, 'team_01J9BADM07BLRSHUTTLERS', 3, 'Bengaluru Shuttlers', 'BS', 'bengaluru-shuttlers', 'https://images.unsplash.com/photo-1626248801379-51a0748a5f96?auto=format&fit=crop&w=200&q=80', 'Bengaluru', 'ACTIVE'),
(8, 'team_01J9BADM08INDIRANAGARSMASH', 3, 'Indiranagar Smashers', 'IS', 'indiranagar-smashers', 'https://images.unsplash.com/photo-1521537634581-0dced2fee2ef?auto=format&fit=crop&w=200&q=80', 'Bengaluru', 'ACTIVE');

-- 2. SEED MULTI-CITY TOURNAMENTS
INSERT IGNORE INTO tournaments (id, public_id, sport_id, organizer_id, name, slug, description, format, city, banner_url, max_teams, registered_teams_count, start_date, end_date, status, rules_and_regulations) VALUES
(1, 'trn_01J9MUMBAIPREMIER2026', 1, 1, 'Mumbai Box Cricket League 2026', 'mumbai-box-cricket-league-2026', 'Premier floodlit corporate & open box cricket tournament hosted across Mumbai Apex Sports Arena.', 'KNOCKOUT', 'Mumbai', 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80', 16, 4, CURRENT_DATE(), DATE_ADD(CURRENT_DATE(), INTERVAL 5 DAY), 'ONGOING', '10 overs per side. Spikes strictly banned. 6 players per side.'),
(2, 'trn_01J9PUNEFOOTBALLCUP2026', 2, 1, 'Pune Monsoon Futsal Championship', 'pune-monsoon-futsal-championship', 'High-intensity 5v5 floodlit futsal clash featuring top Pune regional football academies.', 'LEAGUE_KNOCKOUT', 'Pune', 'https://images.unsplash.com/photo-1574629810360-7efbbe195018?auto=format&fit=crop&w=1200&q=80', 12, 2, CURRENT_DATE(), DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY), 'ONGOING', '20-minute halves. Rolling substitutions allowed.'),
(3, 'trn_01J9BLRBADMINTONOPEN2026', 3, 1, 'Bangalore BWF Open Masters', 'bangalore-bwf-open-masters', 'State championship on BWF synthetic indoor courts with live digital line tracking.', 'KNOCKOUT', 'Bengaluru', 'https://images.unsplash.com/photo-1626248801379-51a0748a5f96?auto=format&fit=crop&w=1200&q=80', 32, 2, CURRENT_DATE(), DATE_ADD(CURRENT_DATE(), INTERVAL 2 DAY), 'ONGOING', 'Best of 3 sets to 21 points. Feather shuttlecocks provided.'),
(4, 'trn_01J9DELHICRICKETLEAGUE2026', 1, 1, 'Delhi Super Bash Cup', 'delhi-super-bash-cup', 'Fast-paced T10 box tournament in New Delhi.', 'KNOCKOUT', 'Delhi', 'https://images.unsplash.com/photo-1531415074868-036b107e7752?auto=format&fit=crop&w=1200&q=80', 16, 0, DATE_ADD(CURRENT_DATE(), INTERVAL 2 DAY), DATE_ADD(CURRENT_DATE(), INTERVAL 10 DAY), 'REGISTRATION_OPEN', 'Open age category.');

-- 3. TOURNAMENT VENUES
INSERT IGNORE INTO tournament_venues (tournament_id, venue_id) VALUES
(1, 1),
(2, 1),
(3, 2),
(4, 1);

-- 4. TOURNAMENT TEAMS
INSERT IGNORE INTO tournament_teams (tournament_id, team_id, registration_status, seed_number) VALUES
(1, 1, 'APPROVED', 1),
(1, 2, 'APPROVED', 2),
(1, 3, 'APPROVED', 3),
(1, 4, 'APPROVED', 4),
(2, 5, 'APPROVED', 1),
(2, 6, 'APPROVED', 2),
(3, 7, 'APPROVED', 1),
(3, 8, 'APPROVED', 2);

-- 5. TOURNAMENT ROUNDS
INSERT IGNORE INTO tournament_rounds (id, tournament_id, round_number, name, round_type, sequence_order) VALUES
(1, 1, 1, 'Semi Final 1', 'SEMI_FINAL', 1),
(2, 1, 2, 'Semi Final 2', 'SEMI_FINAL', 2),
(3, 1, 3, 'Grand Finale', 'FINAL', 3),
(4, 2, 1, 'Group Match A', 'GROUP', 1),
(5, 3, 1, 'Quarter Final 1', 'QUARTER_FINAL', 1);

-- 6. MATCHES (Simultaneous Live Matches across Courts & Tournaments)
INSERT IGNORE INTO matches (
    id, public_id, tournament_id, round_id, venue_id, court_id,
    team_a_id, team_b_id, match_number, scheduled_date, scheduled_start, scheduled_end,
    status, live_score_summary, live_subtext, sport_state
) VALUES
-- Tournament 1 Match 1 on Court 1 (Cricket LIVE)
(1, 'mtc_01J9M1CRICKETMUMBAI01', 1, 1, 1, 1,
 1, 2, 1, CURRENT_DATE(), '19:00:00', '20:30:00',
 'LIVE', '142/3 (16.2 ov)', 'Bandra Blasters need 36 runs in 22 balls | CRR 8.70',
 JSON_OBJECT(
     'sport', 'cricket',
     'currentInnings', 2,
     'teamABatting', true,
     'runs', 142,
     'wickets', 3,
     'overs', '16.2',
     'target', 178,
     'striker', JSON_OBJECT('name', 'Rohit S.', 'runs', 54, 'balls', 28, 'fours', 5, 'sixes', 3),
     'nonStriker', JSON_OBJECT('name', 'Kunal P.', 'runs', 22, 'balls', 14, 'fours', 2, 'sixes', 1),
     'bowler', JSON_OBJECT('name', 'Vikram J.', 'overs', '3.2', 'maidens', 0, 'runs', 31, 'wickets', 1)
 )),

-- Tournament 1 Match 2 on Court 2 (Cricket LIVE simultaneously)
(2, 'mtc_01J9M2CRICKETMUMBAI02', 1, 2, 1, 2,
 3, 4, 2, CURRENT_DATE(), '19:00:00', '20:30:00',
 'LIVE', '98/2 (11.0 ov)', 'Thane Warriors elected to bowl | 1st Innings',
 JSON_OBJECT(
     'sport', 'cricket',
     'currentInnings', 1,
     'teamABatting', true,
     'runs', 98,
     'wickets', 2,
     'overs', '11.0',
     'target', null,
     'striker', JSON_OBJECT('name', 'Aditya M.', 'runs', 41, 'balls', 26, 'fours', 4, 'sixes', 2),
     'nonStriker', JSON_OBJECT('name', 'Deepak N.', 'runs', 18, 'balls', 15, 'fours', 1, 'sixes', 0),
     'bowler', JSON_OBJECT('name', 'Sanjay R.', 'overs', '2.0', 'maidens', 0, 'runs', 14, 'wickets', 0)
 )),

-- Tournament 2 Match 1 in Pune (Football LIVE simultaneously)
(3, 'mtc_01J9M3FOOTBALLPUNE01', 2, 4, 1, 1,
 5, 6, 1, CURRENT_DATE(), '19:00:00', '20:00:00',
 'LIVE', '2 - 1', '68\' 2nd Half | Pune Panthers FC leading',
 JSON_OBJECT(
     'sport', 'football',
     'homeScore', 2,
     'awayScore', 1,
     'minute', 68,
     'period', '2nd Half',
     'homeScorers', JSON_ARRAY('A. Deshmukh 24\'', 'R. Kadam 58\''),
     'awayScorers', JSON_ARRAY('T. Shaikh 41\'')
 )),

-- Tournament 3 Match 1 in Bangalore (Badminton LIVE simultaneously)
(4, 'mtc_01J9M4BADMINTONBLR01', 3, 5, 2, 1,
 7, 8, 1, CURRENT_DATE(), '19:00:00', '20:00:00',
 'LIVE', 'Set 2: 19 - 18', 'Bengaluru Shuttlers won Set 1 (21-16)',
 JSON_OBJECT(
     'sport', 'badminton',
     'set1', '21 - 16',
     'set2', '19 - 18',
     'currentSet', 2,
     'server', 'A. Sen',
     'receiver', 'P. Kashyap'
 ));

-- 7. DEMO SCORE EVENTS FOR MATCH 1 (Cricket)
INSERT IGNORE INTO score_events (match_id, sequence_number, period_or_innings, unit_time, event_type, score_delta, raw_payload, commentary_text) VALUES
(1, 1, 2, '16.0', 'SINGLE', 1, JSON_OBJECT('runs', 1), 'Tapped towards mid-on for a quick single.'),
(1, 2, 2, '16.1', 'FOUR', 4, JSON_OBJECT('runs', 4), 'Cracking cover drive! Pierces the gap to find the fence.'),
(1, 3, 2, '16.2', 'SIX', 6, JSON_OBJECT('runs', 6), 'DISPATCHED! High, handsome and deep over the long-on boundary for a colossal six!');
