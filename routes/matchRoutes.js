const express = require('express');
const router = express.Router();
const matchService = require('../services/matchService');
const cricketScorerService = require('../services/cricketScorerService');
const universalUndoService = require('../services/universalUndoService');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const { requireScorerForMatch } = require('../middleware/scorerAuthMiddleware');
const db = require('../config/database');
const { getIO } = require('../services/socketService');

// In-Memory Async Scoring Mutex per Match
// Prevents duplicate score points from rapid double-clicks and guarantees strict sequential execution
const matchScoringMutexes = new Map();
const recentScoringActionSignatures = new Map();

async function withMatchLock(matchId, actionFn) {
  const key = String(matchId).trim();
  const prevPromise = matchScoringMutexes.get(key) || Promise.resolve();
  let release;
  const nextLockPromise = new Promise((resolve) => { release = resolve; });
  matchScoringMutexes.set(key, prevPromise.then(() => nextLockPromise));

  try {
    await prevPromise;
    return await actionFn();
  } finally {
    release();
    if (matchScoringMutexes.get(key) === nextLockPromise) {
      matchScoringMutexes.delete(key);
    }
  }
}

/**
 * Checks for rapid double-click idempotency within 300ms window
 */
function checkScoringDebounce(matchId, userId, actionKey) {
  const key = `${matchId}_${userId}_${actionKey}`;
  const now = Date.now();
  const lastTime = recentScoringActionSignatures.get(key);
  if (lastTime && (now - lastTime) < 300) {
    return true; // Too fast, double click detected
  }
  recentScoringActionSignatures.set(key, now);
  // Keep cache small
  if (recentScoringActionSignatures.size > 1000) {
    for (const [k, t] of recentScoringActionSignatures) {
      if (now - t > 10000) recentScoringActionSignatures.delete(k);
    }
  }
  return false;
}

// 0. GET /api/matches/live - All active LIVE matches across the platform (concurrent/multi-tournament)
router.get('/live', async (req, res, next) => {
  try {
    const { tournamentId, sport, limit } = req.query;
    const matches = await matchService.getAllLiveMatches({ tournamentId, sport, limit });
    res.json({
      success: true,
      data: {
        items: matches,
        count: matches.length
      }
    });
  } catch (error) {
    next(error);
  }
});

// 0b. GET /api/matches - Match query route supporting ?status=LIVE filter
router.get('/', async (req, res, next) => {
  try {
    const { status, tournamentId, sport, limit } = req.query;
    if (status === 'LIVE' || !status) {
      const matches = await matchService.getAllLiveMatches({ tournamentId, sport, limit });
      return res.json({
        success: true,
        data: {
          items: matches,
          count: matches.length
        }
      });
    }
    // Default fallback
    const matches = await matchService.getAllLiveMatches({ tournamentId, sport, limit });
    res.json({ success: true, data: { items: matches, count: matches.length } });
  } catch (error) {
    next(error);
  }
});

// 1. GET /api/matches/:id - Single Match Detailed State (Public / Viewers)
router.get('/:id', async (req, res, next) => {
  try {
    const tournamentId = req.query.tournamentId || req.query.tournament_id;
    const match = await matchService.getMatchByPublicId(req.params.id, tournamentId);
    if (!match) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }
    res.json({ success: true, data: match });
  } catch (error) {
    next(error);
  }
});

