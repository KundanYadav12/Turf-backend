const db = require('../config/database');
const { getIO } = require('./socketService');

// In-memory registry of active match breaks for instant sub-millisecond retrieval & timers
const activeBreaks = new Map(); // matchId (string) -> breakState

/**
 * Start or update a match break (Timeout, Interval, Game break, Technical, Other)
 * Authorized: Super Admin, match owner, tournament organizer, assigned scorer, or broadcaster.
 */
async function startBreak(matchId, { reason = 'Timeout', durationMinutes = 0 } = {}, user = {}) {
  const normId = String(matchId);
  const validReasons = ['Timeout', 'Interval', 'Game break', 'Technical', 'Other'];
  const cleanReason = validReasons.includes(reason) ? reason : 'Timeout';
  const duration = Math.max(0, parseInt(durationMinutes, 10) || 0);

  const now = new Date();
  const startedAt = now.toISOString();
  let expectedEndAt = null;
  if (duration > 0) {
    expectedEndAt = new Date(now.getTime() + duration * 60000).toISOString();
  }

  // Clear existing timer if any
  if (activeBreaks.has(normId)) {
    const existing = activeBreaks.get(normId);
    if (existing?.timer) clearTimeout(existing.timer);
  }

  // Set safety auto-clear timer (duration + 2 min grace period, or 30 min max safety)
  const autoClearMs = duration > 0 ? (duration * 60000 + 120000) : (30 * 60000);
  const timer = setTimeout(() => {
    endBreak(normId, { id: 'SYSTEM', full_name: 'Auto-Clear (Grace Period Passed)' }).catch(() => {});
  }, autoClearMs);

  const breakState = {
    matchId: normId,
    isBreak: true,
    reason: cleanReason,
    durationMinutes: duration,
    startedAt,
    expectedEndAt,
    startedBy: user?.full_name || user?.name || 'Authorized Scorer',
    timer
  };

  activeBreaks.set(normId, breakState);

  // Broadcast in real-time via WebSocket
  const io = getIO();
  if (io) {
    const eventPayload = {
      matchId: normId,
      isBreak: true,
      reason: cleanReason,
      durationMinutes: duration,
      startedAt,
      expectedEndAt,
      timestamp: Date.now()
    };
    io.to(`match:${normId}`).emit('match:break:start', eventPayload);
    io.to(`match:${normId}`).emit('match:break_updated', eventPayload);
    io.to(`stream:${normId}`).emit('stream:break_state', eventPayload);
  }

  // Persist asynchronously in database without blocking response
  try {
    const serialized = JSON.stringify({
      isBreak: true,
      reason: cleanReason,
      durationMinutes: duration,
      startedAt,
      expectedEndAt
    });
    await db.query(`
      UPDATE tournament_matches 
      SET period_state = JSON_SET(COALESCE(period_state, '{}'), '$.breakState', ?)
      WHERE uuid = ? OR id = ?
    `, [serialized, normId, isNaN(normId) ? 0 : parseInt(normId, 10)]);

    console.log(`[BREAK_AUDIT] Match ${normId} Break Started: ${cleanReason} (${duration}m) by ${user?.full_name || 'Admin'}`);
  } catch (err) {
    console.warn('[MatchBreak] DB persist warning:', err.message);
  }

  return {
    matchId: normId,
    isBreak: true,
    reason: cleanReason,
    durationMinutes: duration,
    startedAt,
    expectedEndAt
  };
}

/**
 * End a match break and return stream/viewers to normal live view
 */
async function endBreak(matchId, user = {}) {
  const normId = String(matchId);

  if (activeBreaks.has(normId)) {
    const existing = activeBreaks.get(normId);
    if (existing?.timer) clearTimeout(existing.timer);
    activeBreaks.delete(normId);
  }

  const io = getIO();
  if (io) {
    const eventPayload = {
      matchId: normId,
      isBreak: false,
      endedAt: new Date().toISOString(),
      timestamp: Date.now()
    };
    io.to(`match:${normId}`).emit('match:break:end', eventPayload);
    io.to(`match:${normId}`).emit('match:break_updated', eventPayload);
    io.to(`stream:${normId}`).emit('stream:break_state', eventPayload);
  }

  try {
    const serialized = JSON.stringify({ isBreak: false, endedAt: new Date().toISOString() });
    await db.query(`
      UPDATE tournament_matches 
      SET period_state = JSON_SET(COALESCE(period_state, '{}'), '$.breakState', ?)
      WHERE uuid = ? OR id = ?
    `, [serialized, normId, isNaN(normId) ? 0 : parseInt(normId, 10)]);

    console.log(`[BREAK_AUDIT] Match ${normId} Break Ended by ${user?.full_name || 'Scorer/Admin'}`);
  } catch (err) {
    console.warn('[MatchBreak] DB persist warning:', err.message);
  }

  return {
    matchId: normId,
    isBreak: false
  };
}

/**
 * Get current break state for a match
 */
async function getBreakState(matchId) {
  const normId = String(matchId);
  if (activeBreaks.has(normId)) {
    const state = activeBreaks.get(normId);
    if (state.expectedEndAt) {
      const expTime = new Date(state.expectedEndAt).getTime();
      if (Date.now() > expTime + 120000) {
        // Auto-cleared after grace period
        if (state.timer) clearTimeout(state.timer);
        activeBreaks.delete(normId);
        return { matchId: normId, isBreak: false };
      }
    }
    return {
      matchId: normId,
      isBreak: true,
      reason: state.reason,
      durationMinutes: state.durationMinutes,
      startedAt: state.startedAt,
      expectedEndAt: state.expectedEndAt
    };
  }

  // Check DB for late joiner / after process restart
  try {
    const rows = await db.query(
      `SELECT period_state FROM tournament_matches WHERE uuid = ? OR id = ? LIMIT 1`,
      [normId, isNaN(normId) ? 0 : parseInt(normId, 10)]
    );
    if (rows.length > 0 && rows[0].period_state) {
      let ps = rows[0].period_state;
      if (typeof ps === 'string') {
        try { ps = JSON.parse(ps); } catch (e) { ps = {}; }
      }
      if (ps?.breakState && ps.breakState.isBreak) {
        const bs = ps.breakState;
        if (bs.expectedEndAt && Date.now() > new Date(bs.expectedEndAt).getTime() + 120000) {
          return { matchId: normId, isBreak: false };
        }
        return {
          matchId: normId,
          isBreak: true,
          reason: bs.reason || 'Timeout',
          durationMinutes: bs.durationMinutes || 0,
          startedAt: bs.startedAt,
          expectedEndAt: bs.expectedEndAt
        };
      }
    }
  } catch (e) {}

  return { matchId: normId, isBreak: false };
}

module.exports = {
  startBreak,
  endBreak,
  getBreakState
};
