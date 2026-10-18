const auctionService = require('../services/auctionService');

// 1. Get tournament auction status / configuration
const getTournamentAuction = async (req, res, next) => {
  try {
    const tournamentId = req.params.tournamentId || req.params.id;
    const result = await auctionService.getTournamentAuction(tournamentId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// 2. Configure or enable auction for a tournament
const configureAuction = async (req, res, next) => {
  try {
    const tournamentId = req.params.tournamentId || req.params.id;
    const result = await auctionService.configureAuction({
      tournamentIdOrUuid: tournamentId,
      config: req.body,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 3. Get full auction console dashboard
const getAuctionDashboard = async (req, res, next) => {
  try {
    const result = await auctionService.getTournamentAuction(req.params.auctionId);
    res.json({ success: true, data: result.auction || result });
  } catch (err) {
    next(err);
  }
};

// 4. Register teams into auction
const registerTeams = async (req, res, next) => {
  try {
    const teamsData = Array.isArray(req.body.teams) ? req.body.teams : [req.body];
    const result = await auctionService.registerTeamsForAuction({
      auctionIdOrUuid: req.params.auctionId,
      teamsData,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 5. Register players into auction pool
const registerPlayers = async (req, res, next) => {
  try {
    const playersData = Array.isArray(req.body.players) ? req.body.players : [req.body];
    const result = await auctionService.registerPlayersForAuction({
      auctionIdOrUuid: req.params.auctionId,
      playersData,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 6. Update player details / category / base price
const updatePlayer = async (req, res, next) => {
  try {
    const result = await auctionService.updateAuctionPlayer({
      auctionIdOrUuid: req.params.auctionId,
      playerId: req.params.playerId,
      playerData: req.body,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 7. Start auction
const startAuction = async (req, res, next) => {
  try {
    const result = await auctionService.startAuction({
      auctionIdOrUuid: req.params.auctionId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 8. Set status (PAUSED / LIVE)
const setAuctionStatus = async (req, res, next) => {
  try {
    const result = await auctionService.setAuctionStatus({
      auctionIdOrUuid: req.params.auctionId,
      status: req.body.status,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 9. Bring player onto the auction block
const selectPlayerForBidding = async (req, res, next) => {
  try {
    const result = await auctionService.selectPlayerForBidding({
      auctionIdOrUuid: req.params.auctionId,
      playerId: req.body.playerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 10. Place bid (atomic with reserve budget protection)
const placeBid = async (req, res, next) => {
  try {
    const { auctionTeamId, bidAmount, customIncrement } = req.body;
    const result = await auctionService.placeBid({
      auctionIdOrUuid: req.params.auctionId,
      auctionTeamId,
      bidAmount,
      customIncrement,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 11. Finalize player sale (SOLD)
const markPlayerSold = async (req, res, next) => {
  try {
    const result = await auctionService.markPlayerSold({
      auctionIdOrUuid: req.params.auctionId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 12. Finalize player unsold (UNSOLD)
const markPlayerUnsold = async (req, res, next) => {
  try {
    const result = await auctionService.markPlayerUnsold({
      auctionIdOrUuid: req.params.auctionId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 13. Re-auction unsold player
const reauctionPlayer = async (req, res, next) => {
  try {
    const result = await auctionService.reauctionPlayer({
      auctionIdOrUuid: req.params.auctionId,
      playerId: req.body.playerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 14. Complete auction
const completeAuction = async (req, res, next) => {
  try {
    const { force, exceptionReason } = req.body;
    const result = await auctionService.completeAuction({
      auctionIdOrUuid: req.params.auctionId,
      force: Boolean(force),
      exceptionReason,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 15. Post-auction reports
const getAuctionReports = async (req, res, next) => {
  try {
    const result = await auctionService.getAuctionReports(req.params.auctionId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// 16. Audit logs
const getAuctionAuditLogs = async (req, res, next) => {
  try {
    const result = await auctionService.getAuctionAuditLogs(req.params.auctionId);
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
};

// 17. Get auction players
const getAuctionPlayers = async (req, res, next) => {
  try {
    const { status, categoryId } = req.query;
    const result = await auctionService.getAuctionPlayers({
      auctionIdOrUuid: req.params.auctionId,
      status,
      categoryId
    });
    res.json({ success: true, data: { items: result } });
  } catch (err) {
    next(err);
  }
};

// 18. Delete auction player
const deleteAuctionPlayer = async (req, res, next) => {
  try {
    const result = await auctionService.deleteAuctionPlayer({
      auctionIdOrUuid: req.params.auctionId,
      playerId: req.params.playerId,
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 19. Pause auction
const pauseAuction = async (req, res, next) => {
  try {
    const result = await auctionService.setAuctionStatus({
      auctionIdOrUuid: req.params.auctionId,
      status: 'PAUSED',
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// 20. Resume auction
const resumeAuction = async (req, res, next) => {
  try {
    const result = await auctionService.setAuctionStatus({
      auctionIdOrUuid: req.params.auctionId,
      status: 'LIVE',
      userId: req.user.id,
      userRole: req.user.role
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getTournamentAuction,
  configureAuction,
  getAuctionDashboard,
  registerTeams,
  registerPlayers,
  updatePlayer,
  startAuction,
  setAuctionStatus,
  selectPlayerForBidding,
  placeBid,
  markPlayerSold,
  markPlayerUnsold,
  reauctionPlayer,
  completeAuction,
  getAuctionReports,
  getAuctionAuditLogs,
  getAuctionPlayers,
  deleteAuctionPlayer,
  pauseAuction,
  resumeAuction
};
