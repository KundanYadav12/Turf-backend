const express = require('express');
const router = express.Router();
const advertisementService = require('../services/advertisementService');
const { authenticateUser } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/rbacMiddleware');
const upload = require('../middleware/multerMiddleware');

// 1. GET /api/advertisements/active - Public signage, TV & mobile active ads feed
router.get('/active', async (req, res, next) => {
  try {
    const data = await advertisementService.getActiveAds({
      tournamentId: req.query.tournamentId,
      venueId: req.query.venueId,
      device: req.query.device
    });
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// 1b. GET /api/advertisements/mobile - Dedicated public mobile ads endpoint
router.get('/mobile', async (req, res, next) => {
  try {
    const data = await advertisementService.getActiveAds({
      tournamentId: req.query.tournamentId,
      venueId: req.query.venueId,
      device: 'MOBILE'
    });
    res.json({
      success: true,
      data: {
        mobileTopAds: data.mobileTopAds || [],
        mobileBottomAds: data.mobileBottomAds || [],
        courtMiddleAds: data.courtMiddleAds || [],
        mobileZoneSettings: data.mobileZoneSettings || {},
        state: data.state || {}
      }
    });
  } catch (error) {
    next(error);
  }
});

// 2. GET /api/advertisements/state - Public signage ad playback state
router.get('/state', (req, res) => {
  res.json({
    success: true,
    data: advertisementService.getPlaybackState()
  });
});

// Protected routes below: require ADMIN role
// 3. GET /api/advertisements - List all ads for Super Admin
router.get('/', authenticateUser, authorizeRoles('ADMIN'), async (req, res, next) => {
  try {
    const ads = await advertisementService.getAllAds();
    res.json({ success: true, data: ads });
  } catch (error) {
    next(error);
  }
});

// 4. POST /api/advertisements - Create / Upload Ad
router.post(
  '/',
  authenticateUser,
  authorizeRoles('ADMIN'),
  upload.single('image'),
  async (req, res, next) => {
    try {
      let imageUrl = req.body.imageUrl;
      if (req.file) {
        imageUrl = `/uploads/${req.file.filename}`;
      }

      if (!imageUrl) {
        return res.status(400).json({
          success: false,
          message: 'An advertisement image file or imageUrl is required.'
        });
      }

      const newAd = await advertisementService.createAd(
        {
          ...req.body,
          imageUrl
        },
        req.user?.id
      );

      res.status(201).json({ success: true, data: newAd });
    } catch (error) {
      next(error);
    }
  }
);

// 5. PUT /api/advertisements/:id - Update Ad
router.put(
  '/:id',
  authenticateUser,
  authorizeRoles('ADMIN'),
  upload.single('image'),
  async (req, res, next) => {
    try {
      let imageUrl = req.body.imageUrl;
      if (req.file) {
        imageUrl = `/uploads/${req.file.filename}`;
      }

      const updated = await advertisementService.updateAd(req.params.id, {
        ...req.body,
        ...(imageUrl ? { imageUrl } : {})
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
);

// 6. DELETE /api/advertisements/:id - Delete Ad
router.delete('/:id', authenticateUser, authorizeRoles('ADMIN'), async (req, res, next) => {
  try {
    const result = await advertisementService.deleteAd(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// 7. POST /api/advertisements/control - Super Admin Real-Time Playback Control (HOLD, RESUME, STOP_ADS, START_ADS)
router.post('/control', authenticateUser, authorizeRoles('ADMIN'), async (req, res, next) => {
  try {
    const { action, payload } = req.body;
    if (!action) {
      return res.status(400).json({ success: false, message: 'Action is required' });
    }
    const state = advertisementService.controlPlayback(action, payload || {});
    res.json({ success: true, data: state });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
