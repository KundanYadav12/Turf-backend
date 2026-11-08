let ioInstance = null;
const broadcasterDisconnectTimers = new Map();

// High-speed In-Memory Identifier Mapping Cache (numeric ID <-> UUID)
const matchIdentifierCache = new Map();
const tournamentIdentifierCache = new Map();

/**
 * Resolves both numeric ID and UUID for a match from memory or database.
 * Prevents room fragmentation between screens referencing id vs uuid.
 */
async function resolveMatchIdentifiers(matchKey) {
  if (!matchKey) return null;
  const keyStr = String(matchKey).trim();
  if (matchIdentifierCache.has(keyStr)) {
    return matchIdentifierCache.get(keyStr);
  }

  try {
    const db = require('../config/database');
    const isNum = /^\d+$/.test(keyStr);
    const rows = isNum
      ? await db.query(
          `SELECT tm.id, tm.uuid, tm.tournament_id, tm.status, tm.live_score_summary, tm.live_subtext, tm.sport_state,
                  t.uuid as tournament_uuid, s.slug as sport_slug
           FROM tournament_matches tm
           LEFT JOIN tournaments t ON tm.tournament_id = t.id
           LEFT JOIN sports s ON t.sport_id = s.id
           WHERE tm.id = ? LIMIT 1`,
          [parseInt(keyStr, 10)]
        )
      : await db.query(
          `SELECT tm.id, tm.uuid, tm.tournament_id, tm.status, tm.live_score_summary, tm.live_subtext, tm.sport_state,
                  t.uuid as tournament_uuid, s.slug as sport_slug
           FROM tournament_matches tm
           LEFT JOIN tournaments t ON tm.tournament_id = t.id
           LEFT JOIN sports s ON t.sport_id = s.id
           WHERE tm.uuid = ? LIMIT 1`,
          [keyStr]
        );

    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0];
      const matchData = {
        id: row.id,
        uuid: row.uuid,
        tournamentId: row.tournament_id,
        tournamentUuid: row.tournament_uuid,
        sportSlug: row.sport_slug,
        status: row.status,
        liveScoreSummary: row.live_score_summary,
        liveSubtext: row.live_subtext,
        sportState: row.sport_state
      };

      matchIdentifierCache.set(String(row.id), matchData);
      matchIdentifierCache.set(String(row.uuid), matchData);
      return matchData;
    }
  } catch (err) {
    // Graceful fallback
  }
  return null;
}

/**
 * Resolves both numeric ID and UUID for a tournament.
 */
async function resolveTournamentIdentifiers(tournKey) {
  if (!tournKey) return null;
  const keyStr = String(tournKey).trim();
  if (tournamentIdentifierCache.has(keyStr)) {
    return tournamentIdentifierCache.get(keyStr);
  }

  try {
    const db = require('../config/database');
    const isNum = /^\d+$/.test(keyStr);
    const rows = isNum
      ? await db.query(
          'SELECT id, uuid FROM tournaments WHERE id = ? LIMIT 1',
          [parseInt(keyStr, 10)]
        )
      : await db.query(
          'SELECT id, uuid FROM tournaments WHERE uuid = ? LIMIT 1',
          [keyStr]
        );

    if (Array.isArray(rows) && rows.length > 0) {
      const tData = { id: rows[0].id, uuid: rows[0].uuid };
      tournamentIdentifierCache.set(String(rows[0].id), tData);
      tournamentIdentifierCache.set(String(rows[0].uuid), tData);
      return tData;
    }
  } catch (err) {}
  return null;
}

/**
 * Initializes Socket.IO with CORS and room partition architecture.
 */
