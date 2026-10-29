const express = require('express');
const router = express.Router();
const teamController = require('../controllers/teamController');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const upload = require('../middleware/multerMiddleware');

// 1. GET /api/teams/my-teams - Authenticated Owner's Isolated Teams
router.get('/my-teams', authenticateUser, teamController.getMyTeams);

// 2. GET /api/teams/invite/:code - Preview Team Information via Invite Code (Public / Optional Auth)
router.get('/invite/:code', optionalAuthenticateUser, teamController.getTeamInviteInfo);

// 3. POST /api/teams/join/:code - Join Team via Invite Code (Authenticated)
router.post('/join/:code', authenticateUser, teamController.joinTeamByInviteCode);

// 4. GET /api/teams - Public Discovery Feed for Players / Tournaments
router.get('/', optionalAuthenticateUser, teamController.discoverTeams);

// 5. GET /api/teams/:id - Single Team Details & Roster (Accessible publicly with manage capabilities for organizers)
router.get('/:id', optionalAuthenticateUser, teamController.getTeamById);

// 6. POST /api/teams - Create Team
router.post('/', authenticateUser, teamController.createTeam);

// 7. PUT /api/teams/:id - Update Team
router.put('/:id', authenticateUser, teamController.updateTeam);

// 8. DELETE /api/teams/:id - Delete Team
router.delete('/:id', authenticateUser, teamController.deleteTeam);

// 9. GET /api/teams/:id/invite-link - Get or Generate Team Invite Link
router.get('/:id/invite-link', authenticateUser, teamController.getInviteLink);

// 10. POST /api/teams/:id/regenerate-invite-link - Regenerate Invite Link (Owner/Admin)
router.post('/:id/regenerate-invite-link', authenticateUser, teamController.regenerateInviteLink);

// 11. POST /api/teams/:id/revoke-invite-link - Revoke Invite Link (Owner/Admin)
router.post('/:id/revoke-invite-link', authenticateUser, teamController.revokeInviteLink);

// 12. POST /api/teams/:id/leave - Ordinary Player Leaves Team
router.post('/:id/leave', authenticateUser, teamController.leaveTeam);

// 7. POST /api/teams/:id/players - Add Player to Team Roster (with optional photo upload)
router.post('/:id/players', authenticateUser, upload.single('photo'), teamController.addPlayerToTeam);


// 8. PUT /api/teams/:id/players/:memberId - Update Player on Roster
router.put('/:id/players/:memberId', authenticateUser, teamController.updateTeamPlayer);

// 9. DELETE /api/teams/:id/players/:memberId - Remove Player from Roster
router.delete('/:id/players/:memberId', authenticateUser, teamController.removePlayerFromTeam);

// 10. POST /api/teams/:id/players/bulk - Bulk Import Players to Roster
router.post('/:id/players/bulk', authenticateUser, teamController.bulkAddPlayers);

module.exports = router;
