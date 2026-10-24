const db = require('../config/database');

async function insertSampleAds() {
  try {
    const existing = await db.query("SELECT id FROM advertisements WHERE position = 'COURT_MIDDLE' LIMIT 1");
    if (existing && existing.length > 0) {
      console.log('COURT_MIDDLE ad already exists');
      return;
    }

    await db.query(`
      INSERT INTO advertisements 
        (name, title, description, link_url, position, image_url, devices, status, sort_order, width, height, image_fit, motion_type, speed, slide_interval)
      VALUES 
        ('Franklin X-40 Official Ball', 'Franklin X-40 Official Ball', 'Official tournament ball', 'https://franklin.example.com', 'COURT_MIDDLE', 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=400&q=80', '["MOBILE", "TV", "SIGNAGE"]', 'ACTIVE', 1, '80px', '240px', 'cover', 'STATIC', 25, 6),
        ('Wilson Pro Staff', 'Wilson Pro Staff', 'Official Racket Partner', 'https://wilson.example.com', 'MOBILE_TOP', 'https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=600&q=80', '["MOBILE"]', 'ACTIVE', 1, '100%', '64px', 'contain', 'SCROLL', 50, 6),
        ('Yonex Tour Grip', 'Yonex Tour Grip', 'Superior Shock Absorption', 'https://yonex.example.com', 'MOBILE_BOTTOM', 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=600&q=80', '["MOBILE"]', 'ACTIVE', 1, '100%', '56px', 'contain', 'SCROLL', 40, 6)
    `);
    console.log('Inserted sample test ads successfully');
  } catch (err) {
    console.error('Error inserting sample ads:', err);
  } finally {
    process.exit(0);
  }
}

insertSampleAds();
