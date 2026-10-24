const express = require('express');
const router = express.Router();
const streamService = require('../services/streamService');
const youtubeStreamService = require('../services/youtubeStreamService');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');

// 1. GET /api/matches/:matchId/stream - Get stream details (Public info for viewers, Private for managers)
router.get('/:matchId/stream', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.getMatchStream(req.params.matchId, req.user);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 2. POST /api/matches/:matchId/stream & /init - Initialize or configure stream (Organizer only)
router.post(['/:matchId/stream', '/:matchId/stream/init'], authenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.initializeStream(req.params.matchId, req.user, req.body);
    res.json({ success: true, message: 'Stream configured successfully.', data });
  } catch (error) {
    next(error);
  }
});

// 2b. POST /api/matches/:matchId/stream/youtube - Link YouTube Live stream
router.post('/:matchId/stream/youtube', authenticateUser, async (req, res, next) => {
  try {
    const { youtubeUrl, title, privacy } = req.body;
    const data = await streamService.initializeStream(req.params.matchId, req.user, {
      streamingMethod: 'YOUTUBE',
      youtubeUrl,
      title,
      privacy
    });
    // Immediately set to LIVE when linking YouTube broadcast
    const liveData = await streamService.updateStreamStatus(req.params.matchId, req.user, { status: 'LIVE' });
    res.json({ success: true, message: 'YouTube stream linked and set to LIVE.', data: liveData });
  } catch (error) {
    next(error);
  }
});

// 3. PUT /api/matches/:matchId/stream/status - Update stream lifecycle (PREVIEW, LIVE, PAUSED, ENDED)
router.put('/:matchId/stream/status', authenticateUser, async (req, res, next) => {
  try {
    const { status } = req.body;
    const data = await streamService.updateStreamStatus(req.params.matchId, req.user, { status });
    res.json({ success: true, message: `Stream status updated to ${status}.`, data });
  } catch (error) {
    next(error);
  }
});

// 3b. POST action shortcuts for stream lifecycle (start, pause, resume, end)
router.post('/:matchId/stream/start', authenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.updateStreamStatus(req.params.matchId, req.user, { status: 'LIVE' });
    res.json({ success: true, message: 'Stream is now LIVE.', data });
  } catch (error) {
    next(error);
  }
});

router.post('/:matchId/stream/pause', authenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.updateStreamStatus(req.params.matchId, req.user, { status: 'PAUSED' });
    res.json({ success: true, message: 'Stream is PAUSED.', data });
  } catch (error) {
    next(error);
  }
});

router.post('/:matchId/stream/resume', authenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.updateStreamStatus(req.params.matchId, req.user, { status: 'LIVE' });
    res.json({ success: true, message: 'Stream is RESUMED.', data });
  } catch (error) {
    next(error);
  }
});

router.post('/:matchId/stream/end', authenticateUser, async (req, res, next) => {
  try {
    const data = await streamService.updateStreamStatus(req.params.matchId, req.user, { status: 'ENDED' });
    res.json({ success: true, message: 'Stream has ENDED.', data });
  } catch (error) {
    next(error);
  }
});

// 4. POST /api/matches/:matchId/stream/regenerate-key - Regenerate stream key for external RTMP
router.post('/:matchId/stream/regenerate-key', authenticateUser, async (req, res, next) => {
  try {
    const result = await streamService.regenerateStreamKey(req.params.matchId, req.user);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 5. PUT / PATCH /api/matches/:matchId/stream/overlay - Update overlay styling/config
router.all('/:matchId/stream/overlay', authenticateUser, async (req, res, next) => {
  if (req.method !== 'PUT' && req.method !== 'PATCH') return next();
  try {
    const result = await streamService.updateOverlayConfig(req.params.matchId, req.user, req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 6. GET /api/matches/:matchId/stream/overlay-data & /:matchId/overlay-data - Lightweight endpoint for OBS Browser Source overlay
router.get(['/:matchId/stream/overlay-data', '/:matchId/overlay-data'], async (req, res, next) => {
  try {
    const data = await streamService.getOBSOverlayData(req.params.matchId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 7. GET /api/streams/live & /api/streams/active - List all active broadcasts across the platform
router.get(['/live', '/active'], async (req, res, next) => {
  try {
    const data = await streamService.getActiveLiveStreams();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 8. GET /api/streams/youtube/instructions - YouTube setup guide
router.get('/youtube/instructions', (req, res) => {
  const guide = youtubeStreamService.getYouTubeSetupInstructions();
  res.json({ success: true, data: guide });
});

// 9. GET /api/streams/youtube/auth-url - Generate Google OAuth URL for YouTube API
router.get('/youtube/auth-url', authenticateUser, (req, res) => {
  const state = `stream_${req.query.matchId || 'general'}_${req.user.id}`;
  const authUrl = youtubeStreamService.getYouTubeAuthUrl(state);
  if (!authUrl) {
    return res.status(400).json({
      success: false,
      message: 'YouTube OAuth credentials (YOUTUBE_CLIENT_ID) are not configured on the server. You can still use the direct YouTube Live URL linking method.'
    });
  }
  res.json({ success: true, authUrl });
});

// 10. GET /api/streams/health & /api/matches/:matchId/stream/health - Super Admin Streaming Health Diagnostics
router.get(['/health', '/:matchId/stream/health'], optionalAuthenticateUser, async (req, res, next) => {
  try {
    const health = await streamService.getStreamingHealth(req.user);
    res.json({ success: true, data: health });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
