let ioInstance = null;
const broadcasterDisconnectTimers = new Map();

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
    // 1. Join Tournament Room
    socket.on('join:tournament', ({ tournamentId }) => {
      if (tournamentId) {
        const room = `tournament:${tournamentId}`;
        socket.join(room);
      }
    });

    // 2. Leave Tournament Room
    socket.on('leave:tournament', ({ tournamentId }) => {
      if (tournamentId) {
        const room = `tournament:${tournamentId}`;
        socket.leave(room);
      }
    });

    // 3. Join Match Room
    socket.on('join:match', ({ matchId }) => {
      if (matchId) {
        const room = `match:${matchId}`;
        socket.join(room);
      }
    });

    // 4. Leave Match Room
    socket.on('leave:match', ({ matchId }) => {
      if (matchId) {
        const room = `match:${matchId}`;
        socket.leave(room);
      }
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

    // 8. Forward Live Point Scored Ball Motion across Match, TV, and Signage
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
          io.to(`tournament:${payload.tournamentId}`).emit('match:pointScored', enriched);
          io.to(`tournament:${payload.tournamentId}`).emit('tournament:matchUpdated', {
            matchId: payload.matchId,
            liveScoreSummary: payload.scoreSummary,
            liveSubtext: payload.subtext,
            status: payload.status,
            type: payload.type,
            celebration: payload.celebration,
            eventSeq: enriched.eventSeq
          });
        }
        io.emit('signage:pointScored', enriched);
        io.emit('signage:matchUpdate', {
          matchId: payload.matchId,
          liveScoreSummary: payload.scoreSummary,
          liveSubtext: payload.subtext,
          status: payload.status,
          eventSeq: enriched.eventSeq
        });
      }
    });

    // 9. Forward Undo Point across TV and Signage
    socket.on('match:undoPoint', (payload) => {
      if (payload && payload.matchId) {
        const undoPayload = { ...payload, type: 'UNDO', timestamp: Date.now() };
        io.to(`match:${payload.matchId}`).emit('match:undoPoint', undoPayload);
        io.to(`match:${payload.matchId}`).emit('match:undone', undoPayload);
        if (payload.tournamentId) {
          io.to(`tournament:${payload.tournamentId}`).emit('match:undoPoint', undoPayload);
          io.to(`tournament:${payload.tournamentId}`).emit('tournament:matchUpdated', undoPayload);
        }
        io.emit('signage:pointScored', undoPayload);
        io.emit('signage:matchUpdate', undoPayload);
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
    socket.on('stream:join', ({ matchId, isBroadcaster }) => {
      if (matchId) {
        const streamRoom = `stream:${matchId}`;
        socket.join(streamRoom);
        socket.streamMatchId = matchId;
        socket.isBroadcaster = Boolean(isBroadcaster);

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
 * Broadcast lightweight summary event to Tournament-level and Match-level subscribers.
 * Payload: ~80-120 bytes with monotonic sequence/timestamp.
 */
function broadcastTournamentMatchUpdate(tournamentPublicId, matchData) {
  if (!ioInstance) return;
  const matchId = matchData.public_id || matchData.matchId || matchData.id;
  const eventSeq = matchData.eventSeq || matchData.seq || Date.now();
  const eventPayload = {
    matchId,
    public_id: matchId,
    eventSeq,
    timestamp: Date.now(),
    status: matchData.status,
    liveScoreSummary: matchData.live_score_summary || matchData.liveScoreSummary,
    liveSubtext: matchData.live_subtext || matchData.liveSubtext,
    courtName: matchData.court_name || matchData.courtName,
    celebration: matchData.celebration,
    type: matchData.type,
    state: matchData.state
  };

  // 1. Broadcast to Tournament Room
  if (tournamentPublicId) {
    const room = `tournament:${tournamentPublicId}`;
    ioInstance.to(room).emit('tournament:matchUpdated', eventPayload);
    ioInstance.to(room).emit('signage:matchUpdate', eventPayload);
  }

  // 2. Broadcast to Match Room
  if (matchId) {
    const matchRoom = `match:${matchId}`;
    ioInstance.to(matchRoom).emit('tournament:matchUpdated', eventPayload);
    ioInstance.to(matchRoom).emit('match:statusChanged', eventPayload);
    ioInstance.to(matchRoom).emit('score:updated', eventPayload);
  }

  // 3. Global broadcast to all connected Signage & Smart TV displays
  ioInstance.emit('signage:matchUpdate', eventPayload);
  ioInstance.emit('tournament:matchUpdated', eventPayload);
}

/**
 * Broadcast detailed ball/point event to Match and Tournament subscribers.
 * Includes score:updated, match:ballEvent, match:pointScored aliases for 100% display coverage.
 */
function broadcastMatchBallEvent(matchPublicId, eventData) {
  if (!ioInstance) return;
  const matchRoom = `match:${matchPublicId}`;
  const eventSeq = eventData.eventSeq || eventData.seq || Date.now();
  const enriched = {
    matchId: matchPublicId,
    eventSeq,
    timestamp: Date.now(),
    ...eventData
  };

  // Emit to match room with all aliases used across web, mobile, TV, signage
  ioInstance.to(matchRoom).emit('match:ballEvent', enriched);
  ioInstance.to(matchRoom).emit('score:updated', enriched);
  ioInstance.to(matchRoom).emit('match:pointScored', enriched);

  // Global Signage / TV event
  ioInstance.emit('signage:pointScored', enriched);
  ioInstance.emit('signage:matchUpdate', {
    matchId: matchPublicId,
    status: eventData.status || 'LIVE',
    liveScoreSummary: eventData.scoreSummary,
    liveSubtext: eventData.subtext,
    celebration: eventData.celebration,
    type: eventData.type,
    state: eventData.state,
    eventSeq
  });

  // Cross-post to tournament room if tournament ID is provided
  const tId = eventData.tournamentId || eventData.tournamentPublicId || eventData.tournament_uuid;
  if (tId) {
    const tRoom = `tournament:${tId}`;
    ioInstance.to(tRoom).emit('tournament:matchUpdated', {
      matchId: matchPublicId,
      status: eventData.status || 'LIVE',
      liveScoreSummary: eventData.scoreSummary,
      liveSubtext: eventData.subtext,
      celebration: eventData.celebration,
      type: eventData.type,
      state: eventData.state,
      eventSeq
    });
    ioInstance.to(tRoom).emit('match:ballEvent', enriched);
    ioInstance.to(tRoom).emit('score:updated', enriched);
  }
}

/**
 * Broadcast advertisement and signage control events in real-time.
 */
function broadcastSignageEvent(eventName, data, tournamentPublicId = null) {
  if (!ioInstance) return;
  // Emit globally to all connected signage boards
  ioInstance.emit(eventName, data);
  // Also emit specifically to tournament room if targeted
  if (tournamentPublicId) {
    ioInstance.to(`tournament:${tournamentPublicId}`).emit(eventName, data);
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
 * Broadcast pickleball live score event to match and tournament rooms.
 */
function broadcastPickleballScore(matchPublicId, tournamentPublicId, payload) {
  if (!ioInstance) return;
  const matchRoom = `match:${matchPublicId}`;
  const eventSeq = payload.eventSeq || (payload.state?.eventSeq || Date.now());
  const enrichedPayload = {
    matchId: matchPublicId,
    eventSeq,
    type: payload.type || 'POINT',
    scoreSummary: payload.scoreSummary || `${payload.teamAScore} - ${payload.teamBScore}`,
    ...payload
  };
  ioInstance.to(matchRoom).emit('match:pickleballScore', enrichedPayload);

  if (payload.pointEvent || payload.type === 'POINT_SCORED') {
    const ptEvent = payload.pointEvent || {
      type: 'POINT_SCORED',
      matchId: matchPublicId,
      eventId: payload.eventId || `pt-${matchPublicId}-${eventSeq}`,
      seq: eventSeq,
      from: payload.from,
      to: payload.to,
      timestamp: Date.now()
    };
    ioInstance.to(matchRoom).emit('match:pointScored', ptEvent);
    ioInstance.emit('signage:pointScored', ptEvent);
  } else if (payload.type === 'UNDO') {
    ioInstance.to(matchRoom).emit('match:undoPoint', { matchId: matchPublicId, type: 'UNDO', timestamp: Date.now() });
    ioInstance.emit('signage:pointScored', { matchId: matchPublicId, type: 'UNDO', timestamp: Date.now() });
  }

  if (tournamentPublicId) {
    const tourneyRoom = `tournament:${tournamentPublicId}`;
    ioInstance.to(tourneyRoom).emit('tournament:matchUpdated', {
      matchId: matchPublicId,
      status: payload.status,
      liveScoreSummary: enrichedPayload.scoreSummary,
      liveSubtext: payload.liveSubtext,
      teamAScore: payload.teamAScore,
      teamBScore: payload.teamBScore,
      winnerTeamId: payload.winnerTeamId,
      resultSummary: payload.resultSummary,
      state: payload.state,
      eventSeq,
      type: enrichedPayload.type,
      pointEvent: payload.pointEvent
    });

    if (payload.isCompleted) {
      ioInstance.to(tourneyRoom).emit('tournament:standingsUpdated', {
        tournamentId: tournamentPublicId,
        completedMatchId: matchPublicId
      });
    }
  }
}

module.exports = {
  initSocket,
  getIO,
  broadcastTournamentMatchUpdate,
  broadcastMatchBallEvent,
  broadcastSignageEvent,
  broadcastAuctionEvent,
  broadcastPickleballScore
};
