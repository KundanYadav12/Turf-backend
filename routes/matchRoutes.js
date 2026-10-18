const express = require('express');
const router = express.Router();
const matchService = require('../services/matchService');
const cricketScorerService = require('../services/cricketScorerService');
const universalUndoService = require('../services/universalUndoService');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');

// 1. GET /api/matches/:id - Single Match Detailed State (Public / Viewers)
router.get('/:id', async (req, res, next) => {
  try {
    const match = await matchService.getMatchByPublicId(req.params.id);
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

// 4. GET /api/matches/:id/scorer - Full Scorer Console State (Protected: Scorer / Owner / Admin)
router.get('/:id/scorer', authenticateUser, async (req, res, next) => {
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
router.post('/:id/toss', authenticateUser, async (req, res, next) => {
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
router.post('/:id/deliveries', authenticateUser, async (req, res, next) => {
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

    const result = await cricketScorerService.recordDelivery({
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

    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 7. POST /api/matches/:id/bowler - Switch / Assign Bowler at Over End (Protected)
router.post('/:id/bowler', authenticateUser, async (req, res, next) => {
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
    const result = await universalUndoService.performUndo(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Also support sport-specific undo aliases for backwards compatibility
router.post('/:id/cricket/undo', authenticateUser, async (req, res, next) => {
  try {
    const result = await universalUndoService.performUndo(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 9. POST /api/matches/:id/innings/second - Start 2nd Innings (Protected)
router.post('/:id/innings/second', authenticateUser, async (req, res, next) => {
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
router.post('/:id/complete', authenticateUser, async (req, res, next) => {
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
router.post('/:id/pickleball/lineup', authenticateUser, async (req, res, next) => {
  try {
    const data = await pickleballService.setLineup(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Lineup saved successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 13. POST /api/matches/:id/pickleball/start - Start Match Live
router.post('/:id/pickleball/start', authenticateUser, async (req, res, next) => {
  try {
    const data = await pickleballService.startMatch(req.params.id, req.user);
    res.json({ success: true, message: 'Match started!', data });
  } catch (error) {
    next(error);
  }
});

// 14. POST /api/matches/:id/pickleball/point - Record Point (+1 Team A / +1 Team B)
router.post('/:id/pickleball/point', authenticateUser, async (req, res, next) => {
  try {
    const data = await pickleballService.recordPoint(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Point recorded!', data });
  } catch (error) {
    next(error);
  }
});

// 15. POST /api/matches/:id/pickleball/undo - Undo Last Point
router.post('/:id/pickleball/undo', authenticateUser, async (req, res, next) => {
  try {
    const data = await pickleballService.undoPoint(req.params.id, req.user);
    res.json({ success: true, message: 'Last action undone!', data });
  } catch (error) {
    next(error);
  }
});

// 16. POST /api/matches/:id/pickleball/correct - Correct Score (Authorized correction)
router.post('/:id/pickleball/correct', authenticateUser, async (req, res, next) => {
  try {
    const data = await pickleballService.correctScore(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Score corrected successfully!', data });
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
router.post('/:id/football/lineup', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.setLineups(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 19. POST /api/matches/:id/football/period - Change Match Period / Clock
router.post('/:id/football/period', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.updatePeriod(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 20. POST /api/matches/:id/football/goal - Record Goal
router.post('/:id/football/goal', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.recordGoal(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 21. POST /api/matches/:id/football/card - Record Yellow/Red Card
router.post('/:id/football/card', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.recordCard(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 22. POST /api/matches/:id/football/sub - Record Substitution
router.post('/:id/football/sub', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.recordSubstitution(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 23. POST /api/matches/:id/football/undo - Undo Last Event
router.post('/:id/football/undo', authenticateUser, async (req, res, next) => {
  try {
    const data = await footballScorerService.undoLastEvent(req.params.id, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 24. POST /api/matches/:id/football/complete - Complete Match & Recalculate Standings
router.post('/:id/football/complete', authenticateUser, async (req, res, next) => {
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
router.post('/:id/badminton/lineup', authenticateUser, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.setLineup(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 27. POST /api/matches/:id/badminton/start - Start Match Live
router.post('/:id/badminton/start', authenticateUser, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.startMatch(req.params.id, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 28. POST /api/matches/:id/badminton/point - Record Point (+1 Side A / Side B)
router.post('/:id/badminton/point', authenticateUser, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.recordPoint(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 29. POST /api/matches/:id/badminton/undo - Undo Last Point
router.post('/:id/badminton/undo', authenticateUser, async (req, res, next) => {
  try {
    const data = await badmintonScorerService.undoPoint(req.params.id, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
