const express = require('express');
const router = express.Router();
const statisticsAwardsService = require('../services/statisticsAwardsService');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');

// 1. GET /api/players/search - Search Players by name, sport, city, or role
router.get('/search', async (req, res, next) => {
  try {
    const players = await statisticsAwardsService.searchPlayers(req.query);
    res.json({ success: true, data: players });
  } catch (error) {
    next(error);
  }
});

// 2. GET /api/players - List players with active sports profiles for directory/sitemap
router.get('/', async (req, res, next) => {
  try {
    const db = require('../config/database');
    const players = await db.query(
      `SELECT DISTINCT u.id, u.full_name, u.profile_photo, u.city, u.primary_sport_slug, u.updated_at 
       FROM users u 
       WHERE u.status = 'ACTIVE'
       ORDER BY u.id DESC LIMIT 100`
    );
    res.json({ success: true, data: players });
  } catch (error) {
    next(error);
  }
});

// 3. GET /api/players/:id/history - Chronological Match-by-Match Performance History
router.get('/:id/history', async (req, res, next) => {
  try {
    const history = await statisticsAwardsService.getPlayerMatchHistory(req.params.id, req.query.sport);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

// 4. GET /api/players/:id - Detailed Player Career Profile with Actual Stats & Privacy Masking
router.get('/:id', optionalAuthenticateUser, async (req, res, next) => {
  try {
    const profile = await statisticsAwardsService.getPlayerProfile(req.params.id, req.user);
    res.json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
});

// 5. PUT /api/players/:id - Update Player Profile Details (Self or Admin)
router.put('/:id', authenticateUser, async (req, res, next) => {
  try {
    const updated = await statisticsAwardsService.updatePlayerProfile(req.params.id, req.body, req.user);
    res.json({ success: true, message: 'Profile updated successfully!', data: updated });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