function initSocket(server) {
  const { Server } = require('socket.io');
  const { TRUSTED_ORIGINS } = require('../config/siteConfig');
  const io = new Server(server, {
    addTrailingSlash: false,
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (TRUSTED_ORIGINS.includes(origin) || origin.endsWith('playzo.duckdns.org')) {
          return callback(null, true);
        }
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          return callback(null, true);
        }
        return callback(null, true);
      },
      methods: ['GET', 'POST'],
      credentials: true
    }
  });

  io.on('connection', (socket) => {
    // 1. Join Tournament Room (Dual Room: numeric ID + UUID)
    socket.on('join:tournament', async ({ tournamentId }) => {
      if (tournamentId) {
        const rawKey = String(tournamentId).trim();
        socket.join(`tournament:${rawKey}`);
        
        // Asynchronously resolve and auto-join the companion identifier room
        try {
          const tInfo = await resolveTournamentIdentifiers(rawKey);
          if (tInfo) {
            if (tInfo.id) socket.join(`tournament:${tInfo.id}`);
            if (tInfo.uuid) socket.join(`tournament:${tInfo.uuid}`);
          }
        } catch (e) {}
      }
    });

    // 2. Leave Tournament Room
    socket.on('leave:tournament', ({ tournamentId }) => {
      if (tournamentId) {
        const rawKey = String(tournamentId).trim();
        socket.leave(`tournament:${rawKey}`);
        const tInfo = tournamentIdentifierCache.get(rawKey);
        if (tInfo) {
          if (tInfo.id) socket.leave(`tournament:${tInfo.id}`);
          if (tInfo.uuid) socket.leave(`tournament:${tInfo.uuid}`);
        }
      }
    });

    // 3. Join Match Room (Dual Room: numeric ID + UUID + Stream Room)
    socket.on('join:match', async ({ matchId }) => {
      if (matchId) {
        const rawKey = String(matchId).trim();
        socket.join(`match:${rawKey}`);
        socket.join(`stream:${rawKey}`);

        if (!socket._joinedMatches) socket._joinedMatches = new Set();
        socket._joinedMatches.add(rawKey);

        // Asynchronously resolve and auto-join companion rooms
        try {
          const mInfo = await resolveMatchIdentifiers(rawKey);
          if (mInfo) {
            if (mInfo.id) {
              socket.join(`match:${mInfo.id}`);
              socket.join(`stream:${mInfo.id}`);
              socket._joinedMatches.add(String(mInfo.id));
            }
            if (mInfo.uuid) {
              socket.join(`match:${mInfo.uuid}`);
              socket.join(`stream:${mInfo.uuid}`);
              socket._joinedMatches.add(String(mInfo.uuid));
            }
            if (mInfo.tournamentId) socket.join(`tournament:${mInfo.tournamentId}`);
            if (mInfo.tournamentUuid) socket.join(`tournament:${mInfo.tournamentUuid}`);
          }
        } catch (e) {}
      }
    });

    // 4. Leave Match Room
    socket.on('leave:match', ({ matchId }) => {
      if (matchId) {
        const rawKey = String(matchId).trim();
        socket.leave(`match:${rawKey}`);
        socket.leave(`stream:${rawKey}`);

        if (socket._joinedMatches) {
          socket._joinedMatches.delete(rawKey);
        }

        const mInfo = matchIdentifierCache.get(rawKey);
        if (mInfo) {
          if (mInfo.id) {
            socket.leave(`match:${mInfo.id}`);
            socket.leave(`stream:${mInfo.id}`);
            if (socket._joinedMatches) socket._joinedMatches.delete(String(mInfo.id));
          }
          if (mInfo.uuid) {
            socket.leave(`match:${mInfo.uuid}`);
            socket.leave(`stream:${mInfo.uuid}`);
            if (socket._joinedMatches) socket._joinedMatches.delete(String(mInfo.uuid));
          }
        }
      }
    });

    // 4b. Reconnection Match Sync Request
    socket.on('match:requestSync', async ({ matchId }) => {
      if (!matchId) return;
      try {
        const mInfo = await resolveMatchIdentifiers(matchId);
        if (mInfo) {
          const syncPayload = {
            matchId: mInfo.uuid,
            id: mInfo.id,
            status: mInfo.status,
            scoreSummary: mInfo.liveScoreSummary,
            liveScoreSummary: mInfo.liveScoreSummary,
            subtext: mInfo.liveSubtext,
            liveSubtext: mInfo.liveSubtext,
            sportState: typeof mInfo.sportState === 'string' ? JSON.parse(mInfo.sportState) : mInfo.sportState,
            timestamp: Date.now()
          };
          socket.emit('score:updated', syncPayload);
          socket.emit('match:ballEvent', syncPayload);
        }
      } catch (err) {}
    });

    // 5. Join Auction Room
    socket.on('join:auction', ({ auctionId }) => {
      if (auctionId) {
        const room = `auction:${auctionId}`;
        socket.join(room);
      }
    });

    // 6. Leave Auction Room
    socket.on('leave:auction', ({ auctionId }) => {
      if (auctionId) {
        const room = `auction:${auctionId}`;
        socket.leave(room);
      }
    });

    // 7. Forward Tournament Match Update
    socket.on('signage:emitMatchUpdate', ({ tournamentId, data }) => {
      if (tournamentId && data) {
        broadcastTournamentMatchUpdate(tournamentId, data);
      }
    });

    // 8. Forward Live Point Scored Ball Motion across Match, TV, and Signage (Strictly scoped)
    socket.on('match:pointScored', (payload) => {
      if (payload && payload.matchId) {
        const enriched = {
          timestamp: Date.now(),
          eventSeq: payload.eventSeq || Date.now(),
          ...payload
        };
        io.to(`match:${payload.matchId}`).emit('match:pointScored', enriched);
        io.to(`match:${payload.matchId}`).emit('match:ballEvent', enriched);
        io.to(`match:${payload.matchId}`).emit('score:updated', enriched);

        if (payload.tournamentId) {
          const tRoom = `tournament:${payload.tournamentId}`;
          io.to(tRoom).emit('match:pointScored', enriched);
          io.to(tRoom).emit('tournament:matchUpdated', {
            matchId: payload.matchId,
            tournamentId: payload.tournamentId,
            liveScoreSummary: payload.scoreSummary,
            liveSubtext: payload.subtext,
            status: payload.status,
            type: payload.type,
            celebration: payload.celebration,
            eventSeq: enriched.eventSeq
          });
          io.to(tRoom).emit('signage:pointScored', enriched);
          io.to(tRoom).emit('signage:matchUpdate', {
            matchId: payload.matchId,
            tournamentId: payload.tournamentId,
            liveScoreSummary: payload.scoreSummary,
            liveSubtext: payload.subtext,
            status: payload.status,
            eventSeq: enriched.eventSeq
          });
        }
      }
    });

    // 9. Forward Undo Point across TV and Signage (Strictly scoped)
    socket.on('match:undoPoint', (payload) => {
      if (payload && payload.matchId) {
        const undoPayload = { ...payload, type: 'UNDO', timestamp: Date.now() };
        io.to(`match:${payload.matchId}`).emit('match:undoPoint', undoPayload);
        io.to(`match:${payload.matchId}`).emit('match:undone', undoPayload);
        if (payload.tournamentId) {
          const tRoom = `tournament:${payload.tournamentId}`;
          io.to(tRoom).emit('match:undoPoint', undoPayload);
          io.to(tRoom).emit('tournament:matchUpdated', undoPayload);
          io.to(tRoom).emit('signage:pointScored', undoPayload);
          io.to(tRoom).emit('signage:matchUpdate', undoPayload);
        }
      }
    });

    // 10. Join User Room (for private notifications)
    socket.on('join:user', ({ userId }) => {
      if (userId) {
        socket.join(`user:${userId}`);
      }
    });

    socket.on('leave:user', ({ userId }) => {
      if (userId) {
        socket.leave(`user:${userId}`);
      }
    });

    // 10b. Real-time WhatsApp-Style Chat Handlers
    socket.on('join:chat_conversation', ({ conversationId }) => {
      if (conversationId) {
        socket.join(`chat:conversation:${conversationId}`);
      }
    });

    socket.on('leave:chat_conversation', ({ conversationId }) => {
      if (conversationId) {
        socket.leave(`chat:conversation:${conversationId}`);
      }
    });

    socket.on('chat:typing', ({ conversationId, userId, userName }) => {
      if (conversationId) {
        socket.to(`chat:conversation:${conversationId}`).emit('chat:user_typing', {
          conversationId,
          userId,
          userName
        });
      }
    });

    socket.on('chat:stop_typing', ({ conversationId, userId }) => {
      if (conversationId) {
        socket.to(`chat:conversation:${conversationId}`).emit('chat:user_stop_typing', {
          conversationId,
          userId
        });
      }
    });

    // Helper to calculate exact viewer count (excluding broadcasters)
    const getRoomViewerCount = (mId) => {
      const room = io.sockets.adapter.rooms.get(`stream:${mId}`);
      if (!room) return 0;
      let count = 0;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && !s.isBroadcaster) {
          count++;
        }
      }
      return count;
    };

    // 11. Live Streaming WebRTC Signaling & Room Management
    socket.on('stream:join', async ({ matchId, isBroadcaster }) => {
      if (matchId) {
        const rawKey = String(matchId).trim();
        const streamRoom = `stream:${rawKey}`;
        socket.join(streamRoom);
        socket.join(`match:${rawKey}`);
        socket.streamMatchId = rawKey;
        socket.isBroadcaster = Boolean(isBroadcaster);

        // Auto-join companion match rooms for reliable score synchronization
        try {
          const mInfo = await resolveMatchIdentifiers(rawKey);
          if (mInfo) {
            if (mInfo.id) {
              socket.join(`stream:${mInfo.id}`);
              socket.join(`match:${mInfo.id}`);
            }
            if (mInfo.uuid) {
              socket.join(`stream:${mInfo.uuid}`);
              socket.join(`match:${mInfo.uuid}`);
            }
          }
        } catch (e) {}

        // Cancel pending broadcaster disconnect reaper timer if broadcaster reconnected
        if (socket.isBroadcaster && broadcasterDisconnectTimers.has(matchId)) {
          clearTimeout(broadcasterDisconnectTimers.get(matchId));
          broadcasterDisconnectTimers.delete(matchId);
        }

        const actualViewerCount = getRoomViewerCount(matchId);
        io.to(streamRoom).emit('stream:viewer_count', {
          matchId,
          viewerCount: actualViewerCount
        });

        if (!isBroadcaster) {
          // Tell broadcaster in the room that a viewer joined and needs an offer
          socket.to(streamRoom).emit('stream:viewer_joined', {
            socketId: socket.id,
            viewerCount: actualViewerCount
          });
        }

        // Deliver active match break state to late joiner immediately
        try {
          const matchBreakService = require('./matchBreakService');
          matchBreakService.getBreakState(matchId).then((breakState) => {
            if (breakState && breakState.isBreak) {
              socket.emit('stream:break_state', breakState);
              socket.emit('match:break_updated', breakState);
            }
          }).catch(() => {});
        } catch (e) {}
      }
    });

    // Match Break real-time socket events
    socket.on('stream:break:start', async ({ matchId, reason, durationMinutes }) => {
      if (matchId) {
        try {
          const matchBreakService = require('./matchBreakService');
          await matchBreakService.startBreak(matchId, { reason, durationMinutes });
        } catch (e) {}
      }
    });

    socket.on('stream:break:end', async ({ matchId }) => {
      if (matchId) {
        try {
          const matchBreakService = require('./matchBreakService');
          await matchBreakService.endBreak(matchId);
        } catch (e) {}
      }
    });

    socket.on('stream:broadcaster_ready', ({ matchId }) => {
      if (matchId) {
        const streamRoom = `stream:${matchId}`;
        socket.to(streamRoom).emit('stream:broadcaster_ready', { matchId });
      }
    });

    socket.on('stream:request_offer', ({ matchId }) => {
      if (matchId) {
        const streamRoom = `stream:${matchId}`;
        socket.to(streamRoom).emit('stream:viewer_joined', {
          socketId: socket.id,
          viewerCount: getRoomViewerCount(matchId)
        });
      }
    });

    socket.on('stream:leave', ({ matchId }) => {
      if (matchId) {
        const streamRoom = `stream:${matchId}`;
        socket.leave(streamRoom);
        if (socket.isBroadcaster) {
          socket.to(streamRoom).emit('stream:broadcaster_disconnected', { matchId });
        }
        const actualViewerCount = getRoomViewerCount(matchId);
        io.to(streamRoom).emit('stream:viewer_count', {
          matchId,
          viewerCount: actualViewerCount
        });
        socket.to(streamRoom).emit('stream:viewer_left', {
          socketId: socket.id,
          viewerCount: actualViewerCount
        });
      }
    });

    // WebRTC Offer from Broadcaster -> Specific Viewer or Room
    socket.on('stream:signal:offer', ({ matchId, targetSocketId, sdp }) => {
      if (targetSocketId) {
        io.to(targetSocketId).emit('stream:signal:offer', {
          senderSocketId: socket.id,
          sdp
        });
      } else if (matchId) {
        socket.to(`stream:${matchId}`).emit('stream:signal:offer', {
          senderSocketId: socket.id,
          sdp
        });
      }
    });

    // WebRTC Answer from Viewer -> Broadcaster
    socket.on('stream:signal:answer', ({ targetSocketId, sdp }) => {
      if (targetSocketId) {
        io.to(targetSocketId).emit('stream:signal:answer', {
          senderSocketId: socket.id,
          sdp
        });
      }
    });

    // WebRTC ICE Candidate Exchange
    socket.on('stream:signal:candidate', ({ targetSocketId, candidate, matchId }) => {
      if (targetSocketId) {
        io.to(targetSocketId).emit('stream:signal:candidate', {
          senderSocketId: socket.id,
          candidate
        });
      } else if (matchId) {
        socket.to(`stream:${matchId}`).emit('stream:signal:candidate', {
          senderSocketId: socket.id,
          candidate
        });
      }
    });

    // Stream state announcement (e.g. mic mute, camera paused)
    socket.on('stream:media_state', ({ matchId, isAudioMuted, isVideoPaused }) => {
      if (matchId) {
        socket.to(`stream:${matchId}`).emit('stream:media_state', {
          isAudioMuted,
          isVideoPaused
        });
      }
    });

    socket.on('disconnect', () => {
      if (socket.streamMatchId) {
        const matchId = socket.streamMatchId;
        const streamRoom = `stream:${matchId}`;
        if (socket.isBroadcaster) {
          socket.to(streamRoom).emit('stream:broadcaster_disconnected', {
            matchId
          });

          // Set 25s timeout in case of page refresh before terminating stream in DB
          if (!broadcasterDisconnectTimers.has(matchId)) {
            const timer = setTimeout(async () => {
              broadcasterDisconnectTimers.delete(matchId);
              try {
                const streamService = require('./streamService');
                await streamService.autoEndStreamOnDisconnect(matchId);
              } catch (err) {
                console.warn('[SocketService] Auto-end stream warning:', err.message);
              }
            }, 25000);
            broadcasterDisconnectTimers.set(matchId, timer);
          }
        } else {
          const actualViewerCount = getRoomViewerCount(matchId);
          io.to(streamRoom).emit('stream:viewer_count', {
            matchId,
            viewerCount: actualViewerCount
          });
          socket.to(streamRoom).emit('stream:viewer_left', {
            socketId: socket.id,
            viewerCount: actualViewerCount
          });
        }
      }
    });
  });

  ioInstance = io;
  return io;
}

