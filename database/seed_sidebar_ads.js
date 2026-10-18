const db = require('../config/database');

async function seedSidebars() {
  try {
    const existing = await db.query("SELECT id FROM advertisements WHERE position IN ('LEFT', 'RIGHT')");
    if (existing && existing.length > 0) {
      console.log('Sidebar ads already present:', existing.length);
      return;
    }

    await db.query(`
      INSERT INTO advertisements (
        title, name, image_url, width, height, size_preset, image_fit, 
        position, display_mode, motion_type, movement_direction, scroll_direction, 
        scroll_speed, speed, slide_interval, pause_on_hover, priority, sort_order, 
        status, target_page, device_target
      ) VALUES 
      (
        'Red Bull Energy Zone', 'Red Bull Energy Zone', 
        'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?auto=format&fit=crop&w=600&q=80', 
        '180px', '600px', 'SKYSCRAPER', 'cover', 
        'LEFT', 'STATIC', 'STATIC', 'BOTTOM_TO_TOP', 'BOTTOM_TO_TOP', 
        25, 25, 6, 1, 1, 1, 
        'ACTIVE', 'ALL', 'ALL'
      ),
      (
        'Nike Pro Gear', 'Nike Pro Gear', 
        'https://images.unsplash.com/photo-1518611012118-696072aa579a?auto=format&fit=crop&w=600&q=80', 
        '180px', '600px', 'SKYSCRAPER', 'cover', 
        'RIGHT', 'STATIC', 'STATIC', 'TOP_TO_BOTTOM', 'TOP_TO_BOTTOM', 
        25, 25, 6, 1, 1, 1, 
        'ACTIVE', 'ALL', 'ALL'
      )
    `);
    console.log('Successfully seeded Left and Right sidebar advertisements.');
  } catch (err) {
    console.error('Seeding error:', err);
  } finally {
    process.exit(0);
  }
}

seedSidebars();
