const tournamentAnalyticsService = require('../services/tournamentAnalyticsService');

/**
 * Public Endpoint: Track Tournament View
 * POST /api/tournaments/:id/view
 */
const recordTournamentView = async (req, res) => {
  try {
    const tournamentIdentifier = req.params.id;
    const { viewerId, platform } = req.body || {};

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                     req.socket?.remoteAddress || 
                     req.ip;
    const userAgent = req.headers['user-agent'] || null;

    const result = await tournamentAnalyticsService.recordTournamentView({
      tournamentIdentifier,
      user: req.user || null,
      viewerId: viewerId || null,
      platform: platform || 'WEB',
      ip: clientIp,
      userAgent
    });

    return res.status(200).json({
      success: true,
      message: result.deduplicated ? 'View verified (cooldown active)' : 'Tournament view recorded',
      data: result
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    console.error('Error tracking tournament view:', err);
    // Non-blocking response so client never breaks
    return res.status(500).json({
      success: false,
      message: 'Failed to record tournament view'
    });
  }
};

/**
 * Public Endpoint: Get Aggregate View Summary for Single Tournament
 * GET /api/tournaments/:id/analytics/summary
 */
const getPublicTournamentAnalyticsSummary = async (req, res) => {
  try {
    const tournamentIdentifier = req.params.id;
    const summary = await tournamentAnalyticsService.getTournamentPublicSummary(tournamentIdentifier);

    return res.status(200).json({
      success: true,
      data: summary
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    console.error('Error fetching tournament public summary:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament analytics summary'
    });
  }
};

/**
 * Superadmin Endpoint: Platform Tournament View Analytics Overview & Rankings
 * GET /api/admin/tournament-analytics
 */
const getSuperadminOverview = async (req, res) => {
  try {
    const overview = await tournamentAnalyticsService.getSuperadminAnalyticsOverview(req.query || {});
    return res.status(200).json({
      success: true,
      data: overview
    });
  } catch (err) {
    console.error('Error fetching superadmin tournament analytics overview:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to load tournament analytics overview'
    });
  }
};

/**
 * Superadmin Endpoint: Single Tournament In-Depth Analytics Drilldown
 * GET /api/admin/tournament-analytics/:id
 */
const getSuperadminTournamentDetail = async (req, res) => {
  try {
    const tournamentIdentifier = req.params.id;
    const periodDays = req.query.periodDays || 30;

    const detail = await tournamentAnalyticsService.getSuperadminTournamentDetail(
      tournamentIdentifier,
      { periodDays }
    );

    return res.status(200).json({
      success: true,
      data: detail
    });
  } catch (err) {
    if (err.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }
    console.error('Error fetching superadmin tournament analytics detail:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to load tournament analytics detail'
    });
  }
};

module.exports = {
  recordTournamentView,
  getPublicTournamentAnalyticsSummary,
  getSuperadminOverview,
  getSuperadminTournamentDetail
};
