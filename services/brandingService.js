const db = require('../config/database');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { getIO } = require('./socketService');

// Ensure branding uploads directory exists
const BRANDING_UPLOAD_DIR = path.join(__dirname, '../uploads/branding');
if (!fs.existsSync(BRANDING_UPLOAD_DIR)) {
  fs.mkdirSync(BRANDING_UPLOAD_DIR, { recursive: true });
}

// In-memory cached branding object
let cachedBranding = null;
let columnsVerified = false;

const DEFAULT_BRANDING = {
  appName: 'TurfSpot',
  appTagline: 'Sports Hub',
  logoUrl: '/logo.png',
  faviconUrl: '/favicon.ico',
  logoDarkUrl: null,
  contactEmail: null,
  showExploreVenues: true,
  showMyBookings: true,
  showChatImageUpload: true,
  disableRightClick: false,
  updatedAt: new Date().toISOString()
};

/**
 * Self-healing schema validation: ensures feature toggle columns exist in app_branding
 */
async function ensureBrandingColumns() {
  if (columnsVerified) return;
  try {
    const cols = await db.query('DESCRIBE app_branding');
    const colNames = (cols || []).map(c => c.Field);
    if (!colNames.includes('show_explore_venues')) {
      await db.query('ALTER TABLE app_branding ADD COLUMN show_explore_venues TINYINT(1) NOT NULL DEFAULT 1');
      console.log('✅ Added show_explore_venues column to app_branding');
    }
    if (!colNames.includes('show_my_bookings')) {
      await db.query('ALTER TABLE app_branding ADD COLUMN show_my_bookings TINYINT(1) NOT NULL DEFAULT 1');
      console.log('✅ Added show_my_bookings column to app_branding');
    }
    if (!colNames.includes('show_chat_image_upload')) {
      await db.query('ALTER TABLE app_branding ADD COLUMN show_chat_image_upload TINYINT(1) NOT NULL DEFAULT 1');
      console.log('✅ Added show_chat_image_upload column to app_branding');
    }
    if (!colNames.includes('disable_right_click')) {
      await db.query('ALTER TABLE app_branding ADD COLUMN disable_right_click TINYINT(1) NOT NULL DEFAULT 0');
      console.log('✅ Added disable_right_click column to app_branding');
    }
    columnsVerified = true;
  } catch (err) {
    console.warn('[Branding] Column verification warning:', err.message);
  }
}

// Auto-run schema check asynchronously on startup
setImmediate(() => {
  ensureBrandingColumns().catch(e => console.warn('[Branding] Startup column check error:', e.message));
});

/**
 * Format branding entity for API responses and client consumption
 */
function formatBranding(row) {
  if (!row) return { ...DEFAULT_BRANDING };

  const updatedAtMs = row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
  const rawLogo = row.logo_url || '/logo.png';
  const rawFavicon = row.favicon_url || '/favicon.ico';

  // Add cache-busting query parameter for uploaded files to prevent browser caching stale logos
  const versionedLogo = rawLogo.startsWith('/uploads') ? `${rawLogo}?v=${updatedAtMs}` : rawLogo;
  const versionedFavicon = rawFavicon.startsWith('/uploads') ? `${rawFavicon}?v=${updatedAtMs}` : rawFavicon;

  return {
    appName: row.app_name || DEFAULT_BRANDING.appName,
    appTagline: row.app_tagline || DEFAULT_BRANDING.appTagline,
    logoUrl: versionedLogo,
    rawLogoUrl: rawLogo,
    faviconUrl: versionedFavicon,
    rawFaviconUrl: rawFavicon,
    logoDarkUrl: row.logo_dark_url || null,
    contactEmail: row.contact_email || null,
    showExploreVenues: row.show_explore_venues !== undefined && row.show_explore_venues !== null ? (Number(row.show_explore_venues) === 1) : true,
    showMyBookings: row.show_my_bookings !== undefined && row.show_my_bookings !== null ? (Number(row.show_my_bookings) === 1) : true,
    showChatImageUpload: row.show_chat_image_upload !== undefined && row.show_chat_image_upload !== null ? (Number(row.show_chat_image_upload) === 1) : true,
    disableRightClick: row.disable_right_click !== undefined && row.disable_right_click !== null ? (Number(row.disable_right_click) === 1) : false,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : DEFAULT_BRANDING.updatedAt
  };
}

