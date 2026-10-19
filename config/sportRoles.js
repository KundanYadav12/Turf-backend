/**
 * Centralized Sport Roles Configuration (Backend)
 * 
 * Single source of truth for sport positions, role definitions, and validation.
 */

const SPORT_ROLES = {
  cricket: [
    'Batsman',
    'Bowler',
    'All-Rounder',
    'Wicketkeeper',
    'Wicketkeeper-Batsman'
  ],
  football: [
    'Goalkeeper',
    'Defender',
    'Midfielder',
    'Forward',
    'Striker'
  ],
  badminton: [
    'Singles Player',
    'Doubles Player',
    'Substitute'
  ],
  tennis: [
    'Singles Player',
    'Doubles Player',
    'Substitute'
  ],
  pickleball: [
    'Singles Player',
    'Doubles Player',
    'Substitute'
  ],
  'table-tennis': [
    'Singles Player',
    'Doubles Player',
    'Substitute'
  ],
  basketball: [
    'Point Guard',
    'Shooting Guard',
    'Small Forward',
    'Power Forward',
    'Center'
  ],
  volleyball: [
    'Setter',
    'Outside Hitter',
    'Opposite Hitter',
    'Middle Blocker',
    'Libero',
    'Defensive Specialist'
  ],
  kabaddi: [
    'Raider',
    'Corner Defender',
    'Cover Defender',
    'All-Rounder'
  ],
  default: [
    'Player'
  ]
};

function normalizeSportSlug(sport) {
  if (!sport) return 'default';
  if (typeof sport === 'object') {
    return (sport.slug || sport.name || '').toLowerCase().trim();
  }
  const clean = String(sport).toLowerCase().trim();
  if (clean.includes('cricket')) return 'cricket';
  if (clean.includes('football') || clean.includes('soccer')) return 'football';
  if (clean.includes('badminton')) return 'badminton';
  if (clean.includes('tennis') && !clean.includes('table')) return 'tennis';
  if (clean.includes('table') || clean.includes('ping')) return 'table-tennis';
  if (clean.includes('pickleball')) return 'pickleball';
  if (clean.includes('basketball')) return 'basketball';
  if (clean.includes('volleyball')) return 'volleyball';
  if (clean.includes('kabaddi')) return 'kabaddi';
  return clean || 'default';
}

function getSportRoles(sport) {
  const slug = normalizeSportSlug(sport);
  return SPORT_ROLES[slug] || SPORT_ROLES.default;
}

function isValidRole(sport, roleName) {
  if (!roleName) return true; // optional
  const allowed = getSportRoles(sport);
  const clean = roleName.trim().toLowerCase();
  return allowed.some(r => r.toLowerCase() === clean) || clean === 'player';
}

module.exports = {
  SPORT_ROLES,
  normalizeSportSlug,
  getSportRoles,
  isValidRole
};
