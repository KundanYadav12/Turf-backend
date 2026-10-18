const db = require('../config/database');

const getAllVenues = async (req, res, next) => {
  try {
    const { city, sport, search, minPrice, maxPrice, status = 'APPROVED' } = req.query;

    let sql = `
      SELECT 
        v.*,
        COALESCE(AVG(r.rating), 4.8) as avg_rating,
        COUNT(r.id) as review_count,
        MIN(c.base_price_per_hour) as starting_price,
        (SELECT image_url FROM venue_images WHERE venue_id = v.id ORDER BY is_primary DESC, id ASC LIMIT 1) as primary_image
      FROM venues v
      LEFT JOIN courts c ON v.id = c.venue_id
      LEFT JOIN reviews r ON v.id = r.venue_id
      LEFT JOIN venue_sports vs ON v.id = vs.venue_id
      LEFT JOIN sports s ON vs.sport_id = s.id
      WHERE v.status = ?
    `;

    const params = [status];

    if (city) {
      sql += ` AND LOWER(v.city) LIKE ?`;
      params.push(`%${city.toLowerCase()}%`);
    }

    if (sport) {
      sql += ` AND (LOWER(s.slug) = ? OR LOWER(s.name) = ?)`;
      params.push(sport.toLowerCase(), sport.toLowerCase());
    }

    if (search) {
      sql += ` AND (LOWER(v.name) LIKE ? OR LOWER(v.address) LIKE ? OR LOWER(v.city) LIKE ?)`;
      const sTerm = `%${search.toLowerCase()}%`;
      params.push(sTerm, sTerm, sTerm);
    }

    sql += ` GROUP BY v.id`;

    if (minPrice || maxPrice) {
      sql += ` HAVING 1=1`;
      if (minPrice) {
        sql += ` AND starting_price >= ?`;
        params.push(parseFloat(minPrice));
      }
      if (maxPrice) {
        sql += ` AND starting_price <= ?`;
        params.push(parseFloat(maxPrice));
      }
    }

    sql += ` ORDER BY avg_rating DESC, v.id DESC`;

    const venues = await db.query(sql, params);

    // Attach sports and amenities list to each venue
    const formattedVenues = await Promise.all(venues.map(async (v) => {
      const sports = await db.query(
        `SELECT s.id, s.name, s.slug, s.icon FROM sports s JOIN venue_sports vs ON s.id = vs.sport_id WHERE vs.venue_id = ?`,
        [v.id]
      );

      const amenities = await db.query(
        `SELECT a.id, a.name, a.icon FROM amenities a JOIN venue_amenities va ON a.id = va.amenity_id WHERE va.venue_id = ?`,
        [v.id]
      );

      return {
        id: v.id,
        name: v.name,
        slug: v.slug,
        description: v.description,
        address: v.address,
        city: v.city,
        state: v.state,
        pincode: v.pincode,
        primaryImage: v.primary_image || 'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80',
        rating: parseFloat(v.avg_rating || 4.8).toFixed(1),
        reviewCount: v.review_count || 0,
        startingPrice: parseFloat(v.starting_price || 1000),
        sports: sports,
        amenities: amenities
      };
    }));

    res.json({
      success: true,
      data: formattedVenues
    });
  } catch (error) {
    next(error);
  }
};

const getVenueByIdOrSlug = async (req, res, next) => {
  try {
    const { idOrSlug } = req.params;
    const isNumeric = /^\d+$/.test(idOrSlug);

    const venues = await db.query(
      `SELECT v.*, u.full_name as owner_name, u.email as owner_email, u.phone as owner_phone
       FROM venues v
       JOIN users u ON v.owner_id = u.id
       WHERE ${isNumeric ? 'v.id = ?' : 'v.slug = ?'}`,
      [idOrSlug]
    );

    if (!venues || venues.length === 0) {
      return res.status(404).json({ success: false, message: 'Venue not found.' });
    }

    const v = venues[0];

    // Fetch images
    const images = await db.query(
      `SELECT id, image_url, is_primary FROM venue_images WHERE venue_id = ? ORDER BY is_primary DESC, sort_order ASC`,
      [v.id]
    );

    // Fetch courts
    const courts = await db.query(
      `SELECT c.*, s.name as sport_name, s.icon as sport_icon 
       FROM courts c 
       JOIN sports s ON c.sport_id = s.id 
       WHERE c.venue_id = ? AND c.status = 'ACTIVE'`,
      [v.id]
    );

    // Fetch amenities
    const amenities = await db.query(
      `SELECT a.id, a.name, a.icon FROM amenities a JOIN venue_amenities va ON a.id = va.amenity_id WHERE va.venue_id = ?`,
      [v.id]
    );

    // Fetch reviews
    const reviews = await db.query(
      `SELECT r.*, u.full_name as user_name, u.profile_photo as user_photo
       FROM reviews r
       JOIN users u ON r.user_id = u.id
       WHERE r.venue_id = ?
       ORDER BY r.created_at DESC`,
      [v.id]
    );

    // Calculate rating metrics
    const avgRating = reviews.length > 0
      ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1)
      : '4.8';

    res.json({
      success: true,
      data: {
        id: v.id,
        name: v.name,
        slug: v.slug,
        description: v.description,
        address: v.address,
        city: v.city,
        state: v.state,
        pincode: v.pincode,
        cancellationPolicy: v.cancellation_policy,
        rules: v.rules,
        rating: avgRating,
        reviewCount: reviews.length,
        images: images.length > 0 ? images.map(img => img.image_url) : [
          'https://images.unsplash.com/photo-1529900748604-07564a03e7a6?auto=format&fit=crop&w=1200&q=80'
        ],
        courts: courts.map(c => ({
          id: c.id,
          name: c.name,
          sportId: c.sport_id,
          sportName: c.sport_name,
          sportIcon: c.sport_icon,
          surfaceType: c.surface_type,
          slotDurationMinutes: c.slot_duration_minutes,
          basePrice: parseFloat(c.base_price_per_hour),
          status: c.status
        })),
        amenities: amenities,
        reviews: reviews.map(r => ({
          id: r.id,
          userName: r.user_name,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.created_at
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

const createVenue = async (req, res, next) => {
  try {
    const { name, description, address, city, state, pincode, cancellationPolicy, rules } = req.body;
    const ownerId = req.user.id;

    if (!name || !address || !city || !state || !pincode) {
      return res.status(400).json({ success: false, message: 'Name, address, city, state, and pincode are required.' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '') + '-' + Date.now();

    const result = await db.query(
      `INSERT INTO venues (owner_id, name, slug, description, address, city, state, pincode, cancellation_policy, rules, status) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPROVED')`,
      [ownerId, name, slug, description || '', address, city, state, pincode, cancellationPolicy || '', rules || '']
    );

    const venueId = result.insertId;

    // Attach sample image if uploaded
    if (req.file) {
      const imageUrl = `/uploads/${req.file.filename}`;
      await db.query(
        `INSERT INTO venue_images (venue_id, image_url, is_primary) VALUES (?, ?, 1)`,
        [venueId, imageUrl]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Venue registered successfully!',
      data: { venueId, name, slug }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getAllVenues,
  getVenueByIdOrSlug,
  createVenue
};