/**
 * Get active branding configuration (cached for high performance)
 */
async function getBranding(forceRefresh = false) {
  if (cachedBranding && !forceRefresh) {
    return cachedBranding;
  }

  try {
    const rows = await db.query('SELECT * FROM app_branding WHERE id = 1 LIMIT 1');
    if (rows && rows.length > 0) {
      cachedBranding = formatBranding(rows[0]);
    } else {
      // Seed default record if missing
      await db.query(`
        INSERT INTO app_branding (id, app_name, app_tagline, logo_url, favicon_url)
        VALUES (1, 'TurfSpot', 'Sports Hub', '/logo.png', '/favicon.ico')
      `);
      cachedBranding = { ...DEFAULT_BRANDING };
    }
  } catch (err) {
    console.error('Error fetching app branding from DB, using fallback defaults:', err.message);
    cachedBranding = { ...DEFAULT_BRANDING };
  }

  return cachedBranding;
}

/**
 * Sanitize and securely optimize uploaded logo image
 */
async function processLogoUpload(file) {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  const timestamp = Date.now();
  const isSvg = file.mimetype === 'image/svg+xml' || ext === '.svg';

  if (isSvg) {
    // Read and sanitize SVG content against XSS vectors
    const content = fs.readFileSync(file.path, 'utf8');
    if (/<script/i.test(content) || /javascript:/i.test(content) || /onerror\s*=/i.test(content) || /onload\s*=/i.test(content)) {
      try { fs.unlinkSync(file.path); } catch (e) {}
      throw { statusCode: 400, message: 'Malicious SVG code detected. Please upload a clean SVG or PNG.' };
    }
    const finalFilename = `logo-${timestamp}.svg`;
    const finalPath = path.join(BRANDING_UPLOAD_DIR, finalFilename);
    fs.writeFileSync(finalPath, content, 'utf8');
    try { fs.unlinkSync(file.path); } catch (e) {}
    return `/uploads/branding/${finalFilename}`;
  }

  // PNG, JPEG, WEBP: Optimize with sharp
  const finalFilename = `logo-${timestamp}.png`;
  const finalPath = path.join(BRANDING_UPLOAD_DIR, finalFilename);

  try {
    const image = sharp(file.path);
    const metadata = await image.metadata();

    // Verify valid dimensions
    if (!metadata.width || !metadata.height) {
      throw new Error('Invalid image file dimensions.');
    }

    // Resize if oversized (max 800px width/height while preserving transparency)
    await image
      .resize({
        width: 800,
        height: 800,
        fit: sharp.fit.inside,
        withoutEnlargement: true
      })
      .png({ quality: 95, compressionLevel: 8 })
      .toFile(finalPath);

    try { fs.unlinkSync(file.path); } catch (e) {}
    return `/uploads/branding/${finalFilename}`;
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch (e) {}
    throw { statusCode: 400, message: `Image optimization error: ${err.message}` };
  }
}

/**
 * Sanitize and process uploaded favicon
 */
async function processFaviconUpload(file) {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  const timestamp = Date.now();

  if (ext === '.ico') {
    const finalFilename = `favicon-${timestamp}.ico`;
    const finalPath = path.join(BRANDING_UPLOAD_DIR, finalFilename);
    fs.copyFileSync(file.path, finalPath);
    try { fs.unlinkSync(file.path); } catch (e) {}
    return `/uploads/branding/${finalFilename}`;
  }

  // Resize icon to standard 64x64 or 32x32 PNG favicon
  const finalFilename = `favicon-${timestamp}.png`;
  const finalPath = path.join(BRANDING_UPLOAD_DIR, finalFilename);

  try {
    await sharp(file.path)
      .resize(64, 64, { fit: sharp.fit.contain, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ quality: 95 })
      .toFile(finalPath);

    try { fs.unlinkSync(file.path); } catch (e) {}
    return `/uploads/branding/${finalFilename}`;
  } catch (err) {
    try { fs.unlinkSync(file.path); } catch (e) {}
    throw { statusCode: 400, message: `Favicon processing error: ${err.message}` };
  }
}

