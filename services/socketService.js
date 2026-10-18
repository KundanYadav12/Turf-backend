let ioInstance = null;

/**
 * Initializes Socket.IO with CORS and room partition architecture.
 */
function initSocket(server) {
  const { Server } = require('socket.io');
  const { TRUSTED_ORIGINS } = require('../config/siteConfig');
  const io = new Server(server, {
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

    // 8. Join User Room (for private notifications)
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
  });

  ioInstance = io;
  return io;
}

function getIO() {
  return ioInstance;
}

/**
 * Broadcast lightweight summary event to Tournament-level subscribers only.
 * Payload: ~80-100 bytes.
 */
function broadcastTournamentMatchUpdate(tournamentPublicId, matchData) {
  if (!ioInstance) return;
  const room = `tournament:${tournamentPublicId}`;
  ioInstance.to(room).emit('tournament:matchUpdated', {
    matchId: matchData.public_id || matchData.matchId || matchData.id,
    status: matchData.status,
    liveScoreSummary: matchData.live_score_summary || matchData.liveScoreSummary,
    liveSubtext: matchData.live_subtext || matchData.liveSubtext,
    courtName: matchData.court_name || matchData.courtName,
    celebration: matchData.celebration,
    type: matchData.type,
    state: matchData.state
  });
}

/**
 * Broadcast detailed ball/point event to Match-level subscribers only.
 * Payload: detailed scorecard / event data.
 */
function broadcastMatchBallEvent(matchPublicId, eventData) {
  if (!ioInstance) return;
  const room = `match:${matchPublicId}`;
  ioInstance.to(room).emit('match:ballEvent', eventData);
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
  ioInstance.to(matchRoom).emit('match:pickleballScore', payload);

  if (tournamentPublicId) {
    const tourneyRoom = `tournament:${tournamentPublicId}`;
    ioInstance.to(tourneyRoom).emit('tournament:matchUpdated', {
      matchId: matchPublicId,
      status: payload.status,
      liveScoreSummary: `${payload.teamAScore} - ${payload.teamBScore}`,
      teamAScore: payload.teamAScore,
      teamBScore: payload.teamBScore,
      winnerTeamId: payload.winnerTeamId,
      resultSummary: payload.resultSummary
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