function getIO() {
  return ioInstance;
}

/**
 * Master Real-Time Score Synchronizer
 * Broadcasts authoritative match score updates simultaneously to:
 * - Match rooms: match:{id} AND match:{uuid}
 * - Stream rooms: stream:{id} AND stream:{uuid}
 * - Tournament rooms: tournament:{tournamentId} AND tournament:{tournamentUuid}
 *
 * Emits with all universal and sport-specific event aliases so every screen,
 * web component, mobile screen, TV display, digital signage, and streaming overlay
 * updates instantly with zero refresh or polling.
 */
async function broadcastScoreSync(matchIdOrUuid, payload = {}) {
  if (!ioInstance) return;
  const matchKey = String(matchIdOrUuid || payload.matchId || payload.matchUuid || payload.id || '').trim();
  if (!matchKey) return;

  // Resolve match and tournament metadata (from memory cache or DB)
  let matchInfo = matchIdentifierCache.get(matchKey);
  if (!matchInfo) {
    matchInfo = await resolveMatchIdentifiers(matchKey);
  }

  const numericId = matchInfo?.id || (isNaN(Number(matchKey)) ? null : Number(matchKey));
  const uuidStr = matchInfo?.uuid || (isNaN(Number(matchKey)) ? matchKey : null);
  const tournamentId = payload.tournamentId || payload.tournament_id || matchInfo?.tournamentId || null;
  const tournamentUuid = payload.tournamentUuid || payload.tournament_uuid || matchInfo?.tournamentUuid || null;

  const eventSeq = payload.eventSeq || payload.seq || Date.now();
  const timestamp = payload.timestamp || Date.now();

  const scoreSummary = payload.scoreSummary || payload.liveScoreSummary || payload.summary ||
    (payload.teamAScore !== undefined && payload.teamBScore !== undefined ? `${payload.teamAScore} - ${payload.teamBScore}` : '');
  const subtext = payload.subtext || payload.liveSubtext || '';
  const status = payload.status || matchInfo?.status || 'LIVE';
  const sportState = payload.sportState || payload.state || payload.sport_state || matchInfo?.sportState || null;
  const celebration = payload.celebration || null;
  const type = payload.type || (payload.isWicket ? 'WICKET' : 'SCORE_UPDATE');

  const enriched = {
    matchId: uuidStr || numericId,
    matchUuid: uuidStr,
    matchNumericId: numericId,
    id: numericId || uuidStr,
    public_id: uuidStr || numericId,
    uuid: uuidStr,
    tournamentId: tournamentUuid || tournamentId,
    tournamentNumericId: tournamentId,
    tournamentUuid: tournamentUuid,
    timestamp,
    eventSeq,
    status,
    scoreSummary,
    liveScoreSummary: scoreSummary,
    subtext,
    liveSubtext: subtext,
    courtName: payload.courtName || payload.court_name || '',
    celebration,
    type,
    state: sportState,
    sportState,
    sportSlug: payload.sportSlug || matchInfo?.sportSlug || null,
    teamAScore: payload.teamAScore,
    teamBScore: payload.teamBScore,
    scoreA: payload.scoreA !== undefined ? payload.scoreA : payload.teamAScore,
    scoreB: payload.scoreB !== undefined ? payload.scoreB : payload.teamBScore,
    scores: payload.scores,
    pickleball: payload.pickleball,
    sidesSwapped: payload.sidesSwapped,
    goldenPoint: payload.goldenPoint,
    trackPlayerPoints: payload.trackPlayerPoints,
    winnerTeamId: payload.winnerTeamId,
    resultSummary: payload.resultSummary,
    pointEvent: payload.pointEvent || null,
    commentary: payload.commentary || null,
    overCompleted: payload.overCompleted || false,
    ballId: payload.ballId || null,
    ...payload
  };

  // 1. Target Match and Stream Rooms (both numeric ID and UUID)
  const matchRooms = new Set();
  if (numericId) {
    matchRooms.add(`match:${numericId}`);
    matchRooms.add(`stream:${numericId}`);
  }
  if (uuidStr) {
    matchRooms.add(`match:${uuidStr}`);
    matchRooms.add(`stream:${uuidStr}`);
  }
  matchRooms.add(`match:${matchKey}`);
  matchRooms.add(`stream:${matchKey}`);

  // Emit to all match and stream rooms
  for (const room of matchRooms) {
    ioInstance.to(room).emit('score:updated', enriched);
    ioInstance.to(room).emit('match:ballEvent', enriched);
    ioInstance.to(room).emit('match:pointScored', enriched);
    ioInstance.to(room).emit('tournament:matchUpdated', enriched);
    ioInstance.to(room).emit('signage:matchUpdate', enriched);

    if (enriched.type === 'UNDO') {
      ioInstance.to(room).emit('match:undone', enriched);
      ioInstance.to(room).emit('match:undoPoint', enriched);
    }
    if (enriched.sidesSwapped !== undefined) {
      ioInstance.to(room).emit('match:sidesSwapped', enriched);
    }
    if (enriched.sportSlug === 'pickleball' || payload.pickleball || payload.teamAScore !== undefined) {
      ioInstance.to(room).emit('match:pickleballScore', enriched);
    }
    if (enriched.sportSlug === 'badminton' || String(payload.type || '').includes('BADMINTON')) {
      ioInstance.to(room).emit('match:badmintonEvent', enriched);
      ioInstance.to(room).emit('match:badmintonPoint', enriched);
    }
    if (enriched.sportSlug === 'football' || String(payload.type || '').includes('FOOTBALL')) {
      ioInstance.to(room).emit('match:footballEvent', enriched);
    }
    if (enriched.status) {
      ioInstance.to(room).emit('match:statusChanged', enriched);
    }
    if (enriched.celebration) {
      ioInstance.to(room).emit('signage:pointScored', enriched);
    }
  }

  // 2. Target Tournament Rooms (for tournament scoreboard, digital signage, TV display)
  const tourneyRooms = new Set();
  if (tournamentId) tourneyRooms.add(`tournament:${tournamentId}`);
  if (tournamentUuid) tourneyRooms.add(`tournament:${tournamentUuid}`);

  for (const tRoom of tourneyRooms) {
    ioInstance.to(tRoom).emit('tournament:matchUpdated', enriched);
    ioInstance.to(tRoom).emit('signage:matchUpdate', enriched);
    ioInstance.to(tRoom).emit('score:updated', enriched);
    ioInstance.to(tRoom).emit('match:ballEvent', enriched);
    ioInstance.to(tRoom).emit('match:pointScored', enriched);

    if (enriched.type === 'UNDO') {
      ioInstance.to(tRoom).emit('match:undone', enriched);
      ioInstance.to(tRoom).emit('match:undoPoint', enriched);
    }
    if (enriched.sidesSwapped !== undefined) {
      ioInstance.to(tRoom).emit('match:sidesSwapped', enriched);
    }
    if (enriched.sportSlug === 'pickleball' || payload.pickleball || payload.teamAScore !== undefined) {
      ioInstance.to(tRoom).emit('match:pickleballScore', enriched);
    }
    if (enriched.sportSlug === 'badminton') {
      ioInstance.to(tRoom).emit('match:badmintonEvent', enriched);
    }
    if (enriched.sportSlug === 'football') {
      ioInstance.to(tRoom).emit('match:footballEvent', enriched);
    }
    if (enriched.celebration) {
      ioInstance.to(tRoom).emit('signage:pointScored', enriched);
    }
    if (enriched.isCompleted || enriched.status === 'COMPLETED') {
      ioInstance.to(tRoom).emit('tournament:standingsUpdated', {
        tournamentId: tournamentUuid || tournamentId,
        completedMatchId: uuidStr || numericId
      });
    }
  }
}