// 2. GET /api/matches/:id/events - Paginated Commentary / Ball events (Public / Viewers)
router.get('/:id/events', async (req, res, next) => {
  try {
    const { cursor, limit } = req.query;
    const result = await matchService.getMatchEventsPaginated(req.params.id, { cursor, limit });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
});

// POST /api/matches/:id/events - Record score simulation event
router.post('/:id/events', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const result = await matchService.recordScoreEvent({
      matchPublicId: req.params.id,
      ...req.body,
      authorId: req.user?.id || req.body.authorId || null,
      authorName: req.user?.full_name || req.body.authorName || 'Match Scorer'
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/matches/:id/commentary - Post Commentary or Live Match Discussion with @mentions
router.post('/:id/commentary', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const { text, commentary, eventType = 'COMMENTARY' } = req.body;
    const commentaryText = text || commentary;
    if (!commentaryText || !commentaryText.trim()) {
      return res.status(400).json({ success: false, message: 'Commentary text is required.' });
    }

    const result = await matchService.recordScoreEvent({
      matchPublicId: req.params.id,
      eventType,
      commentaryText: commentaryText.trim(),
      authorId: req.user?.id || null,
      authorName: req.user?.full_name || 'Fan'
    });

    res.status(201).json({
      success: true,
      message: 'Commentary posted successfully!',
      data: result
    });
  } catch (error) {
    next(error);
  }
});


// 3. GET /api/matches/:id/ads - Stadium Signage / Public Display Advertisements (Top & Bottom)
router.get('/:id/ads', async (req, res, next) => {
  try {
    const ads = await cricketScorerService.getMatchAds(req.params.id);
    res.json({ success: true, data: ads });
  } catch (error) {
    next(error);
  }
});

// 3b. MATCH BREAK MANAGEMENT (Timeout, Interval, Game break, Technical, Other)
const matchBreakService = require('../services/matchBreakService');

async function checkBreakPermission(req, res, next) {
  try {
    const matchId = req.params.id;
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }
    const roleUpper = String(req.user.role || '').toUpperCase();
    if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') {
      return next();
    }
    const { checkUserCanScoreMatch } = require('../services/scorerAccessService');
    const canScore = await checkUserCanScoreMatch({
      userId: req.user.id,
      userRole: req.user.role,
      matchPublicOrInternalId: matchId
    });
    if (canScore) return next();

    const streamService = require('../services/streamService');
    const canStream = await streamService.checkStreamPermission(matchId, req.user);
    if (canStream) return next();

    return res.status(403).json({
      success: false,
      message: 'Forbidden: You do not have permission to manage breaks for this match.'
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/matches/:id/break - Get current break status (Public)
router.get('/:id/break', async (req, res, next) => {
  try {
    const data = await matchBreakService.getBreakState(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// POST /api/matches/:id/break/start - Start match break
router.post('/:id/break/start', authenticateUser, checkBreakPermission, async (req, res, next) => {
  try {
    const { reason, durationMinutes } = req.body;
    const data = await matchBreakService.startBreak(req.params.id, { reason, durationMinutes }, req.user);
    res.json({ success: true, message: `Match break started (${data.reason}).`, data });
  } catch (error) {
    next(error);
  }
});

// POST /api/matches/:id/break/end - End match break
router.post('/:id/break/end', authenticateUser, checkBreakPermission, async (req, res, next) => {
  try {
    const data = await matchBreakService.endBreak(req.params.id, req.user);
    res.json({ success: true, message: 'Match break ended. Live play resumed.', data });
  } catch (error) {
    next(error);
  }
});

// 4. GET /api/matches/:id/scorer - Full Scorer Console State (Protected: Scorer / Owner / Admin)
router.get('/:id/scorer', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const state = await cricketScorerService.getScorerState(req.params.id);
    if (!state) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }
    res.json({ success: true, data: state });
  } catch (error) {
    next(error);
  }
});

// 5. POST /api/matches/:id/toss - Initialize Match with Toss & Opening Lineups (Protected)
router.post('/:id/toss', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const {
      tossWinnerTeamId,
      tossDecision,
      totalOvers = 20,
      strikerId,
      nonStrikerId,
      bowlerId,
      openingStrikerId,
      openingNonStrikerId,
      openingBowlerId
    } = req.body;

    const result = await cricketScorerService.setupToss({
      matchPublicId: req.params.id,
      tossWinnerTeamId,
      tossDecision,
      totalOvers,
      strikerId: strikerId || openingStrikerId,
      nonStrikerId: nonStrikerId || openingNonStrikerId,
      bowlerId: bowlerId || openingBowlerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// 6. POST /api/matches/:id/deliveries - Record a Ball Delivery (Protected)
router.post('/:id/deliveries', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const rawRuns = req.body.runs !== undefined ? req.body.runs : req.body.batRuns;
    const runs = rawRuns !== undefined ? parseInt(rawRuns, 10) : 0;
    const {
      extraType = null,
      extraRuns = 0,
      isWicket = false,
      wicketType = null,
      dismissedPlayerId = null,
      fielderId = null,
      newBatterId = null,
      commentary = null
    } = req.body;

    // Check rapid duplicate submission
    const actionSig = `ball_${runs}_${extraType}_${isWicket}`;
    if (checkScoringDebounce(req.params.id, req.user?.id, actionSig)) {
      const state = await cricketScorerService.getScorerState(req.params.id);
      return res.json({ success: true, duplicated: true, state });
    }

    const result = await withMatchLock(req.params.id, async () => {
      return await cricketScorerService.recordDelivery({
        matchPublicId: req.params.id,
        runs,
        extraType,
        extraRuns: parseInt(extraRuns, 10) || 0,
        isWicket: Boolean(isWicket),
        wicketType,
        dismissedPlayerId,
        fielderId: fielderId || req.body.caughtById || req.body.runOutById || null,
        newBatterId,
        commentary,
        userId: req.user.id,
        userRole: req.user.role
      });
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 7. POST /api/matches/:id/bowler - Switch / Assign Bowler at Over End (Protected)
router.post('/:id/bowler', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { nextBowlerId } = req.body;
    const result = await cricketScorerService.switchBowler({
      matchPublicId: req.params.id,
      nextBowlerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 7.5. GET /api/matches/:id/last-action - Get Last Reversible Action (Any Sport)
router.get('/:id/last-action', async (req, res, next) => {
  try {
    const result = await universalUndoService.getLastAction(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// 7.6. GET /api/matches/:id/undo-history - Get Scoring Undo Audit Trail
router.get('/:id/undo-history', async (req, res, next) => {
  try {
    const history = await universalUndoService.getUndoHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

// 8. POST /api/matches/:id/undo - Universal Undo Last Action Atomically (Protected)
router.post('/:id/undo', authenticateUser, async (req, res, next) => {
  try {
    const result = await withMatchLock(req.params.id, async () => {
      return await universalUndoService.performUndo(req.params.id, req.user);
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Also support sport-specific undo aliases for backwards compatibility
router.post('/:id/cricket/undo', authenticateUser, async (req, res, next) => {
  try {
    const result = await withMatchLock(req.params.id, async () => {
      return await universalUndoService.performUndo(req.params.id, req.user);
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 9. POST /api/matches/:id/innings/second - Start 2nd Innings (Protected)
router.post('/:id/innings/second', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { strikerId, nonStrikerId, bowlerId } = req.body;
    const result = await cricketScorerService.startSecondInnings({
      matchPublicId: req.params.id,
      strikerId,
      nonStrikerId,
      bowlerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 10. POST /api/matches/:id/complete - Complete Match & Finalize Tournament Standings (Protected)
router.post('/:id/complete', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { winnerTeamId, resultSummary } = req.body;
    const result = await cricketScorerService.completeMatch({
      matchPublicId: req.params.id,
      winnerTeamId,
      resultSummary,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// === PICKLEBALL SCORER ROUTES ===
const pickleballService = require('../services/pickleballService');

// 11. GET /api/matches/:id/pickleball - Pickleball Match Full State (Lineup, Scores, Rules, Logs)
router.get('/:id/pickleball', async (req, res, next) => {
  try {
    const data = await pickleballService.getScorerState(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 12. POST /api/matches/:id/pickleball/lineup - Select Singles / Doubles Active Lineup
router.post('/:id/pickleball/lineup', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.setLineup(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Lineup saved successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 13. POST /api/matches/:id/pickleball/start - Start Match Live
router.post('/:id/pickleball/start', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.startMatch(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Match started!', data });
  } catch (error) {
    next(error);
  }
});

// 14. POST /api/matches/:id/pickleball/point - Record Point (+1 Team A / +1 Team B)
router.post('/:id/pickleball/point', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { teamScored, playerId } = req.body;
    const actionSig = `pb_point_${teamScored}_${playerId || ''}`;
    if (checkScoringDebounce(req.params.id, req.user?.id, actionSig)) {
      const data = await pickleballService.getScorerState(req.params.id);
      return res.json({ success: true, duplicated: true, message: 'Point recorded!', data });
    }
    const data = await withMatchLock(req.params.id, async () => {
      return await pickleballService.recordPoint(req.params.id, req.body, req.user);
    });
    res.json({ success: true, message: 'Point recorded!', data });
  } catch (error) {
    next(error);
  }
});

// 15. POST /api/matches/:id/pickleball/undo - Undo Last Point
router.post('/:id/pickleball/undo', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await withMatchLock(req.params.id, async () => {
      return await pickleballService.undoPoint(req.params.id, req.user);
    });
    res.json({ success: true, message: 'Last action undone!', data });
  } catch (error) {
    next(error);
  }
});

// 16. POST /api/matches/:id/pickleball/correct - Correct Score (Authorized correction)
router.post('/:id/pickleball/correct', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.correctScore(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Score corrected successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 16b. POST /api/matches/:id/pickleball/rule - Toggle Rotation / Playing Rule (OFFICIAL vs BADMINTON)
router.post('/:id/pickleball/rule', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.setRotationRule(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Playing rule updated successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 16c. POST /api/matches/:id/pickleball/golden-target - Set / Edit Golden Point Target (Scorer only)
router.post('/:id/pickleball/golden-target', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.setGoldenPointTarget(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Golden Point target confirmed successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 16d. POST /api/matches/:id/pickleball/golden-point-toggle - Toggle Golden Point Enabled before tie (Scorer only)
router.post('/:id/pickleball/golden-point-toggle', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.setGoldenPointSetting(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Golden Point setting updated successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 16e. POST /api/matches/:id/pickleball/switch-ends - Switch court ends / sidesSwapped (Scorer only)
router.post('/:id/pickleball/switch-ends', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await pickleballService.setSidesSwapped(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Court ends switched successfully!', data });
  } catch (error) {
    next(error);
  }
});

// ==========================================
// === FOOTBALL SCORER ROUTES ===
// ==========================================
const footballScorerService = require('../services/footballScorerService');

// 17. GET /api/matches/:id/football - Football Scorer State
router.get('/:id/football', async (req, res, next) => {
  try {
    const data = await footballScorerService.getScorerState(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Match not found.' });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 18. POST /api/matches/:id/football/lineup - Set Lineups (XI + Subs)
router.post('/:id/football/lineup', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await footballScorerService.setLineups(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 19. POST /api/matches/:id/football/period - Change Match Period / Clock
router.post('/:id/football/period', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await footballScorerService.updatePeriod(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 20. POST /api/matches/:id/football/goal - Record Goal
router.post('/:id/football/goal', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { teamId, playerId } = req.body;
    const actionSig = `fb_goal_${teamId}_${playerId || ''}`;
    if (checkScoringDebounce(req.params.id, req.user?.id, actionSig)) {
      const data = await footballScorerService.getScorerState(req.params.id);
      return res.json({ success: true, duplicated: true, data });
    }
    const data = await withMatchLock(req.params.id, async () => {
      return await footballScorerService.recordGoal(req.params.id, req.body, req.user);
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 21. POST /api/matches/:id/football/card - Record Yellow/Red Card
router.post('/:id/football/card', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await footballScorerService.recordCard(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 22. POST /api/matches/:id/football/sub - Record Substitution
router.post('/:id/football/sub', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await footballScorerService.recordSubstitution(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 23. POST /api/matches/:id/football/undo - Undo Last Event
router.post('/:id/football/undo', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await withMatchLock(req.params.id, async () => {
      return await footballScorerService.undoLastEvent(req.params.id, req.user);
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 24. POST /api/matches/:id/football/complete - Complete Match & Recalculate Standings
router.post('/:id/football/complete', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await footballScorerService.completeMatch(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// === BADMINTON SCORER ROUTES ===
// ==========================================
const badmintonScorerService = require('../services/badmintonScorerService');

// 25. GET /api/matches/:id/badminton - Badminton Match State
router.get('/:id/badminton', async (req, res, next) => {
  try {
    const data = await badmintonScorerService.getScorerState(req.params.id);
    if (!data) return res.status(404).json({ success: false, message: 'Match not found.' });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 26. POST /api/matches/:id/badminton/lineup - Set Singles or Doubles Lineup
router.post('/:id/badminton/lineup', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.setLineup(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 27. POST /api/matches/:id/badminton/start - Start Match Live
router.post('/:id/badminton/start', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.startMatch(req.params.id, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 28. POST /api/matches/:id/badminton/point - Record Point (+1 Side A / Side B)
router.post('/:id/badminton/point', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const { sideScored, playerId } = req.body;
    const actionSig = `bm_point_${sideScored}_${playerId || ''}`;
    if (checkScoringDebounce(req.params.id, req.user?.id, actionSig)) {
      const data = await badmintonScorerService.getScorerState(req.params.id);
      return res.json({ success: true, duplicated: true, data });
    }
    const data = await withMatchLock(req.params.id, async () => {
      return await badmintonScorerService.recordPoint(req.params.id, req.body, req.user);
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 29. POST /api/matches/:id/badminton/undo - Undo Last Point
router.post('/:id/badminton/undo', authenticateUser, requireScorerForMatch, async (req, res, next) => {
  try {
    const data = await withMatchLock(req.params.id, async () => {
      return await badmintonScorerService.undoPoint(req.params.id, req.user);
    });
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// === TRACK POINTS BY PLAYER TOGGLE (COURT SPORTS) ===
async function handleToggleTrackPlayerPoints(req, res, next) {
  try {
    const { enabled, trackPlayerPoints } = req.body;
    const isEnabled = Boolean(trackPlayerPoints !== undefined ? trackPlayerPoints : enabled);
    const matchId = req.params.id;

    const rows = await db.query(
      `SELECT id, uuid, tournament_id, sport_state FROM tournament_matches WHERE uuid = ? OR id = ?`,
      [matchId, isNaN(matchId) ? -1 : parseInt(matchId, 10)]
    );
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }
    const match = rows[0];

    let sportState = {};
    if (match.sport_state) {
      try {
        sportState = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : match.sport_state;
      } catch (e) {}
    }
    sportState.trackPlayerPoints = isEnabled;

    await db.query(
      `UPDATE tournament_matches 
       SET track_player_points = ?, sport_state = ? 
       WHERE id = ?`,
      [isEnabled ? 1 : 0, JSON.stringify(sportState), match.id]
    );

    try {
      const io = getIO();
      if (io) {
        const payload = {
          matchId: match.uuid,
          internalMatchId: match.id,
          tournamentId: match.tournament_id,
          trackPlayerPoints: isEnabled
        };
        io.to(`match:${match.uuid}`).emit('match:trackPlayerPointsUpdated', payload);
        io.to(`match:${match.id}`).emit('match:trackPlayerPointsUpdated', payload);
        io.to(`tournament:${match.tournament_id}`).emit('match:trackPlayerPointsUpdated', payload);
        io.emit('match:trackPlayerPointsUpdated', payload);
      }
    } catch (e) {
      console.error('Socket emit error in track-player-points:', e);
    }

    res.json({
      success: true,
      message: `Point tracking by player ${isEnabled ? 'enabled' : 'disabled'}.`,
      trackPlayerPoints: isEnabled
    });
  } catch (error) {
    next(error);
  }
}

// 30. POST /api/matches/:id/track-player-points - Toggle player tracking
router.post('/:id/track-player-points', authenticateUser, requireScorerForMatch, handleToggleTrackPlayerPoints);
router.post('/:id/pickleball/track-player-points', authenticateUser, requireScorerForMatch, handleToggleTrackPlayerPoints);
router.post('/:id/badminton/track-player-points', authenticateUser, requireScorerForMatch, handleToggleTrackPlayerPoints);

module.exports = router;
