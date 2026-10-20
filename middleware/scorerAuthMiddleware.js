const { checkUserCanScoreMatch } = require('../services/scorerAccessService');

/**
 * Middleware: Enforces that the authenticated user has permission to score the requested match.
 * Permits: ADMIN, Tournament Creator, Venue Owner, Assigned Scorer (tournament-wide or match-specific).
 * Denies: Unauthorized users with 403 Forbidden.
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

    // Fast-path: Super Admin and Admin have universal, unrestricted scorer access
    const roleUpper = String(req.user.role || '').toUpperCase();
    if (roleUpper === 'ADMIN' || roleUpper === 'SUPER_ADMIN') {
      return next();
    }

    const canScore = await checkUserCanScoreMatch({
      userId: req.user.id,
      userRole: req.user.role,
      matchPublicOrInternalId: matchId
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
