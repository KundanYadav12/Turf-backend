/**
 * Centralized Domain & Public URL Configuration (Backend)
 * Reads base domains from environment variables with safe fallbacks and trailing-slash normalization.
 */

const normalizeUrl = (url, fallback = '') => {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    return fallback;
  }
  return url.trim().replace(/\/+$/, '');
};

// 1. Centralized Public Web Application URL
const APP_URL = normalizeUrl(
  process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL,
  'https://playzo.duckdns.org'
);

// 2. Centralized Public API URL (e.g. https://playzo.duckdns.org/api)
const API_PUBLIC_URL = normalizeUrl(
  process.env.API_PUBLIC_URL || `${APP_URL}/api`,
  'https://playzo.duckdns.org/api'
);

// 3. Server Port
const PORT = parseInt(process.env.PORT || '5008', 10);

// 4. Trusted CORS & Socket.IO Origins
const parseOrigins = () => {
  const defaults = [
    APP_URL,
    'https://playzo.duckdns.org',
    'http://playzo.duckdns.org',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5008',
    'http://localhost:5173',
    'http://localhost:8081',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://10.0.2.2:5008' // Android Emulator
  ];

  if (process.env.CORS_ORIGIN) {
    const custom = process.env.CORS_ORIGIN.split(',').map(s => normalizeUrl(s.trim())).filter(Boolean);
    defaults.push(...custom);
  }

  return Array.from(new Set(defaults));
};

const TRUSTED_ORIGINS = parseOrigins();

/**
 * Builds an absolute public URL with path cleanly normalized
 * @param {string} path - e.g. '/tournaments' or 'venue/1'
 * @returns {string} - e.g. 'https://playzo.duckdns.org/tournaments'
 */
const buildPublicUrl = (path = '') => {
  if (!path || path === '/') return APP_URL;
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${APP_URL}${cleanPath}`;
};

/**
 * Builds an absolute public API URL
 * @param {string} endpoint - e.g. '/auth/login'
 * @returns {string} - e.g. 'https://playzo.duckdns.org/api/auth/login'
 */
const buildPublicApiUrl = (endpoint = '') => {
  if (!endpoint || endpoint === '/') return API_PUBLIC_URL;
  const clean = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${API_PUBLIC_URL}${clean}`;
};

/**
 * Builds an absolute public asset/upload URL
 * @param {string} assetPath - e.g. '/uploads/avatars/user.webp'
 * @returns {string}
 */
const buildPublicAssetUrl = (assetPath = '') => {
  if (!assetPath) return '';
  if (assetPath.startsWith('http://') || assetPath.startsWith('https://')) {
    return assetPath;
  }
  const clean = assetPath.startsWith('/') ? assetPath : `/${assetPath}`;
  return `${APP_URL}${clean}`;
};

module.exports = {
  APP_URL,
  API_PUBLIC_URL,
  PORT,
  TRUSTED_ORIGINS,
  buildPublicUrl,
  buildPublicApiUrl,
  buildPublicAssetUrl
};