/**
 * Update software branding settings (Superadmin / Admin only)
 */
async function updateBranding({ appName, appTagline, logoFile, faviconFile, removeLogo, removeFavicon, contactEmail, user, ipAddress }) {
  // Validate name
  const trimmedName = String(appName || '').trim();
  if (!trimmedName || trimmedName.length < 2) {
    throw { statusCode: 400, message: 'Application name must be at least 2 characters.' };
  }
  if (trimmedName.length > 100) {
    throw { statusCode: 400, message: 'Application name cannot exceed 100 characters.' };
  }

  const trimmedTagline = String(appTagline || '').trim();

  // Get current branding
  const [current] = await db.query('SELECT * FROM app_branding WHERE id = 1');
  const currentFormatted = formatBranding(current);

  let newLogoUrl = current?.logo_url || '/logo.png';
  let newFaviconUrl = current?.favicon_url || '/favicon.ico';

  if (removeLogo === 'true' || removeLogo === true) {
    newLogoUrl = '/logo.png';
  } else if (logoFile) {
    newLogoUrl = await processLogoUpload(logoFile);
  }

  if (removeFavicon === 'true' || removeFavicon === true) {
    newFaviconUrl = '/favicon.ico';
  } else if (faviconFile) {
    newFaviconUrl = await processFaviconUpload(faviconFile);
  }

  // Update DB
  await db.query(`
    UPDATE app_branding
    SET app_name = ?,
        app_tagline = ?,
        logo_url = ?,
        favicon_url = ?,
        contact_email = ?,
        updated_by = ?,
        updated_at = NOW()
    WHERE id = 1
  `, [
    trimmedName,
    trimmedTagline || null,
    newLogoUrl,
    newFaviconUrl,
    contactEmail ? String(contactEmail).trim() : null,
    user?.id || null
  ]);

  // Refresh in-memory cache
  cachedBranding = await getBranding(true);

  // Write audit trail
  const changes = {
    previous: {
      appName: currentFormatted.appName,
      appTagline: currentFormatted.appTagline,
      logoUrl: currentFormatted.rawLogoUrl,
      faviconUrl: currentFormatted.rawFaviconUrl
    },
    updated: {
      appName: cachedBranding.appName,
      appTagline: cachedBranding.appTagline,
      logoUrl: cachedBranding.rawLogoUrl,
      faviconUrl: cachedBranding.rawFaviconUrl
    }
  };

  await db.query(`
    INSERT INTO app_branding_audit_logs (user_id, user_email, user_role, action, details, ip_address)
    VALUES (?, ?, ?, 'UPDATE_BRANDING', ?, ?)
  `, [
    user?.id || null,
    user?.email || 'admin',
    user?.role || 'ADMIN',
    JSON.stringify(changes),
    ipAddress || null
  ]);

  // Broadcast real-time WebSocket update to all open web sessions, TVs, and mobile devices
  const io = getIO();
  if (io) {
    io.emit('system:branding_updated', cachedBranding);
  }

  return cachedBranding;
}

/**
 * Reset branding to default system defaults
 */
async function resetBranding({ user, ipAddress }) {
  const [current] = await db.query('SELECT * FROM app_branding WHERE id = 1');
  const currentFormatted = formatBranding(current);

  await db.query(`
    UPDATE app_branding
    SET app_name = 'TurfSpot',
        app_tagline = 'Sports Hub',
        logo_url = '/logo.png',
        favicon_url = '/favicon.ico',
        logo_dark_url = NULL,
        contact_email = NULL,
        updated_by = ?,
        updated_at = NOW()
    WHERE id = 1
  `, [user?.id || null]);

  cachedBranding = await getBranding(true);

  // Write audit log
  await db.query(`
    INSERT INTO app_branding_audit_logs (user_id, user_email, user_role, action, details, ip_address)
    VALUES (?, ?, ?, 'RESET_DEFAULT', ?, ?)
  `, [
    user?.id || null,
    user?.email || 'admin',
    user?.role || 'ADMIN',
    JSON.stringify({
      previous: currentFormatted,
      resetToDefault: true
    }),
    ipAddress || null
  ]);

  // Broadcast real-time WebSocket update
  const io = getIO();
  if (io) {
    io.emit('system:branding_updated', cachedBranding);
  }

  return cachedBranding;
}

