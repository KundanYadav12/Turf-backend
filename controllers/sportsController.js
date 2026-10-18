const db = require('../config/database');
const { getSportConfig } = require('../services/sportsRegistry');

const getAllSports = async (req, res, next) => {
  try {
    const sports = await db.query(
      `SELECT * FROM sports ORDER BY sort_order ASC, name ASC`
    );
    res.json({
      success: true,
      data: sports.map(s => {
        const config = getSportConfig(s.slug);
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          icon: s.icon,
          isActive: Boolean(s.is_active),
          sortOrder: s.sort_order,
          category: config.category,
          scoringUnit: config.scoringUnit,
          standingsFormula: config.standingsFormula,
          awards: config.awards
        };
      })
    });
  } catch (error) {
    next(error);
  }
};

const getSportBySlug = async (req, res, next) => {
  try {
    const config = getSportConfig(req.params.slug);
    res.json({ success: true, data: config });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllSports,
  getSportBySlug
};
