const express = require('express');
const router = express.Router();
const sportsController = require('../controllers/sportsController');

router.get('/', sportsController.getAllSports);
router.get('/:slug', sportsController.getSportBySlug);

module.exports = router;