/**
 * Get branding audit logs
 */
async function getAuditLogs(limit = 25) {
  const rows = await db.query(`
    SELECT l.*, u.full_name as user_full_name
    FROM app_branding_audit_logs l
    LEFT JOIN users u ON l.user_id = u.id
    ORDER BY l.id DESC
    LIMIT ?
  `, [parseInt(limit, 10) || 25]);

  return rows.map(r => ({
    id: r.id,
    userId: r.user_id,
    userEmail: r.user_email,
    userFullName: r.user_full_name || r.user_email,
    userRole: r.user_role,
    action: r.action,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
    ipAddress: r.ip_address,
    createdAt: r.created_at
  }));
}

/**
 * Update platform feature toggles (Explore Venues, My Bookings, Chat Image Upload, Disable Right Click)
 */
async function updateFeatureToggles({ showExploreVenues, showMyBookings, showChatImageUpload, disableRightClick, user, ipAddress }) {
  await ensureBrandingColumns();

  const [current] = await db.query('SELECT * FROM app_branding WHERE id = 1');
  const currentFormatted = formatBranding(current);

  const updates = [];
  const params = [];

  if (showExploreVenues !== undefined) {
    updates.push('show_explore_venues = ?');
    params.push(showExploreVenues ? 1 : 0);
  }
  if (showMyBookings !== undefined) {
    updates.push('show_my_bookings = ?');
    params.push(showMyBookings ? 1 : 0);
  }
  if (showChatImageUpload !== undefined) {
    updates.push('show_chat_image_upload = ?');
    params.push(showChatImageUpload ? 1 : 0);
  }
  if (disableRightClick !== undefined) {
    updates.push('disable_right_click = ?');
    params.push(disableRightClick ? 1 : 0);
  }

  if (updates.length > 0) {
    updates.push('updated_at = NOW()');
    if (user?.id) {
      updates.push('updated_by = ?');
      params.push(user.id);
    }
    params.push(1);
    await db.query(`UPDATE app_branding SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  cachedBranding = await getBranding(true);

  // Write audit log
  try {
    await db.query(`
      INSERT INTO app_branding_audit_logs (user_id, user_email, user_role, action, details, ip_address)
      VALUES (?, ?, ?, 'UPDATE_FEATURE_TOGGLES', ?, ?)
    `, [
      user?.id || null,
      user?.email || 'admin',
      user?.role || 'ADMIN',
      JSON.stringify({
        previous: {
          showExploreVenues: currentFormatted.showExploreVenues,
          showMyBookings: currentFormatted.showMyBookings,
          showChatImageUpload: currentFormatted.showChatImageUpload,
          disableRightClick: currentFormatted.disableRightClick
        },
        updated: {
          showExploreVenues: cachedBranding.showExploreVenues,
          showMyBookings: cachedBranding.showMyBookings,
          showChatImageUpload: cachedBranding.showChatImageUpload,
          disableRightClick: cachedBranding.disableRightClick
        }
      }),
      ipAddress || null
    ]);
  } catch (auditErr) {
    console.warn('[Branding] Audit log warning:', auditErr.message);
  }

  // Broadcast real-time WebSocket update to all connected clients!
  const io = getIO();
  if (io) {
    io.emit('system:branding_updated', cachedBranding);
  }

  return cachedBranding;
}

module.exports = {
  getBranding,
  updateBranding,
  resetBranding,
  updateFeatureToggles,
  getAuditLogs,
  DEFAULT_BRANDING
};

