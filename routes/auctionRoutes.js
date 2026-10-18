const express = require('express');
const router = express.Router();
const auctionController = require('../controllers/auctionController');
const { authenticateUser } = require('../middleware/authMiddleware');

// 1. Direct auction query routes
// GET /api/auctions/:auctionId (Public / Viewers)
router.get('/:auctionId', auctionController.getAuctionDashboard);

// GET /api/auctions/:auctionId/dashboard (Public / Viewers)
router.get('/:auctionId/dashboard', auctionController.getAuctionDashboard);

// GET /api/auctions/:auctionId/reports (Public / Viewers)
router.get('/:auctionId/reports', auctionController.getAuctionReports);

// GET /api/auctions/:auctionId/logs (Protected)
router.get('/:auctionId/logs', authenticateUser, auctionController.getAuctionAuditLogs);

// GET /api/auctions/:auctionId/players (Public / Viewers)
router.get('/:auctionId/players', auctionController.getAuctionPlayers);

// DELETE /api/auctions/:auctionId/players/:playerId (Protected: Owner/Admin)
router.delete('/:auctionId/players/:playerId', authenticateUser, auctionController.deleteAuctionPlayer);

// 2. Team & Player Registration
// POST /api/auctions/:auctionId/teams (Protected: Owner/Admin)
router.post('/:auctionId/teams', authenticateUser, auctionController.registerTeams);

// POST /api/auctions/:auctionId/players (Protected: Owner/Admin)
router.post('/:auctionId/players', authenticateUser, auctionController.registerPlayers);

// PUT /api/auctions/:auctionId/players/:playerId (Protected: Owner/Admin)
router.put('/:auctionId/players/:playerId', authenticateUser, auctionController.updatePlayer);

// 3. Auction Execution & Live Controls
// POST /api/auctions/:auctionId/start (Protected: Operator/Admin)
router.post('/:auctionId/start', authenticateUser, auctionController.startAuction);

// POST /api/auctions/:auctionId/pause (Protected: Operator/Admin)
router.post('/:auctionId/pause', authenticateUser, auctionController.pauseAuction);

// POST /api/auctions/:auctionId/resume (Protected: Operator/Admin)
router.post('/:auctionId/resume', authenticateUser, auctionController.resumeAuction);

// POST /api/auctions/:auctionId/status (Protected: Operator/Admin)
router.post('/:auctionId/status', authenticateUser, auctionController.setAuctionStatus);

// POST /api/auctions/:auctionId/select-player & /block (Protected: Operator/Admin)
router.post('/:auctionId/select-player', authenticateUser, auctionController.selectPlayerForBidding);
router.post('/:auctionId/block', authenticateUser, auctionController.selectPlayerForBidding);

// POST /api/auctions/:auctionId/bid & /bids (Protected: Operator / Team Rep)
router.post('/:auctionId/bid', authenticateUser, auctionController.placeBid);
router.post('/:auctionId/bids', authenticateUser, auctionController.placeBid);

// POST /api/auctions/:auctionId/sold (Protected: Operator/Admin)
router.post('/:auctionId/sold', authenticateUser, auctionController.markPlayerSold);

// POST /api/auctions/:auctionId/unsold (Protected: Operator/Admin)
router.post('/:auctionId/unsold', authenticateUser, auctionController.markPlayerUnsold);

// POST /api/auctions/:auctionId/reauction (Protected: Operator/Admin)
router.post('/:auctionId/reauction', authenticateUser, auctionController.reauctionPlayer);

// POST /api/auctions/:auctionId/complete (Protected: Operator/Admin)
router.post('/:auctionId/complete', authenticateUser, auctionController.completeAuction);

module.exports = router;
