const express = require('express');
const router = express.Router();
const teamController = require('../controllers/teamController');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const upload = require('../middleware/multerMiddleware');

// 1. GET /api/teams/my-teams - Authenticated Owner's Isolated Teams
router.get('/my-teams', authenticateUser, teamController.getMyTeams);

// 2. GET /api/teams - Public Discovery Feed for Players / Tournaments
router.get('/', optionalAuthenticateUser, teamController.discoverTeams);

// 3. GET /api/teams/:id - Single Team Details & Roster (Accessible publicly with manage capabilities for organizers)
router.get('/:id', optionalAuthenticateUser, teamController.getTeamById);

// 4. POST /api/teams - Create Team
router.post('/', authenticateUser, teamController.createTeam);

// 5. PUT /api/teams/:id - Update Team
router.put('/:id', authenticateUser, teamController.updateTeam);

// 6. DELETE /api/teams/:id - Delete Team
router.delete('/:id', authenticateUser, teamController.deleteTeam);

// 7. POST /api/teams/:id/players - Add Player to Team Roster (with optional photo upload)
router.post('/:id/players', authenticateUser, upload.single('photo'), teamController.addPlayerToTeam);


// 8. PUT /api/teams/:id/players/:memberId - Update Player on Roster
router.put('/:id/players/:memberId', authenticateUser, teamController.updateTeamPlayer);

// 9. DELETE /api/teams/:id/players/:memberId - Remove Player from Roster
router.delete('/:id/players/:memberId', authenticateUser, teamController.removePlayerFromTeam);

// 10. POST /api/teams/:id/players/bulk - Bulk Import Players to Roster
router.post('/:id/players/bulk', authenticateUser, teamController.bulkAddPlayers);

module.exports = router;
