const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI } = require('../config/streamingConfig');

/**
 * Extracts a YouTube Video ID from any standard YouTube URL or ID string.
 * Supports:
 * - https://studio.youtube.com/video/VIDEO_ID/livestreaming (YouTube Studio livestream)
 * - https://www.youtube.com/watch?v=VIDEO_ID
 * - https://youtu.be/VIDEO_ID
 * - https://youtube.com/live/VIDEO_ID
 * - https://www.youtube.com/embed/VIDEO_ID
 * - https://www.youtube.com/shorts/VIDEO_ID
 * - Direct 11-character video ID
 * - HTML iframe tags (extracts src attribute)
 */
function extractYouTubeVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  let trimmed = input.trim();

  // Strip wrapping quotes if any
  trimmed = trimmed.replace(/^["']|["']$/g, '');

  // If someone pasted an iframe tag: extract the src URL
  const iframeMatch = trimmed.match(/src=["']([^"']+)["']/i);
  if (iframeMatch) {
    trimmed = iframeMatch[1];
  }

  // 1. Direct 11-character video ID (e.g. RG7ws07JlY4)
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // 2. YouTube Studio livestreaming URL: studio.youtube.com/video/VIDEO_ID(/livestreaming)?
  const studioMatch = trimmed.match(/studio\.youtube\.com\/video\/([a-zA-Z0-9_-]{11})/i);
  if (studioMatch) return studioMatch[1];

  // 3. youtube.com/live/VIDEO_ID
  const liveMatch = trimmed.match(/(?:youtube\.com|youtube-nocookie\.com)\/live\/([a-zA-Z0-9_-]{11})/i);
  if (liveMatch) return liveMatch[1];

  // 4. youtu.be/VIDEO_ID
  const shortMatch = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/i);
  if (shortMatch) return shortMatch[1];

  // 5. youtube.com/watch?v=VIDEO_ID
  const watchMatch = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{11})/i);
  if (watchMatch) return watchMatch[1];

  // 6. youtube.com/embed/VIDEO_ID
  const embedMatch = trimmed.match(/(?:youtube\.com|youtube-nocookie\.com)\/embed\/([a-zA-Z0-9_-]{11})/i);
  if (embedMatch) return embedMatch[1];

  // 7. youtube.com/shorts/VIDEO_ID
  const shortsMatch = trimmed.match(/(?:youtube\.com|youtube-nocookie\.com)\/shorts\/([a-zA-Z0-9_-]{11})/i);
  if (shortsMatch) return shortsMatch[1];

  // 8. General fallback for any URL containing /video/VIDEO_ID or /v/VIDEO_ID
  const genericMatch = trimmed.match(/(?:\/video\/|\/v\/)([a-zA-Z0-9_-]{11})/i);
  if (genericMatch) return genericMatch[1];

  return null;
}

/**
 * Checks if input is an RTMP ingest URL or stream key (e.g. ybv0-8u28-zqys-uc64-1xuf)
 */
function isYouTubeStreamKeyOrRtmp(input) {
  if (!input || typeof input !== 'string') return false;
  const trimmed = input.trim();
  const isKey = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(trimmed);
  const isRtmp = /^rtmps?:\/\//i.test(trimmed);
  return isKey || isRtmp;
}

/**
 * Generates an embeddable YouTube player URL with modern parameters.
 */
function getYouTubeEmbedUrl(videoId) {
  if (!videoId) return null;
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=0&rel=0&modestbranding=1&playsinline=1&enablejsapi=1`;
}

/**
 * Generates Google OAuth 2.0 Authorization URL for YouTube Live Streaming API
 */
function getYouTubeAuthUrl(state) {
  if (!YOUTUBE_CLIENT_ID) {
    return null;
  }

  const scopes = [
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl'
  ].join(' ');

  const params = new URLSearchParams({
    client_id: YOUTUBE_CLIENT_ID,
    redirect_uri: YOUTUBE_REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    state: state || 'turf_stream_oauth'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchanges OAuth authorization code for Access & Refresh tokens.
 */
async function exchangeCodeForTokens(code) {
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    throw new Error('YouTube OAuth credentials (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET) are not configured.');
  }

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const body = new URLSearchParams({
    code,
    client_id: YOUTUBE_CLIENT_ID,
    client_secret: YOUTUBE_CLIENT_SECRET,
    redirect_uri: YOUTUBE_REDIRECT_URI,
    grant_type: 'authorization_code'
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.error || 'Failed to exchange YouTube authorization code.');
  }

  return {
    accessToken: data.access_type || data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    scope: data.scope,
    tokenType: data.token_type
  };
}

/**
 * YouTube integration checklist & requirements guide
 */
function getYouTubeSetupInstructions() {
  return {
    title: 'YouTube Live Setup & Requirements Guide',
    requirements: [
      {
        step: 1,
        title: 'Enable Live Streaming on YouTube',
        description: 'Your YouTube channel must have Live Streaming enabled. If this is your first time, YouTube requires up to 24 hours to activate live streaming.'
      },
      {
        step: 2,
        title: 'Channel Phone Verification',
        description: 'Your Google Account must be phone-verified to access YouTube live streaming features.'
      },
      {
        step: 3,
        title: 'Stream Linking (Instant)',
        description: 'You can start a live stream in YouTube Studio (or OBS) and paste your YouTube Live URL directly into Turf Project for instant viewer integration.'
      },
      {
        step: 4,
        title: 'Direct API Broadcast Creation (Optional)',
        description: 'To create broadcasts directly from Turf, set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in server environment variables and connect your account via OAuth.'
      }
    ],
    supportedUrlFormats: [
      'https://studio.youtube.com/video/VIDEO_ID/livestreaming',
      'https://www.youtube.com/watch?v=VIDEO_ID',
      'https://www.youtube.com/live/VIDEO_ID',
      'https://youtu.be/VIDEO_ID',
      'VIDEO_ID (11 characters)'
    ]
  };
}

module.exports = {
  extractYouTubeVideoId,
  isYouTubeStreamKeyOrRtmp,
  getYouTubeEmbedUrl,
  getYouTubeAuthUrl,
  exchangeCodeForTokens,
  getYouTubeSetupInstructions
};