/**
 * Backward-compatible helper for lightweight tournament match updates.
 */
function broadcastTournamentMatchUpdate(tournamentPublicId, matchData) {
  const matchId = matchData.public_id || matchData.matchId || matchData.id;
  broadcastScoreSync(matchId, {
    tournamentId: tournamentPublicId,
    ...matchData
  }).catch(() => {});
}

/**
 * Backward-compatible helper for detailed delivery/ball events.
 */
function broadcastMatchBallEvent(matchPublicId, eventData) {
  broadcastScoreSync(matchPublicId, eventData).catch(() => {});
}

/**
 * Broadcast advertisement and signage control events in real-time.
 */
function broadcastSignageEvent(eventName, data, tournamentPublicId = null) {
  if (!ioInstance) return;
  if (tournamentPublicId) {
    ioInstance.to(`tournament:${tournamentPublicId}`).emit(eventName, data);
  } else {
    ioInstance.emit(eventName, data);
  }
}

/**
 * Broadcast auction events to all subscribers in auction room.
 */
function broadcastAuctionEvent(auctionPublicId, eventName, data) {
  if (!ioInstance) return;
  const room = `auction:${auctionPublicId}`;
  ioInstance.to(room).emit(eventName, data);
}

/**
 * Backward-compatible helper for pickleball live scoring.
 */
function broadcastPickleballScore(matchPublicId, tournamentPublicId, payload) {
  broadcastScoreSync(matchPublicId, {
    tournamentId: tournamentPublicId,
    sportSlug: 'pickleball',
    ...payload
  }).catch(() => {});
}

module.exports = {
  initSocket,
  getIO,
  resolveMatchIdentifiers,
  resolveTournamentIdentifiers,
  broadcastScoreSync,
  broadcastTournamentMatchUpdate,
  broadcastMatchBallEvent,
  broadcastSignageEvent,
  broadcastAuctionEvent,
  broadcastPickleballScore
};
