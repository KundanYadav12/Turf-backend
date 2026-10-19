const express = require('express');
const router = express.Router();
const tournamentService = require('../services/tournamentService');
const auctionController = require('../controllers/auctionController');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');
const upload = require('../middleware/multerMiddleware');

// 1. GET /api/tournaments - Discovery listing (cursor-based pagination, minimal summary)
router.get('/', async (req, res, next) => {
  try {
    const { city, sportSlug, status, search, cursor, limit } = req.query;
    const result = await tournamentService.getTournamentsPaginated({
      city,
      sportSlug,
      status,
      search,
      cursor,
      limit
    });
    res.json({ success: true, data: result.items, pagination: result.pagination });
  } catch (error) {
    next(error);
  }
});

// 2. GET /api/tournaments/:id - Overview details
router.get('/:id', async (req, res, next) => {
  try {
    const tournament = await tournamentService.getTournamentByPublicId(req.params.id);
    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found.' });
    }
    res.json({ success: true, data: tournament });
  } catch (error) {
    next(error);
  }
});

// 3. GET /api/tournaments/:id/live - Active Live match summaries
router.get('/:id/live', async (req, res, next) => {
  try {
    const matches = await tournamentService.getTournamentLiveMatches(req.params.id);
    res.json({ success: true, data: { items: matches } });
  } catch (error) {
    next(error);
  }
});

// 4. GET /api/tournaments/:id/matches - Fixtures and Schedule
router.get('/:id/matches', async (req, res, next) => {
  try {
    const matches = await tournamentService.getTournamentFixtures(req.params.id);
    res.json({ success: true, data: { items: matches } });
  } catch (error) {
    next(error);
  }
});

// 5. GET /api/tournaments/:id/teams - Registered Teams
router.get('/:id/teams', async (req, res, next) => {
  try {
    const teams = await tournamentService.getTournamentTeams(req.params.id);
    res.json({ success: true, data: { items: teams } });
  } catch (error) {
    next(error);
  }
});

