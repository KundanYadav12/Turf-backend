/**
 * Streaming Configuration & Constants
 * Supports Mobile Camera WebRTC, External RTMP/OBS, and YouTube Live.
 */

const RTMP_BASE_URL = process.env.STREAMING_RTMP_INGEST_URL || process.env.RTMP_INGEST_URL || 'rtmp://playzo.duckdns.org/live';
const HLS_BASE_URL = process.env.STREAMING_HLS_PLAYBACK_URL || process.env.HLS_PLAYBACK_URL || 'https://playzo.duckdns.org/hls';

function getIceServers() {
  if (process.env.WEBRTC_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.WEBRTC_ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.warn('[StreamingConfig] Failed to parse WEBRTC_ICE_SERVERS JSON:', e.message);
    }
  }

  const servers = [
    { urls: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ];

  if (process.env.TURN_SERVER_URL) {
    servers.push({
      urls: process.env.TURN_SERVER_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }

  return servers;
}

const DEFAULT_ICE_SERVERS = getIceServers();

const DEFAULT_OVERLAY_CONFIG = {
  enabled: true,
  theme: 'modern_dark', // 'modern_dark' | 'glassmorphism' | 'broadcast_pro' | 'vibrant'
  position: 'bottom', // 'bottom' | 'top'
  showTeamLogos: true,
  showBallByBall: true,
  showTournamentName: true,
  showMatchTimer: true,
  opacity: 0.95
};

module.exports = {
  RTMP_BASE_URL,
  HLS_BASE_URL,
  DEFAULT_ICE_SERVERS,
  getIceServers,
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || '',
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || '',
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI || 'https://playzo.duckdns.org/api/streams/youtube/oauth2callback',
  DEFAULT_OVERLAY_CONFIG
};
