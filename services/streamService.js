const crypto = require('crypto');
const db = require('../config/database');
const {
  RTMP_BASE_URL,
  HLS_BASE_URL,
  DEFAULT_ICE_SERVERS,
  getIceServers,
  DEFAULT_OVERLAY_CONFIG
} = require('../config/streamingConfig');
const { extractYouTubeVideoId, getYouTubeEmbedUrl } = require('./youtubeStreamService');
const { getIO } = require('./socketService');

/**
 * Self-healing schema validation: ensures streaming tables & columns exist
 * Runs automatically on startup to prevent 500 crashes if manual migrations were delayed.
 */
let tablesInitialized = false;
async function ensureStreamingTables() {
  if (tablesInitialized) return;
  try {
    // 1. Create match_streams table if not exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS match_streams (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(64) NOT NULL UNIQUE,
        match_id BIGINT NOT NULL,
        tournament_id BIGINT NULL,
        user_id INT NOT NULL,
        streaming_method ENUM('MOBILE_CAMERA', 'EXTERNAL_RTMP', 'YOUTUBE_LIVE') NOT NULL DEFAULT 'MOBILE_CAMERA',
        status ENUM('IDLE', 'PREVIEW', 'LIVE', 'PAUSED', 'ENDED', 'ERROR') NOT NULL DEFAULT 'IDLE',
        stream_key VARCHAR(128) NULL,
        ingest_url VARCHAR(255) NULL,
        playback_url VARCHAR(500) NULL,
        youtube_broadcast_id VARCHAR(100) NULL,
        youtube_video_id VARCHAR(100) NULL,
        youtube_live_url VARCHAR(500) NULL,
        title VARCHAR(255) NULL,
        description TEXT NULL,
        privacy_status ENUM('PUBLIC', 'UNLISTED', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
        overlay_config JSON NULL,
        viewer_count INT NOT NULL DEFAULT 0,
        peak_viewers INT NOT NULL DEFAULT 0,
        actual_start DATETIME NULL,
        actual_end DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_streams_match (match_id),
        INDEX idx_streams_tournament (tournament_id),
        INDEX idx_streams_status (status),
        INDEX idx_streams_key (stream_key),
        INDEX idx_streams_method (streaming_method)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Create tournament_stream_permissions table if not exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS tournament_stream_permissions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(64) NOT NULL UNIQUE,
        tournament_id INT NOT NULL,
        user_id INT NOT NULL,
        match_id BIGINT NULL,
        granted_by INT NOT NULL,
        scope ENUM('TOURNAMENT', 'MATCH') NOT NULL DEFAULT 'TOURNAMENT',
        status ENUM('ACTIVE', 'REVOKED') NOT NULL DEFAULT 'ACTIVE',
        expires_at DATETIME NULL,
        revoked_at DATETIME NULL,
        revoked_by INT NULL,
        notes VARCHAR(255) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_tsp_tournament (tournament_id),
        INDEX idx_tsp_user (user_id),
        INDEX idx_tsp_match (match_id),
        INDEX idx_tsp_status (status),
        INDEX idx_tsp_scope (scope),
        INDEX idx_tsp_lookup (tournament_id, user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Verify additive columns on tournament_matches
    const cols = await db.query('DESCRIBE tournament_matches');
    const colNames = (cols || []).map((c) => c.Field);

    if (!colNames.includes('has_live_stream')) {
      await db.query('ALTER TABLE tournament_matches ADD COLUMN has_live_stream TINYINT(1) NOT NULL DEFAULT 0');
      console.log('✅ Added has_live_stream column to tournament_matches.');
    }
    if (!colNames.includes('live_stream_id')) {
      await db.query('ALTER TABLE tournament_matches ADD COLUMN live_stream_id BIGINT NULL');
      console.log('✅ Added live_stream_id column to tournament_matches.');
    }

    tablesInitialized = true;
  } catch (err) {
    console.warn('[Streaming] Auto-table verification warning:', err.message);
  }
}

// Auto-run schema check asynchronously on startup
setImmediate(() => {
  ensureStreamingTables()
    .then(() => cleanupStaleStreamsOnStartup())
    .catch((e) => console.warn('[Streaming] Startup init warning:', e.message));
});

/**
 * Clean up dangling LIVE sessions after server restart
 */
async function cleanupStaleStreamsOnStartup() {
  try {
    const staleStreams = await db.query(
      `SELECT id, match_id, uuid FROM match_streams WHERE status IN ('LIVE', 'PREVIEW')`
    );
    if (staleStreams && staleStreams.length > 0) {
      console.log(`[Streaming] Cleaning up ${staleStreams.length} stale stream(s) from previous server run.`);
      await db.query(
        `UPDATE match_streams SET status = 'ENDED', actual_end = NOW() WHERE status IN ('LIVE', 'PREVIEW')`
      );
      for (const s of staleStreams) {
        try {
          await db.query('UPDATE tournament_matches SET has_live_stream = 0 WHERE id = ?', [s.match_id]);
        } catch (e) {}
      }
    }
  } catch (err) {
    // Non-fatal if table doesn't exist yet
  }
}

/**
 * Structured audit logging for stream actions (start, stop, regenerate key, overlay changes)
 */
async function recordStreamAudit({ match, user, actionType, previousState = null, newState = null, notes = '' }) {
  try {
    const roleUpper = String(user?.role || '').toUpperCase();
    console.log('[STREAM_AUDIT]', JSON.stringify({
      action: actionType,
      matchId: match?.public_id || match?.id,
      matchNumber: match?.match_number,
      userId: user?.id,
      userRole: roleUpper,
      notes,
      timestamp: new Date().toISOString()
    }));

    await db.query(
      `INSERT INTO tournament_audit_logs (tournament_id, match_id, action_type, user_id, user_role, previous_state, new_state, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        match.tournament_id || match.t_id,
        match.id,
        actionType,
        user?.id || null,
        roleUpper || 'STREAMER',
        previousState ? JSON.stringify(previousState) : null,
        newState ? JSON.stringify(newState) : null,
        notes
      ]
    );
  } catch (err) {
    // Non-fatal if audit table does not exist or insert fails
  }
}

/**
 * Helper to fetch match and tournament entities with resilient fallback if columns are missing
 */
async function getMatchAndTournament(matchPublicOrInternalId) {
  const isNum = /^\d+$/.test(String(matchPublicOrInternalId).trim());
  const baseParams = [String(matchPublicOrInternalId), isNum ? parseInt(matchPublicOrInternalId, 10) : -1];

  try {
    const rows = await db.query(
      `SELECT 
        tm.id, tm.uuid as public_id, tm.match_number, tm.status as match_status,
        tm.tournament_id, tm.venue_id, tm.court_id, tm.scorer_id,
        tm.live_score_summary, tm.live_subtext, tm.sport_state,
        tm.has_live_stream, tm.live_stream_id,
        t.id as t_id, t.uuid as tournament_uuid, t.name as tournament_name,
        t.created_by, t.sport_id,
        s.slug as sport_slug, s.name as sport_name,
        v.owner_id as venue_owner_id,
        ta.id as team_a_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
        tb.id as team_b_id, tb.name as team_b_name, tb.logo_url as team_b_logo
       FROM tournament_matches tm
       JOIN tournaments t ON tm.tournament_id = t.id
       JOIN sports s ON t.sport_id = s.id
       LEFT JOIN venues v ON tm.venue_id = v.id
       LEFT JOIN teams ta ON tm.team_a_id = ta.id
       LEFT JOIN teams tb ON tm.team_b_id = tb.id
       WHERE tm.uuid = ? OR tm.id = ?`,
      baseParams
    );
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    // Fallback if has_live_stream column does not exist in database yet
    if (err && (err.code === 'ER_BAD_FIELD_ERROR' || String(err.message).includes('has_live_stream'))) {
      const rows = await db.query(
        `SELECT 
          tm.id, tm.uuid as public_id, tm.match_number, tm.status as match_status,
          tm.tournament_id, tm.venue_id, tm.court_id, tm.scorer_id,
          tm.live_score_summary, tm.live_subtext, tm.sport_state,
          0 as has_live_stream, NULL as live_stream_id,
          t.id as t_id, t.uuid as tournament_uuid, t.name as tournament_name,
          t.created_by, t.sport_id,
          s.slug as sport_slug, s.name as sport_name,
          v.owner_id as venue_owner_id,
          ta.id as team_a_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
          tb.id as team_b_id, tb.name as team_b_name, tb.logo_url as team_b_logo
         FROM tournament_matches tm
         JOIN tournaments t ON tm.tournament_id = t.id
         JOIN sports s ON t.sport_id = s.id
         LEFT JOIN venues v ON tm.venue_id = v.id
         LEFT JOIN teams ta ON tm.team_a_id = ta.id
         LEFT JOIN teams tb ON tm.team_b_id = tb.id
         WHERE tm.uuid = ? OR tm.id = ?`,
        baseParams
      );
      return rows && rows.length > 0 ? rows[0] : null;
    }
    throw err;
  }
}

/**
 * Authoritative check whether user has permission to manage the match stream.
 * UNCONDITIONAL ACCESS FOR SUPER ADMIN across any match, tournament, or venue.
 * Also grants access to:
 * - Tournament Organizer / Venue Owner
 * - Assigned Match Scorer
 * - Authorized Delegated Streamers
 */
async function canManageStream(user, matchData) {
  if (!user || !user.id) return false;
  const role = (user.role || '').toUpperCase();

  // 1. Super Admin unconditionally allowed for all matches
  if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
    return true;
  }

  const userId = Number(user.id);

  // 2. Tournament Creator or Venue Owner
  if (matchData.created_by && Number(matchData.created_by) === userId) return true;
  if (matchData.venue_owner_id && Number(matchData.venue_owner_id) === userId) return true;

  // 3. Assigned Match Scorer
  if (matchData.scorer_id && Number(matchData.scorer_id) === userId) return true;

  // 4. Delegated Streamer in tournament_stream_permissions
  const tournamentId = matchData.t_id || matchData.tournament_id;
  const matchInternalId = matchData.id;
  if (tournamentId) {
    try {
      const rows = await db.query(
        `SELECT id FROM tournament_stream_permissions
         WHERE tournament_id = ?
           AND user_id = ?
           AND status = 'ACTIVE'
           AND (expires_at IS NULL OR expires_at > NOW())
           AND (match_id IS NULL OR match_id = ?)
         LIMIT 1`,
        [tournamentId, userId, matchInternalId]
      );
      if (rows && rows.length > 0) return true;
    } catch (err) {
      // Non-fatal if table not yet migrated
    }
  }

  return false;
}

/**
 * Get match stream details (authorized gets ingest info; public gets only viewer playback)
 */
async function getMatchStream(matchId, user = null) {
  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  const isAuthorized = await canManageStream(user, match);

  let rows = [];
  try {
    rows = await db.query(
      `SELECT * FROM match_streams WHERE match_id = ? ORDER BY id DESC LIMIT 1`,
      [match.id]
    );
  } catch (err) {
    if (err && (err.code === 'ER_NO_SUCH_TABLE' || String(err.message).includes("doesn't exist"))) {
      rows = [];
      // Trigger background table creation
      ensureStreamingTables().catch(() => {});
    } else {
      throw err;
    }
  }

  if (!rows || rows.length === 0) {
    return {
      exists: false,
      match: {
        id: match.public_id,
        matchNumber: match.match_number,
        tournamentId: match.tournament_uuid,
        tournamentName: match.tournament_name,
        sportSlug: match.sport_slug,
        teamAName: match.team_a_name,
        teamBName: match.team_b_name,
        matchStatus: match.match_status
      },
      canManage: isAuthorized,
      stream: null,
      iceServers: isAuthorized ? getIceServers() : undefined
    };
  }

  const s = rows[0];

  let parsedOverlay = DEFAULT_OVERLAY_CONFIG;
  if (s.overlay_config) {
    try {
      parsedOverlay = typeof s.overlay_config === 'string' ? JSON.parse(s.overlay_config) : s.overlay_config;
    } catch {}
  }

  // Sanitized viewer payload (never exposes broadcaster keys or ingest tokens)
  const publicStream = {
    id: s.uuid,
    matchId: match.public_id,
    tournamentId: match.tournament_uuid,
    streamingMethod: s.streaming_method,
    status: s.status,
    isLive: s.status === 'LIVE',
    title: s.title || `${match.team_a_name} vs ${match.team_b_name} - Live Stream`,
    description: s.description || '',
    playbackUrl: s.playback_url,
    youtubeVideoId: s.youtube_video_id,
    youtubeEmbedUrl: s.youtube_video_id ? getYouTubeEmbedUrl(s.youtube_video_id) : null,
    youtubeLiveUrl: s.youtube_live_url,
    viewerCount: s.viewer_count || 0,
    overlayConfig: parsedOverlay,
    actualStart: s.actual_start,
    createdAt: s.created_at
  };

  // If authorized manager, append private ingest parameters & ICE servers
  if (isAuthorized) {
    publicStream.streamKey = s.stream_key;
    publicStream.ingestUrl = s.ingest_url || RTMP_BASE_URL;
    publicStream.youtubeBroadcastId = s.youtube_broadcast_id;
    publicStream.obsOverlayUrl = `/matches/${match.public_id}/overlay`;
    publicStream.iceServers = getIceServers();
  }

  return {
    exists: true,
    match: {
      id: match.public_id,
      matchNumber: match.match_number,
      tournamentId: match.tournament_uuid,
      tournamentName: match.tournament_name,
      sportSlug: match.sport_slug,
      teamAName: match.team_a_name,
      teamBName: match.team_b_name,
      matchStatus: match.match_status
    },
    canManage: isAuthorized,
    stream: publicStream
  };
}

/**
 * Initialize or configure a stream for a match
 */
async function initializeStream(matchId, user, payload = {}) {
  await ensureStreamingTables();

  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  if (!(await canManageStream(user, match))) {
    throw { statusCode: 403, message: 'You are not authorized to manage live streaming for this match.' };
  }

  let {
    streamingMethod = 'MOBILE_CAMERA',
    title,
    description,
    youtubeLiveUrl,
    youtubeUrl,
    privacyStatus = 'PUBLIC',
    overlayConfig = {}
  } = payload;

  if (streamingMethod === 'YOUTUBE') {
    streamingMethod = 'YOUTUBE_LIVE';
  }
  const effectiveYoutubeUrl = youtubeLiveUrl || youtubeUrl;

  const validMethods = ['MOBILE_CAMERA', 'EXTERNAL_RTMP', 'YOUTUBE_LIVE'];
  if (!validMethods.includes(streamingMethod)) {
    throw { statusCode: 400, message: `Invalid streaming method. Must be one of: ${validMethods.join(', ')}` };
  }

  let ytVideoId = null;
  let ytLiveUrl = null;
  if (streamingMethod === 'YOUTUBE_LIVE') {
    if (effectiveYoutubeUrl) {
      ytVideoId = extractYouTubeVideoId(effectiveYoutubeUrl);
      ytLiveUrl = effectiveYoutubeUrl.trim();
      if (!ytVideoId) {
        throw { statusCode: 400, message: 'Invalid YouTube Live URL or Video ID. Supported formats: youtube.com/live/ID, youtube.com/watch?v=ID, youtu.be/ID' };
      }
    }
  }

  const existingRows = await db.query(
    'SELECT * FROM match_streams WHERE match_id = ? ORDER BY id DESC LIMIT 1',
    [match.id]
  );

  const streamUuid = existingRows.length > 0 ? existingRows[0].uuid : crypto.randomUUID();
  const streamKey = existingRows.length > 0 && existingRows[0].stream_key 
    ? existingRows[0].stream_key 
    : `turf_live_${crypto.randomBytes(12).toString('hex')}`;

  const ingestUrl = RTMP_BASE_URL;
  const playbackUrl = streamingMethod === 'EXTERNAL_RTMP'
    ? `${HLS_BASE_URL}/${streamKey}.m3u8`
    : (existingRows.length > 0 ? existingRows[0].playback_url : null);

  const streamTitle = title || `${match.team_a_name} vs ${match.team_b_name} - Match #${match.match_number} Live`;
  const streamDescription = description || `Official Live Match Stream for ${match.tournament_name}`;
  const mergedOverlay = { ...DEFAULT_OVERLAY_CONFIG, ...overlayConfig };

  if (existingRows.length > 0) {
    const existing = existingRows[0];
    await db.query(
      `UPDATE match_streams SET
        streaming_method = ?,
        title = ?,
        description = ?,
        youtube_video_id = COALESCE(?, youtube_video_id),
        youtube_live_url = COALESCE(?, youtube_live_url),
        privacy_status = ?,
        overlay_config = ?,
        status = CASE WHEN status = 'ENDED' THEN 'IDLE' ELSE status END
       WHERE id = ?`,
      [
        streamingMethod,
        streamTitle,
        streamDescription,
        ytVideoId,
        ytLiveUrl,
        privacyStatus,
        JSON.stringify(mergedOverlay),
        existing.id
      ]
    );
  } else {
    await db.query(
      `INSERT INTO match_streams (
        uuid, match_id, tournament_id, user_id, streaming_method, status,
        stream_key, ingest_url, playback_url, youtube_video_id, youtube_live_url,
        title, description, privacy_status, overlay_config
      ) VALUES (?, ?, ?, ?, ?, 'IDLE', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        streamUuid,
        match.id,
        match.tournament_id || match.t_id,
        user.id,
        streamingMethod,
        streamKey,
        ingestUrl,
        playbackUrl,
        ytVideoId,
        ytLiveUrl,
        streamTitle,
        streamDescription,
        privacyStatus,
        JSON.stringify(mergedOverlay)
      ]
    );
  }

  // Update match flag safely
  try {
    await db.query('UPDATE tournament_matches SET has_live_stream = 1 WHERE id = ?', [match.id]);
  } catch (err) {}

  // Audit log entry
  await recordStreamAudit({
    match,
    user,
    actionType: 'STREAM_INITIALIZED',
    newState: { streamingMethod, streamTitle },
    notes: `Configured ${streamingMethod} stream for Match #${match.match_number}`
  });

  // Broadcast socket event
  const io = getIO();
  if (io) {
    io.to(`match:${match.public_id}`).emit('stream:initialized', {
      matchId: match.public_id,
      streamId: streamUuid,
      streamingMethod,
      title: streamTitle
    });
  }

  return getMatchStream(match.public_id, user);
}

/**
 * Update stream status (PREVIEW, LIVE, PAUSED, ENDED)
 */
async function updateStreamStatus(matchId, user, { status }) {
  await ensureStreamingTables();

  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  if (!(await canManageStream(user, match))) {
    throw { statusCode: 403, message: 'You are not authorized to update stream status.' };
  }

  const validStatuses = ['IDLE', 'PREVIEW', 'LIVE', 'PAUSED', 'ENDED'];
  if (!validStatuses.includes(status)) {
    throw { statusCode: 400, message: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };
  }

  const rows = await db.query(
    'SELECT * FROM match_streams WHERE match_id = ? ORDER BY id DESC LIMIT 1',
    [match.id]
  );
  if (!rows || rows.length === 0) {
    throw { statusCode: 404, message: 'No stream configured for this match.' };
  }

  const stream = rows[0];
  let actualStart = stream.actual_start;
  let actualEnd = stream.actual_end;

  if (status === 'LIVE' && !actualStart) {
    actualStart = new Date();
  }
  if (status === 'ENDED') {
    actualEnd = new Date();
    try {
      const matchBreakService = require('./matchBreakService');
      matchBreakService.endBreak(match.public_id || matchId).catch(() => {});
    } catch (e) {}
  }

  await db.query(
    `UPDATE match_streams SET
      status = ?,
      actual_start = COALESCE(?, actual_start),
      actual_end = ?
     WHERE id = ?`,
    [status, actualStart, actualEnd, stream.id]
  );

  // Update match flag
  try {
    const liveFlag = status === 'LIVE' ? 1 : 0;
    await db.query('UPDATE tournament_matches SET has_live_stream = ? WHERE id = ?', [liveFlag, match.id]);
  } catch (err) {}

  // Audit trail entry
  await recordStreamAudit({
    match,
    user,
    actionType: status === 'LIVE' ? 'STREAM_STARTED' : status === 'ENDED' ? 'STREAM_ENDED' : `STREAM_STATUS_${status}`,
    previousState: { status: stream.status },
    newState: { status },
    notes: `Stream status changed from ${stream.status} to ${status} for Match #${match.match_number}`
  });

  // Real-time socket notification to viewers, tournament subscribers, and display monitors
  const io = getIO();
  if (io) {
    const payload = {
      matchId: match.public_id,
      matchUuid: match.public_id,
      id: match.public_id,
      streamId: stream.uuid,
      status,
      isLive: status === 'LIVE',
      streamingMethod: stream.streaming_method,
      youtubeUrl: stream.youtube_live_url,
      youtubeVideoId: stream.youtube_video_id,
      playbackUrl: stream.playback_url,
      actualStart,
      actualEnd
    };
    io.emit('stream:status', payload);
    io.to(`stream:${match.public_id}`).emit('stream:status', payload);
    io.to(`stream:${match.public_id}`).emit('stream:status_changed', payload);
    io.to(`match:${match.public_id}`).emit('stream:status', payload);
    io.to(`match:${match.public_id}`).emit('stream:status_changed', payload);
    if (match.tournament_uuid) {
      io.to(`tournament:${match.tournament_uuid}`).emit('tournament:stream_status', payload);
    }
  }

  return getMatchStream(match.public_id, user);
}

/**
 * Regenerate stream key for external RTMP broadcasting
 */
async function regenerateStreamKey(matchId, user) {
  await ensureStreamingTables();

  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  if (!(await canManageStream(user, match))) {
    throw { statusCode: 403, message: 'You are not authorized to regenerate stream keys.' };
  }

  const newKey = `turf_live_${crypto.randomBytes(12).toString('hex')}`;
  const newPlaybackUrl = `${HLS_BASE_URL}/${newKey}.m3u8`;

  await db.query(
    `UPDATE match_streams SET 
      stream_key = ?, 
      playback_url = ?
     WHERE match_id = ?`,
    [newKey, newPlaybackUrl, match.id]
  );

  await recordStreamAudit({
    match,
    user,
    actionType: 'STREAM_KEY_REGENERATED',
    notes: `Regenerated external RTMP stream key for Match #${match.match_number}`
  });

  return {
    success: true,
    message: 'Stream key regenerated successfully.',
    streamKey: newKey,
    ingestUrl: RTMP_BASE_URL,
    playbackUrl: newPlaybackUrl
  };
}

/**
 * Update overlay settings
 */
async function updateOverlayConfig(matchId, user, config) {
  await ensureStreamingTables();

  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  if (!(await canManageStream(user, match))) {
    throw { statusCode: 403, message: 'You are not authorized to update overlay configuration.' };
  }

  const rows = await db.query(
    'SELECT * FROM match_streams WHERE match_id = ? ORDER BY id DESC LIMIT 1',
    [match.id]
  );
  if (!rows || rows.length === 0) {
    throw { statusCode: 404, message: 'Stream not found.' };
  }

  let current = DEFAULT_OVERLAY_CONFIG;
  if (rows[0].overlay_config) {
    try {
      current = typeof rows[0].overlay_config === 'string' ? JSON.parse(rows[0].overlay_config) : rows[0].overlay_config;
    } catch {}
  }

  const updated = { ...current, ...config };
  await db.query(
    'UPDATE match_streams SET overlay_config = ? WHERE id = ?',
    [JSON.stringify(updated), rows[0].id]
  );

  await recordStreamAudit({
    match,
    user,
    actionType: 'STREAM_OVERLAY_UPDATED',
    newState: updated,
    notes: `Updated broadcast overlay configuration for Match #${match.match_number}`
  });

  const io = getIO();
  if (io) {
    io.to(`match:${match.public_id}`).emit('stream:overlay_updated', {
      matchId: match.public_id,
      overlayConfig: updated
    });
  }

  return { success: true, overlayConfig: updated };
}

/**
 * Fetch live data formatted for transparent OBS overlay
 */
async function getOBSOverlayData(matchId) {
  const match = await getMatchAndTournament(matchId);
  if (!match) throw { statusCode: 404, message: 'Match not found.' };

  let overlayConfig = DEFAULT_OVERLAY_CONFIG;
  try {
    const streamRows = await db.query(
      'SELECT * FROM match_streams WHERE match_id = ? ORDER BY id DESC LIMIT 1',
      [match.id]
    );
    if (streamRows.length > 0 && streamRows[0].overlay_config) {
      overlayConfig = typeof streamRows[0].overlay_config === 'string'
        ? JSON.parse(streamRows[0].overlay_config)
        : streamRows[0].overlay_config;
    }
  } catch (err) {}

  let parsedSportState = null;
  if (match.sport_state) {
    try {
      parsedSportState = typeof match.sport_state === 'string'
        ? JSON.parse(match.sport_state)
        : match.sport_state;
    } catch {}
  }

  return {
    matchId: match.public_id,
    matchNumber: match.match_number,
    status: match.match_status,
    tournamentName: match.tournament_name,
    sportSlug: match.sport_slug,
    sportName: match.sport_name,
    teamA: {
      name: match.team_a_name,
      logo: match.team_a_logo
    },
    teamB: {
      name: match.team_b_name,
      logo: match.team_b_logo
    },
    scoreSummary: match.live_score_summary || '0/0',
    subtext: match.live_subtext || '',
    sportState: parsedSportState,
    overlayConfig
  };
}

/**
 * List all active streams across the platform (for Live Now tab)
 */
async function getActiveLiveStreams() {
  try {
    const rows = await db.query(
      `SELECT 
        ms.uuid as stream_id, ms.streaming_method, ms.status, ms.title,
        ms.youtube_video_id, ms.viewer_count, ms.actual_start,
        tm.uuid as match_id, tm.match_number, tm.live_score_summary, tm.live_subtext,
        t.uuid as tournament_id, t.name as tournament_name,
        s.slug as sport_slug, s.name as sport_name,
        ta.name as team_a_name, ta.logo_url as team_a_logo,
        tb.name as team_b_name, tb.logo_url as team_b_logo
       FROM match_streams ms
       JOIN tournament_matches tm ON ms.match_id = tm.id
       JOIN tournaments t ON tm.tournament_id = t.id
       JOIN sports s ON t.sport_id = s.id
       LEFT JOIN teams ta ON tm.team_a_id = ta.id
       LEFT JOIN teams tb ON tm.team_b_id = tb.id
       WHERE ms.status IN ('LIVE', 'PREVIEW')
       ORDER BY ms.status = 'LIVE' DESC, ms.viewer_count DESC, ms.actual_start DESC`
    );

    return rows.map((r) => ({
      streamId: r.stream_id,
      matchId: r.match_id,
      matchNumber: r.match_number,
      streamingMethod: r.streaming_method,
      status: r.status,
      title: r.title,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      sportSlug: r.sport_slug,
      sportName: r.sport_name,
      teamAName: r.team_a_name,
      teamBName: r.team_b_name,
      scoreSummary: r.live_score_summary,
      subtext: r.live_subtext,
      youtubeVideoId: r.youtube_video_id,
      viewerCount: r.viewer_count || 0,
      startedAt: r.actual_start
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Automatically end stream if broadcaster unexpectedly disconnects and does not resume
 */
async function autoEndStreamOnDisconnect(matchId) {
  try {
    const match = await getMatchAndTournament(matchId);
    if (!match) return;

    const rows = await db.query(
      'SELECT * FROM match_streams WHERE match_id = ? AND status = "LIVE" ORDER BY id DESC LIMIT 1',
      [match.id]
    );
    if (!rows || rows.length === 0) return;

    const stream = rows[0];
    const actualEnd = new Date();

    await db.query(
      `UPDATE match_streams SET status = 'ENDED', actual_end = ? WHERE id = ?`,
      [actualEnd, stream.id]
    );
    try {
      await db.query('UPDATE tournament_matches SET has_live_stream = 0 WHERE id = ?', [match.id]);
    } catch (e) {}
    try {
      const matchBreakService = require('./matchBreakService');
      matchBreakService.endBreak(match.public_id || matchId).catch(() => {});
    } catch (e) {}

    const io = getIO();
    if (io) {
      const payload = {
        matchId: match.public_id,
        matchUuid: match.public_id,
        id: match.public_id,
        streamId: stream.uuid,
        status: 'ENDED',
        isLive: false,
        actualEnd
      };
      io.emit('stream:status', payload);
      io.to(`stream:${match.public_id}`).emit('stream:status', payload);
      io.to(`stream:${match.public_id}`).emit('stream:status_changed', payload);
      io.to(`match:${match.public_id}`).emit('stream:status', payload);
      io.to(`match:${match.public_id}`).emit('stream:status_changed', payload);
      if (match.tournament_uuid) {
        io.to(`tournament:${match.tournament_uuid}`).emit('tournament:stream_status', payload);
      }
    }
  } catch (err) {
    console.warn('autoEndStreamOnDisconnect error:', err.message);
  }
}

/**
 * Super Admin Streaming Health Diagnostics Check
 * Authoritative system check covering DB, WebRTC/STUN, Ingest, and Environment.
 */
async function getStreamingHealth(user = null) {
  const role = (user?.role || '').toUpperCase();
  const isSuperAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';

  let matchStreamsTable = false;
  let tournamentStreamPermissionsTable = false;
  let hasLiveStreamCol = false;
  let liveStreamIdCol = false;
  let totalStreamsCount = 0;
  let activeLiveCount = 0;

  try {
    const [t1] = await db.query(`SHOW TABLES LIKE 'match_streams'`);
    matchStreamsTable = Boolean(t1);

    const [t2] = await db.query(`SHOW TABLES LIKE 'tournament_stream_permissions'`);
    tournamentStreamPermissionsTable = Boolean(t2);

    const cols = await db.query('DESCRIBE tournament_matches');
    const colNames = (cols || []).map((c) => c.Field);
    hasLiveStreamCol = colNames.includes('has_live_stream');
    liveStreamIdCol = colNames.includes('live_stream_id');

    if (matchStreamsTable) {
      const [cnt] = await db.query('SELECT COUNT(*) as total, SUM(CASE WHEN status = "LIVE" THEN 1 ELSE 0 END) as active FROM match_streams');
      totalStreamsCount = cnt?.total || 0;
      activeLiveCount = cnt?.active || 0;
    }
  } catch (err) {
    console.warn('[StreamingHealth] DB check note:', err.message);
  }

  const iceServers = getIceServers();
  const hasStun = iceServers.some((s) => String(s.urls).startsWith('stun:'));
  const hasTurn = iceServers.some((s) => String(s.urls).startsWith('turn:') || String(s.urls).startsWith('turns:'));

  const envChecks = {
    APP_URL: Boolean(process.env.APP_URL),
    API_PUBLIC_URL: Boolean(process.env.API_PUBLIC_URL),
    STREAMING_RTMP_INGEST_URL: Boolean(process.env.STREAMING_RTMP_INGEST_URL || process.env.RTMP_INGEST_URL),
    STREAMING_HLS_PLAYBACK_URL: Boolean(process.env.STREAMING_HLS_PLAYBACK_URL || process.env.HLS_PLAYBACK_URL),
    STUN_CONFIGURED: hasStun,
    TURN_CONFIGURED: hasTurn,
    YOUTUBE_OAUTH_CONFIGURED: Boolean(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET)
  };

  const allPassed =
    matchStreamsTable &&
    tournamentStreamPermissionsTable &&
    hasLiveStreamCol &&
    hasStun;

  return {
    status: allPassed ? 'HEALTHY' : 'DEGRADED',
    timestamp: new Date().toISOString(),
    isSuperAdmin,
    database: {
      matchStreamsTable,
      tournamentStreamPermissionsTable,
      hasLiveStreamColumn: hasLiveStreamCol,
      liveStreamIdColumn: liveStreamIdCol,
      totalStreamsRecorded: totalStreamsCount,
      currentlyLiveStreams: activeLiveCount
    },
    networking: {
      rtmpIngestUrlConfigured: RTMP_BASE_URL,
      hlsPlaybackUrlConfigured: HLS_BASE_URL,
      iceServersConfiguredCount: iceServers.length,
      stunAvailable: hasStun,
      turnAvailable: hasTurn,
      // Pass clean names only without credentials
      iceServersSummary: iceServers.map((s) => ({
        urls: s.urls,
        hasAuth: Boolean(s.username)
      }))
    },
    environment: envChecks
  };
}

module.exports = {
  ensureStreamingTables,
  cleanupStaleStreamsOnStartup,
  recordStreamAudit,
  getMatchAndTournament,
  canManageStream,
  getMatchStream,
  initializeStream,
  updateStreamStatus,
  regenerateStreamKey,
  updateOverlayConfig,
  getOBSOverlayData,
  getActiveLiveStreams,
  autoEndStreamOnDisconnect,
  getStreamingHealth
};