// 5a. GET /api/tournaments/:id/teams/:teamId/players - Team Squad Roster
router.get('/:id/teams/:teamId/players', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const data = await tournamentService.getTournamentTeamRoster(req.params.id, req.params.teamId, req.user);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 5b. POST /api/tournaments/:id/teams/:teamId/players - Add Player to Team Squad
router.post('/:id/teams/:teamId/players', authenticateUser, async (req, res, next) => {
  try {
    const data = await tournamentService.addPlayerToTournamentTeamRoster(req.params.id, req.params.teamId, req.body, req.user);
    res.status(201).json({ success: true, message: 'Player added to squad successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 6. POST /api/tournaments - Create tournament (Protected: ADMIN, VENUE_OWNER)
router.post(
  '/',
  authenticateUser,
  authorizeRoles('ADMIN', 'VENUE_OWNER'),
  (req, res, next) => {
    upload.single('banner')(req, res, (err) => {
      if (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      const bannerUrl = req.file ? `/uploads/${req.file.filename}` : req.body.bannerUrl;
      const tournament = await tournamentService.createTournament({
        ...req.body,
        bannerUrl,
        user: req.user
      });
      res.status(201).json({
        success: true,
        message: 'Tournament created successfully!',
        data: tournament
      });
    } catch (error) {
      next(error);
    }
  }
);

// 7. GET /api/tournaments/:id/auction - Tournament Auction Details
router.get('/:id/auction', auctionController.getTournamentAuction);

// 8. POST /api/tournaments/:id/auction - Configure / Enable Tournament Auction (Protected)
router.post('/:id/auction', authenticateUser, auctionController.configureAuction);

// === PICKLEBALL TOURNAMENT MODULE ROUTES ===
const pickleballService = require('../services/pickleballService');

// 9. GET /api/tournaments/:id/groups - Get tournament groups & assigned teams
router.get('/:id/groups', async (req, res, next) => {
  try {
    const data = await pickleballService.getTournamentGroups(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// Helper middleware: Authorize tournament organizer, venue owner, or admin
const authorizeTournamentOrganizer = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });
    }

    if (req.user.role === 'ADMIN' || req.user.role === 'VENUE_OWNER' || req.user.role === 'VENUE_STAFF') {
      return next();
    }

    const db = require('../config/database');
    const tournamentId = req.params.id;
    const isNum = /^\d+$/.test(String(tournamentId).trim());

    const rows = await db.query(
      `SELECT t.id, t.created_by, v.owner_id as venue_owner_id
       FROM tournaments t
       LEFT JOIN venues v ON t.venue_id = v.id
       WHERE t.uuid = ? OR t.id = ?`,
      [tournamentId, isNum ? parseInt(tournamentId, 10) : -1]
    );

    if (rows && rows.length > 0) {
      const tourn = rows[0];
      if (tourn.created_by === req.user.id || (tourn.venue_owner_id && tourn.venue_owner_id === req.user.id)) {
        return next();
      }
    }

    return res.status(403).json({
      success: false,
      message: 'Forbidden. Only the tournament organizer, venue owner, or platform admin can perform this action.'
    });
  } catch (err) {
    next(err);
  }
};

// 10. PUT /api/tournaments/:id/groups - Update groups (manual assignment or auto-distribute)
router.put('/:id/groups', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const data = await pickleballService.updateGroupAssignments(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Tournament groups updated successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 11. POST /api/tournaments/:id/teams - Register team to tournament with roster
router.post('/:id/teams', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const data = await pickleballService.addTeamToTournament(req.params.id, req.body, req.user);
    res.status(201).json({ success: true, message: 'Team added to tournament successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 12. POST /api/tournaments/:id/generate-fixtures - Multi-sport fixture generator (Round Robin, Knockout, Group Playoffs)
const tournamentEngineService = require('../services/tournamentEngineService');
const statisticsAwardsService = require('../services/statisticsAwardsService');

router.post('/:id/generate-fixtures', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const data = await tournamentEngineService.generateFixtures(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/fixtures/generate', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const data = await tournamentEngineService.generateFixtures(req.params.id, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 13. GET /api/tournaments/:id/standings - Multi-sport Standings & Rankings
router.get('/:id/standings', async (req, res, next) => {
  try {
    const data = await tournamentEngineService.getTournamentStandings(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 14. GET /api/tournaments/:id/awards - Tournament Awards & Leaderboards
router.get('/:id/awards', async (req, res, next) => {
  try {
    const data = await statisticsAwardsService.getTournamentAwards(req.params.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 15. POST /api/tournaments/:id/awards/calculate - Calculate & compute awards
router.post('/:id/awards/calculate', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const data = await statisticsAwardsService.computeTournamentAwards(req.params.id);
    res.json({ success: true, message: 'Tournament awards computed successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 16. PUT /api/tournaments/:id/awards/:awardId - Organizer award override with audit trail
router.put('/:id/awards/:awardId', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const data = await statisticsAwardsService.overrideAward(req.params.awardId, req.body, req.user);
    res.json(data);
  } catch (error) {
    next(error);
  }
});

// 17. POST /api/tournaments/:id/register - Public / Participant Tournament Registration Request
router.post('/:id/register', authenticateUser, async (req, res, next) => {
  try {
    const db = require('../config/database');
    const tournament = await tournamentEngineService.getTournamentEntity(req.params.id);
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found.' });

    const { teamId, teamName, registrationType = 'TEAM', playerNames = [], player1Id, player2Id } = req.body;
    let resolvedTeamId = teamId;

    if (!resolvedTeamId) {
      if (!teamName || teamName.trim().length < 2) {
        return res.status(400).json({ success: false, message: 'Team or entry name is required.' });
      }
      const crypto = require('crypto');
      const teamSlug = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now();
      const newTeam = await db.query(
        `INSERT INTO teams (uuid, sport_id, name, captain_id, owner_id, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
        [crypto.randomUUID(), tournament.sport_id, teamName.trim(), req.user.id, req.user.id]
      );
      resolvedTeamId = newTeam.insertId;

      if (Array.isArray(playerNames) && playerNames.length > 0) {
        for (const pName of playerNames) {
          if (pName && pName.trim()) {
            await db.query(
              `INSERT INTO team_members (team_id, player_name, role) VALUES (?, ?, 'PLAYER')`,
              [resolvedTeamId, pName.trim()]
            );
          }
        }
      }
    }

    // Check entry limits
    const currentCount = await db.query(
      `SELECT COUNT(*) as count FROM tournament_teams WHERE tournament_id = ? AND registration_status = 'APPROVED'`,
      [tournament.id]
    );
    if (currentCount[0].count >= (tournament.max_teams || 64)) {
      return res.status(400).json({ success: false, message: 'Tournament registration limit reached.' });
    }

    // Register team to tournament
    await db.query(
      `INSERT INTO tournament_teams (
        tournament_id, team_id, registration_status, payment_status,
        registration_type, player_1_id, player_2_id, group_name
      ) VALUES (?, ?, 'APPROVED', 'PAID', ?, ?, ?, 'Group 1')
      ON DUPLICATE KEY UPDATE registration_status = 'APPROVED'`,
      [tournament.id, resolvedTeamId, registrationType, player1Id || req.user.id, player2Id || null]
    );

    res.status(201).json({
      success: true,
      message: 'Registration submitted and approved successfully!',
      teamId: resolvedTeamId
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

