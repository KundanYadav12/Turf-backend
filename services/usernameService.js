const db = require('../config/database');

const RESERVED_USERNAMES = new Set([
  'admin',
  'administrator',
  'system',
  'api',
  'turf',
  'turfspot',
  'support',
  'help',
  'moderator',
  'owner',
  'root',
  'auth',
  'login',
  'register',
  'public',
  'display',
  'matches',
  'tournaments',
  'teams',
  'players'
]);

/**
 * Normalizes username to canonical lowercase format.
 */
function normalizeUsername(username = '') {
  return String(username)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Validates username syntax rules:
 * - 3 to 30 characters
 * - lowercase alphanumeric and single underscores
 * - cannot be solely numeric
 * - cannot be a reserved system name
 */
function validateUsernameFormat(username) {
  if (typeof username !== 'string') {
    return { valid: false, reason: 'Username must be a valid string.' };
  }
  const raw = username.trim();
  if (!/^[a-zA-Z0-9_]+$/.test(raw)) {
    return { valid: false, reason: 'Username can only contain letters, numbers, and underscores.' };
  }
  const normalized = normalizeUsername(raw);

  if (!normalized || normalized.length < 3) {
    return { valid: false, reason: 'Username must be at least 3 characters long.' };
  }
  if (normalized.length > 30) {
    return { valid: false, reason: 'Username cannot exceed 30 characters.' };
  }
  if (/^\d+$/.test(normalized)) {
    return { valid: false, reason: 'Username cannot be purely numbers.' };
  }
  if (RESERVED_USERNAMES.has(normalized)) {
    return { valid: false, reason: 'This username is reserved by the platform. Please choose another.' };
  }

  return { valid: true, normalized };
}

/**
 * Checks if normalized username is available, excluding an optional userId (e.g. for profile update).
 */
async function checkUsernameAvailability(rawUsername, excludeUserId = null) {
  const validation = validateUsernameFormat(rawUsername);
  if (!validation.valid) {
    return {
      valid: false,
      available: false,
      normalized: validation.normalized || '',
      reason: validation.reason,
      suggestions: []
    };
  }

  const normalized = validation.normalized;

  let sql = 'SELECT id FROM users WHERE LOWER(username) = ?';
  const params = [normalized];

  if (excludeUserId) {
    sql += ' AND id != ?';
    params.push(excludeUserId);
  }

  const existing = await db.query(sql, params);
  const isAvailable = existing.length === 0;

  let suggestions = [];
  if (!isAvailable) {
    suggestions = await generateUsernameSuggestions(normalized);
  }

  return {
    valid: true,
    available: isAvailable,
    normalized,
    reason: isAvailable ? null : 'This username is already taken. Please choose another username.',
    suggestions
  };
}

/**
 * Generates available, unique username suggestions based on input.
 */
async function generateUsernameSuggestions(baseUsername) {
  const currentYear = new Date().getFullYear();
  const shortYear = String(currentYear).slice(-2);

  const candidateTemplates = [
    `${baseUsername}_${shortYear}`,
    `${baseUsername}_07`,
    `${baseUsername}_10`,
    `${baseUsername}_pro`,
    `${baseUsername}_official`,
    `${baseUsername}_in`,
    `${baseUsername}_${Math.floor(10 + Math.random() * 89)}`
  ];

  const suggestions = [];

  for (const cand of candidateTemplates) {
    if (suggestions.length >= 3) break;
    const norm = normalizeUsername(cand);
    const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [norm]);
    if (existing.length === 0 && !RESERVED_USERNAMES.has(norm)) {
      suggestions.push(norm);
    }
  }

  return suggestions;
}

module.exports = {
  normalizeUsername,
  validateUsernameFormat,
  checkUsernameAvailability,
  generateUsernameSuggestions
};
