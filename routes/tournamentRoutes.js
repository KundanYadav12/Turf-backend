const express = require('express');
const router = express.Router();
const tournamentService = require('../services/tournamentService');
const scorerAccessService = require('../services/scorerAccessService');
const streamPermissionService = require('../services/streamPermissionService');
const fixtureService = require('../services/fixtureService');
const matchService = require('../services/matchService');
const auctionController = require('../controllers/auctionController');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');
const upload = require('../middleware/multerMiddleware');
const tournamentAnalyticsController = require('../controllers/tournamentAnalyticsController');

// 0. Tournament View Tracking & Public Summary (Deduped, non-blocking)
router.post('/:id/view', optionalAuthenticateUser, tournamentAnalyticsController.recordTournamentView);
router.get('/:id/analytics/summary', tournamentAnalyticsController.getPublicTournamentAnalyticsSummary);

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

// MODULE I: Search users for scorer assignment
router.get('/scorers/search', authenticateUser, async (req, res, next) => {
  try {
    const { q } = req.query;
    const users = await scorerAccessService.searchUsers(q);
    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
});

// MODULE I: Shortcut to fetch matches assigned to current user for scoring
router.get('/scorers/my-matches', authenticateUser, async (req, res, next) => {
  try {
    const matches = await scorerAccessService.getUserScoringMatches(req.user.id);
    res.json({ success: true, data: matches });
  } catch (error) {
    next(error);
  }
});

// 1b. GET /api/tournaments/live & /live-all - Active Tournaments with Live Matches
const getLiveTournamentsHandler = async (req, res, next) => {
  try {
    const liveMatches = await matchService.getAllLiveMatches(req.query);
    const tournamentMap = new Map();
    for (const m of liveMatches) {
      const tId = m.tournamentId || (m.tournament && m.tournament.id);
      if (!tId) continue;
      if (!tournamentMap.has(tId)) {
        tournamentMap.set(tId, {
          tournament: m.tournament,
          sport: m.sport,
          liveMatches: []
        });
      }
      tournamentMap.get(tId).liveMatches.push(m);
    }
    const liveTournaments = Array.from(tournamentMap.values());
    res.json({
      success: true,
      data: {
        tournaments: liveTournaments,
        totalLiveTournaments: liveTournaments.length,
        totalLiveMatches: liveMatches.length,
        matches: liveMatches
      }
    });
  } catch (error) {
    next(error);
  }
};
router.get('/live', getLiveTournamentsHandler);
router.get('/live-all', getLiveTournamentsHandler);

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

// 2a. GET /api/tournaments/:id/delete-impact - Check impact before tournament deletion
router.get('/:id/delete-impact', authenticateUser, async (req, res, next) => {
  try {
    const result = await tournamentService.getTournamentDeleteImpact(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 2b. DELETE /api/tournaments/:id - Delete Tournament (Superadmin or Organizer creator only)
router.delete('/:id', authenticateUser, async (req, res, next) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const result = await tournamentService.deleteTournament({
      tournamentId: req.params.id,
      user: req.user,
      force
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 2b. GET /api/tournaments/live & /api/tournaments/live-all - Active Live matches across all tournaments
router.get(['/live', '/live-all'], async (req, res, next) => {
  try {
    const matchService = require('../services/matchService');
    const matches = await matchService.getAllLiveMatches(req.query);
    res.json({ success: true, data: { items: matches, count: matches.length } });
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

// 4-live. GET /api/tournaments/:id/live & /:id/live-matches - All current LIVE matches in this tournament
const getTournamentLiveMatchesHandler = async (req, res, next) => {
  try {
    const matches = await matchService.getAllLiveMatches({
      tournamentId: req.params.id,
      sport: req.query.sport,
      limit: req.query.limit
    });
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
};
router.get('/:id/live', getTournamentLiveMatchesHandler);
router.get('/:id/live-matches', getTournamentLiveMatchesHandler);

// 4a. PUT /api/tournaments/:id/matches/display-bulk - Bulk Match Display Selection (Protected)
router.put('/:id/matches/display-bulk', authenticateUser, async (req, res, next) => {
  try {
    const result = await tournamentService.bulkUpdateTournamentMatchesDisplay(
      req.params.id,
      req.body,
      req.user
    );
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// 4b. PUT /api/tournaments/:id/matches/:matchId/display - Toggle Single Match Display (Protected)
router.put('/:id/matches/:matchId/display', authenticateUser, async (req, res, next) => {
  try {
    const { showOnDisplay } = req.body;
    const result = await tournamentService.updateTournamentMatchDisplay(
      req.params.id,
      req.params.matchId,
      showOnDisplay,
      req.user
    );
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// 4c. PUT /api/tournaments/:id/court-color - Set Court Color (Protected)
router.put('/:id/court-color', authenticateUser, async (req, res, next) => {
  try {
    const { courtColor } = req.body;
    const result = await tournamentService.updateTournamentCourtColor(
      req.params.id,
      courtColor,
      req.user
    );
    res.json({ success: true, ...result });
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

// 5c. PUT /api/tournaments/:id/teams/:teamId/players/:playerId - Edit Player in Team Squad
router.put('/:id/teams/:teamId/players/:playerId', authenticateUser, async (req, res, next) => {
  try {
    const data = await tournamentService.updatePlayerInTournamentTeamRoster(
      req.params.id,
      req.params.teamId,
      req.params.playerId,
      req.body,
      req.user
    );
    res.json({ success: true, message: 'Squad player details updated successfully!', data });
  } catch (error) {
    next(error);
  }
});

// 5d. DELETE /api/tournaments/:id/teams/:teamId/players/:playerId - Remove Player from Team Squad
router.delete('/:id/teams/:teamId/players/:playerId', authenticateUser, async (req, res, next) => {
  try {
    const result = await tournamentService.removePlayerFromTournamentTeamRoster(
      req.params.id,
      req.params.teamId,
      req.params.playerId,
      req.user
    );
    res.json({ success: true, ...result });
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

// 11a. GET /api/tournaments/:id/teams/:teamId/impact - Impact analysis before removing team
router.get('/:id/teams/:teamId/impact', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const impact = await tournamentService.getTeamRemovalImpact(req.params.id, req.params.teamId);
    res.json({ success: true, data: impact });
  } catch (error) {
    next(error);
  }
});

// 11b. DELETE /api/tournaments/:id/teams/:teamId - Remove team from tournament
router.delete('/:id/teams/:teamId', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const { mode, confirmWord } = req.body || {};
    const result = await tournamentService.removeTeamFromTournament(
      req.params.id,
      req.params.teamId,
      { mode, confirmWord },
      req.user
    );
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 11c. POST /api/tournaments/:id/teams/bulk - Bulk add teams to tournament
router.post('/:id/teams/bulk', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const { teamIds, groupName } = req.body || {};
    const result = await tournamentService.bulkAddTeamsToTournament(
      req.params.id,
      { teamIds, groupName },
      req.user
    );
    res.status(201).json(result);
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

// 13a. POST /api/tournaments/:id/standings/freeze - Freeze or Unfreeze tournament standings
router.post('/:id/standings/freeze', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const db = require('../config/database');
    const { getIO } = require('../services/socketService');
    const tournament = await tournamentService.getTournamentByPublicId(req.params.id);
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found' });

    // Determine target freeze state (toggle if unspecified)
    const currentFrozen = Boolean(tournament.is_standings_frozen);
    const targetFrozen = req.body?.freeze !== undefined ? Boolean(req.body.freeze) : !currentFrozen;

    // Update tournaments and points_table
    await db.query('UPDATE tournaments SET is_standings_frozen = ? WHERE id = ?', [targetFrozen ? 1 : 0, tournament.id]);
    await db.query('UPDATE points_table SET is_frozen = ? WHERE tournament_id = ?', [targetFrozen ? 1 : 0, tournament.id]);

    // If unfreezing and forceRecalc requested, recalculate
    if (!targetFrozen && req.body?.recalculate) {
      await tournamentEngineService.recalculateStandings(tournament.id, { force: true });
    }

    const updatedData = await tournamentEngineService.getTournamentStandings(tournament.id);

    const io = getIO();
    if (io) {
      io.to(`tournament:${tournament.uuid}`).emit('tournament:standingsUpdated', {
        tournamentId: tournament.uuid,
        isFrozen: targetFrozen,
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: targetFrozen 
        ? 'Tournament points table has been successfully FROZEN. Official final standings are permanently locked.' 
        : 'Tournament points table unfrozen. Standings will dynamically update with matches.',
      isFrozen: targetFrozen,
      data: updatedData
    });
  } catch (error) {
    next(error);
  }
});

// 13b. POST /api/tournaments/:id/standings/recalculate - Force recalculate tournament standings
router.post('/:id/standings/recalculate', authenticateUser, authorizeTournamentOrganizer, async (req, res, next) => {
  try {
    const tournament = await tournamentService.getTournamentByPublicId(req.params.id);
    if (!tournament) return res.status(404).json({ success: false, message: 'Tournament not found' });

    await tournamentEngineService.recalculateStandings(tournament.id, { force: true });
    const data = await tournamentEngineService.getTournamentStandings(tournament.id);

    res.json({
      success: true,
      message: 'Points table standings successfully recalculated.',
      data
    });
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

// =====================================================
// MODULE B: PLAYER REGISTRATION ENDPOINTS
// =====================================================
const playerRegistrationService = require('../services/playerRegistrationService');

// B1 & B2: Get registration config (public, used by registration form & organizer view)
router.get('/:id/registration-config', async (req, res, next) => {
  try {
    const config = await playerRegistrationService.getRegistrationConfig(req.params.id);
    res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
});

// B1 & B2: Update registration config (Organizer & Super Admin)
router.put('/:id/registration-config', authenticateUser, async (req, res, next) => {
  try {
    const updated = await playerRegistrationService.updateRegistrationConfig(req.params.id, req.user, req.body);
    res.json({ success: true, message: 'Registration configuration updated.', data: updated });
  } catch (error) {
    next(error);
  }
});

// B2 & B3: Submit player registration request
router.post(
  '/:id/player-registrations',
  authenticateUser,
  (req, res, next) => {
    // Optional photo upload support
    upload.single('photo')(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      next();
    });
  },
  async (req, res, next) => {
    try {
      const data = { ...req.body };
      if (req.file) {
        data.photoUrl = `/uploads/${req.file.filename}`;
      }
      // If customFieldsData was sent as JSON string in multipart form, parse it
      if (typeof data.customFieldsData === 'string') {
        try {
          data.customFieldsData = JSON.parse(data.customFieldsData);
        } catch (e) {
          data.customFieldsData = {};
        }
      }
      const result = await playerRegistrationService.submitPlayerRegistration(req.params.id, req.user, data);
      res.status(201).json({
        success: true,
        message: result.message,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

// B3: Get player registrations list (full for organizer, sanitized for public visitors)
router.get('/:id/player-registrations', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const registrations = await playerRegistrationService.getTournamentPlayerRegistrations(
      req.params.id,
      req.user,
      req.query
    );
    res.json({ success: true, data: registrations });
  } catch (error) {
    next(error);
  }
});

// B3: Get current user's registration status in this tournament
router.get('/:id/my-registration', authenticateUser, async (req, res, next) => {
  try {
    const registration = await playerRegistrationService.getMyTournamentRegistration(req.params.id, req.user);
    res.json({ success: true, data: registration });
  } catch (error) {
    next(error);
  }
});

// B3: Withdraw current user's pending registration
router.delete('/:id/my-registration', authenticateUser, async (req, res, next) => {
  try {
    const result = await playerRegistrationService.withdrawMyRegistration(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// B3: Update registration status (Approve, Deny, Waitlist, Confirm)
router.put('/:id/player-registrations/:regId/status', authenticateUser, async (req, res, next) => {
  try {
    const result = await playerRegistrationService.updateRegistrationStatus(
      req.params.id,
      req.params.regId,
      req.user,
      req.body
    );
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// B3: Bulk update registration statuses
router.post('/:id/player-registrations/bulk-status', authenticateUser, async (req, res, next) => {
  try {
    const result = await playerRegistrationService.bulkUpdateRegistrationStatus(
      req.params.id,
      req.user,
      req.body
    );
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// B2: Reveal sensitive data (Aadhaar, unmasked address) with access logging
router.post('/:id/player-registrations/:regId/reveal-sensitive', authenticateUser, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const sensitiveData = await playerRegistrationService.revealSensitiveData(
      req.params.id,
      req.params.regId,
      req.user,
      reason
    );
    res.json({ success: true, data: sensitiveData });
  } catch (error) {
    next(error);
  }
});

// MODULE I: List assigned scorers for tournament
router.get('/:id/scorers', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const scorers = await scorerAccessService.getTournamentScorers(req.params.id, req.user);
    res.json({ success: true, data: scorers });
  } catch (error) {
    next(error);
  }
});

// MODULE I: Assign user as scorer
router.post('/:id/scorers', authenticateUser, async (req, res, next) => {
  try {
    const { userId, matchId } = req.body;
    const result = await scorerAccessService.assignScorer({
      tournamentId: req.params.id,
      userId,
      matchId: matchId || null,
      assignedBy: req.user.id,
      assignedByRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// MODULE I: Remove scorer assignment
router.delete('/:id/scorers/:assignmentId', authenticateUser, async (req, res, next) => {
  try {
    const result = await scorerAccessService.removeScorer({
      tournamentId: req.params.id,
      assignmentId: req.params.assignmentId,
      removedBy: req.user.id,
      removedByRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// =====================================================
// LIVE STREAMING PERMISSIONS & DELEGATED ACCESS
// =====================================================

// Search users for streaming permission delegation
router.get('/streaming/search-users', authenticateUser, async (req, res, next) => {
  try {
    const { q } = req.query;
    const users = await streamPermissionService.searchUsers(q);
    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
});

// Shortcut for user's own streaming assignments across tournaments
router.get('/streaming/my-assignments', authenticateUser, async (req, res, next) => {
  try {
    const data = await streamPermissionService.getUserStreamingAssignments(req.user.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// List streaming permissions for tournament (Creator/Admin sees all; User sees own)
router.get('/:id/streaming-permissions', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const permissions = await streamPermissionService.getTournamentStreamPermissions(req.params.id, req.user);
    res.json({ success: true, data: permissions });
  } catch (error) {
    next(error);
  }
});

// Check current user's specific streaming permission for this tournament
router.get('/:id/streaming-permissions/me', authenticateUser, async (req, res, next) => {
  try {
    const matchId = req.query.matchId || null;
    const permission = await streamPermissionService.checkUserStreamPermission(req.user.id, req.params.id, matchId);
    res.json({ success: true, data: permission });
  } catch (error) {
    next(error);
  }
});

// Grant live streaming permission to another user
router.post('/:id/streaming-permissions', authenticateUser, async (req, res, next) => {
  try {
    const { userId, matchId, scope, expiresAt, notes } = req.body;
    const result = await streamPermissionService.grantStreamPermission({
      tournamentId: req.params.id,
      userId,
      matchId: matchId || null,
      scope: scope || 'TOURNAMENT',
      expiresAt: expiresAt || null,
      notes: notes || null,
      grantedBy: req.user.id,
      grantedByRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Revoke live streaming permission
router.delete('/:id/streaming-permissions/:permId', authenticateUser, async (req, res, next) => {
  try {
    const result = await streamPermissionService.revokeStreamPermission({
      tournamentId: req.params.id,
      permissionIdOrUuid: req.params.permId,
      revokedBy: req.user.id,
      revokedByRole: req.user.role
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Tournament Streaming Overview (all matches, live stream status, viewer count, and canManageStream for viewer)
router.get('/:id/streaming-overview', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const data = await streamPermissionService.getTournamentStreamingOverview(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// =====================================================
// MODULE J: FIXTURE MANAGEMENT, CATEGORIES, BRACKET & CONFLICTS
// =====================================================

// J1. GET /api/tournaments/:id/fixtures/bracket - Get structured knockout bracket tree
router.get('/:id/fixtures/bracket', async (req, res, next) => {
  try {
    const bracket = await fixtureService.getBracketTree(req.params.id);
    res.json({ success: true, data: bracket });
  } catch (error) {
    next(error);
  }
});

// J2. POST /api/tournaments/:id/fixtures/check-conflicts - Pre-flight conflict check
router.post('/:id/fixtures/check-conflicts', authenticateUser, async (req, res, next) => {
  try {
    const { matchId, matchDate, startTime, endTime, courtId, venueId, teamAId, teamBId } = req.body;
    const result = await fixtureService.checkSchedulingConflicts({
      tournamentId: req.params.id,
      matchId,
      matchDate,
      startTime,
      endTime,
      courtId,
      venueId,
      teamAId,
      teamBId
    });
    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// J3. POST /api/tournaments/:id/fixtures - Create Fixture
router.post('/:id/fixtures', authenticateUser, async (req, res, next) => {
  try {
    const result = await fixtureService.createFixture({
      tournamentId: req.params.id,
      user: req.user,
      fixtureData: req.body
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// J4. PUT /api/tournaments/:id/fixtures/:matchId - Update / Reschedule Fixture
router.put('/:id/fixtures/:matchId', authenticateUser, async (req, res, next) => {
  try {
    const result = await fixtureService.updateFixture({
      tournamentId: req.params.id,
      matchId: req.params.matchId,
      user: req.user,
      updates: req.body
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// J4a. PUT /api/tournaments/:id/fixtures/:matchId/status - Quick Toggle Match Status (SCHEDULED / LIVE / COMPLETED)
router.put('/:id/fixtures/:matchId/status', authenticateUser, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'PAUSED'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status. Must be SCHEDULED, LIVE, or COMPLETED.' });
    }
    const result = await fixtureService.updateFixture({
      tournamentId: req.params.id,
      matchId: req.params.matchId,
      user: req.user,
      updates: { status, allowConflictOverride: true }
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// J5. DELETE /api/tournaments/:id/fixtures/:matchId - Delete Fixture
router.delete('/:id/fixtures/:matchId', authenticateUser, async (req, res, next) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    const result = await fixtureService.deleteFixture({
      tournamentId: req.params.id,
      matchId: req.params.matchId,
      user: req.user,
      force
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// J6. POST /api/tournaments/:id/fixtures/auto-league - Auto-generate League fixtures
router.post('/:id/fixtures/auto-league', authenticateUser, async (req, res, next) => {
  try {
    const result = await fixtureService.autoGenerateLeague({
      tournamentId: req.params.id,
      user: req.user,
      options: req.body || {}
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// J7. POST /api/tournaments/:id/fixtures/auto-knockout - Generate Knockout bracket
router.post('/:id/fixtures/auto-knockout', authenticateUser, async (req, res, next) => {
  try {
    const result = await fixtureService.generateKnockoutBracket({
      tournamentId: req.params.id,
      user: req.user,
      options: req.body || {}
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;


