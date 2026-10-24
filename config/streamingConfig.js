/**
 * Streaming Configuration & Constants
 */
const RTMP_BASE_URL = process.env.STREAMING_RTMP_INGEST_URL || process.env.RTMP_INGEST_URL || 'rtmp://playzo.duckdns.org/live';
const HLS_BASE_URL = process.env.STREAMING_HLS_PLAYBACK_URL || process.env.HLS_PLAYBACK_URL || 'https://playzo.duckdns.org/hls';

// Public WebRTC STUN/TURN ICE Servers
const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

module.exports = {
  RTMP_BASE_URL,
  HLS_BASE_URL,
  DEFAULT_ICE_SERVERS,
  YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID || '',
  YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET || '',
  YOUTUBE_REDIRECT_URI: process.env.YOUTUBE_REDIRECT_URI || 'http://localhost:5008/api/streams/youtube/oauth2callback',
  DEFAULT_OVERLAY_CONFIG: {
    enabled: true,
    theme: 'modern_dark', // 'modern_dark' | 'glassmorphism' | 'broadcast_pro' | 'vibrant'
    position: 'bottom', // 'bottom' | 'top'
    showTeamLogos: true,
    showBallByBall: true,
    showTournamentName: true,
    showMatchTimer: true,
    opacity: 0.95
  }
};
