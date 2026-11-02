const db = require('../config/database');
const { checkUserCanScoreMatch } = require('../services/scorerAccessService');

/**
 * Middleware: Enforces that the authenticated user has permission to score the requested match.
 * Permits: ADMIN, Tournament Creator, Venue Owner, Assigned Scorer (tournament-wide or match-specific).
 * Denies: 404 if match or tournament doesn't exist/mismatch; 403 Forbidden for unauthorized users.
 */
async function requireScorerForMatch(req, res, next) {
  try {
    const matchId = req.params.id || req.params.matchId || req.body.matchId;
    if (!matchId) {
      return res.status(400).json({ success: false, message: 'Match identifier is required.' });
    }

    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    // 1. Verify match existence
    const isNum = /^\d+$/.test(String(matchId).trim());
    const [match] = await db.query(
      'SELECT id, tournament_id FROM tournament_matches WHERE uuid = ? OR id = ?',
      [matchId, isNum ? parseInt(matchId, 10) : -1]
    );
    if (!match) {
      return res.status(404).json({ success: false, message: 'Match not found.' });
    }

    // 2. If tournament route param is present, verify match belongs to the specified tournament
    const routeTournId = req.params.tournamentId || req.params.tournament_id;
    if (routeTournId) {
      const isTournNum = /^\d+$/.test(String(routeTournId).trim());
      const [tourn] = await db.query(
        'SELECT id FROM tournaments WHERE uuid = ? OR id = ?',
        [routeTournId, isTournNum ? parseInt(routeTournId, 10) : -1]
      );
      if (!tourn || match.tournament_id !== tourn.id) {
        return res.status(404).json({ success: false, message: 'Match does not belong to the specified tournament.' });
      }
    }

    // 3. Fast-path: Super Admin and Admin have universal, unrestricted scorer access
    const roleUpper = String(req.user.role || '').toUpperCase();
    if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') {
      return next();
    }

    // 4. Strict check against match's tournament_id and scorer assignment
    const canScore = await checkUserCanScoreMatch({
      userId: req.user.id,
      userRole: req.user.role,
      matchPublicOrInternalId: match.id
    });

    if (!canScore) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: You are not assigned as an authorized scorer for this match.'
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  requireScorerForMatch
};
