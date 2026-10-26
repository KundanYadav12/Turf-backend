const db = require('../config/database');
const { broadcastSignageEvent } = require('./socketService');

// Sensible defaults for signage display zones (backward-compatible)
const DEFAULT_ZONE_SETTINGS = {
  topHeight: 120,      // in px (range: 40-350)
  leftWidth: 220,      // in px (range: 80-400)
  rightWidth: 220,     // in px (range: 80-400)
  bottomHeight: 70     // in px (range: 40-200)
};

// Sensible defaults for portrait (vertical) signage display zones
const DEFAULT_PORTRAIT_ZONE_SETTINGS = {
  topHeight: 160,          // in px (range: 60-400)
  bottomHeight: 80,        // in px (range: 40-200)
  sidebarStripHeight: 90,  // in px for horizontal sponsor strip (range: 40-200)
  sidebarsMode: 'STRIP'    // 'STRIP' or 'HIDDEN'
};

// Sensible defaults for mobile live viewer ad strips (backward-compatible)
const DEFAULT_MOBILE_ZONE_SETTINGS = {
  topHeight: 64,           // in px (range: 36-150)
  bottomHeight: 56,        // in px (range: 36-120)
  topSpeed: 50,            // in px/sec (range: 15-150)
  bottomSpeed: 40          // in px/sec (range: 15-150)
};

// Sensible defaults for live stream viewer display zones (backward-compatible)
const DEFAULT_STREAM_ZONE_SETTINGS = {
  topHeight: 48,          // in px (range: 24-120)
  bottomHeight: 52,       // in px (range: 24-120)
  leftWidth: 140,         // in px (range: 60-260)
  rightWidth: 140,        // in px (range: 60-260)
  topSpeed: 45,           // in px/sec (range: 15-120)
  bottomSpeed: 45,        // in px/sec (range: 15-120)
  rotateInterval: 6,      // in seconds (range: 3-20)
  breakInterval: 5,       // in seconds (range: 3-15)
  hideSidebarsOnMobile: true
};

// Authoritative real-time playback state
let playbackState = {
  adsEnabled: true,
  topAdMode: 'STATIC',
  bottomAdMode: 'MOTION',
  bottomAdPaused: false,
  sidebarAdsEnabled: true,
  leftSidebarPaused: false,
  rightSidebarPaused: false,
  zoneSettings: { ...DEFAULT_ZONE_SETTINGS },
  venueZoneSettings: {}, // venueId -> { topHeight, leftWidth, rightWidth, bottomHeight }
  portraitZoneSettings: { ...DEFAULT_PORTRAIT_ZONE_SETTINGS },
  venuePortraitZoneSettings: {}, // venueId -> { topHeight, bottomHeight, sidebarStripHeight, sidebarsMode }
  mobileZoneSettings: { ...DEFAULT_MOBILE_ZONE_SETTINGS },
  venueMobileZoneSettings: {}, // venueId -> { topHeight, bottomHeight, topSpeed, bottomSpeed }
  streamZoneSettings: { ...DEFAULT_STREAM_ZONE_SETTINGS },
  venueStreamZoneSettings: {}, // venueId -> { topHeight, bottomHeight, leftWidth, rightWidth, topSpeed, bottomSpeed, rotateInterval, breakInterval, hideSidebarsOnMobile }
  updatedAt: new Date().toISOString()
};

/**
 * Returns current global playback state
 */
const getPlaybackState = () => {
  return { ...playbackState };
};

/**
 * Controls ad playback state in real-time
 */
const controlPlayback = (action, payload = {}) => {
  switch (action) {
    case 'HOLD':
      playbackState.bottomAdPaused = true;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adPaused', { bottomAdPaused: true, playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'RESUME':
      playbackState.bottomAdPaused = false;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adResumed', { bottomAdPaused: false, playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'STOP_ADS':
      playbackState.adsEnabled = false;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adsDisabled', { adsEnabled: false, playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'START_ADS':
      playbackState.adsEnabled = true;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adsEnabled', { adsEnabled: true, playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'HOLD_SIDEBARS':
      playbackState.leftSidebarPaused = true;
      playbackState.rightSidebarPaused = true;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'RESUME_SIDEBARS':
      playbackState.leftSidebarPaused = false;
      playbackState.rightSidebarPaused = false;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'STOP_SIDEBARS':
      playbackState.sidebarAdsEnabled = false;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'START_SIDEBARS':
      playbackState.sidebarAdsEnabled = true;
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      break;

    case 'SET_BOTTOM_MODE':
      if (['STATIC', 'MOTION', 'HOLD', 'PAUSED', 'HIDDEN'].includes(payload.mode)) {
        playbackState.bottomAdMode = payload.mode;
        if (payload.mode === 'PAUSED' || payload.mode === 'HOLD') playbackState.bottomAdPaused = true;
        if (payload.mode === 'MOTION') playbackState.bottomAdPaused = false;
        playbackState.updatedAt = new Date().toISOString();
        broadcastSignageEvent('signage:adUpdated', { playbackState });
        broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      }
      break;

    case 'SET_TOP_MODE':
      if (['STATIC', 'CROSSFADE', 'PAUSED', 'HIDDEN'].includes(payload.mode)) {
        playbackState.topAdMode = payload.mode;
        playbackState.updatedAt = new Date().toISOString();
        broadcastSignageEvent('signage:adUpdated', { playbackState });
        broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      }
      break;

    case 'UPDATE_ZONE_SIZES':
    case 'SET_ZONE_SIZES': {
      const venueId = payload.venueId;
      const isMobile = Boolean(payload.isMobile || payload.orientation === 'MOBILE');
      const isPortrait = Boolean(payload.isPortrait || payload.orientation === 'PORTRAIT');
      const isStream = Boolean(payload.isStream || payload.orientation === 'STREAM');
      const targetSizes = payload.sizes || { ...payload };
      delete targetSizes.venueId;
      delete targetSizes.isPortrait;
      delete targetSizes.isMobile;
      delete targetSizes.isStream;
      delete targetSizes.orientation;

      if (isStream) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          playbackState.venueStreamZoneSettings[vKey] = {
            ...DEFAULT_STREAM_ZONE_SETTINGS,
            ...(playbackState.venueStreamZoneSettings[vKey] || {}),
            ...targetSizes
          };
        } else {
          playbackState.streamZoneSettings = {
            ...playbackState.streamZoneSettings,
            ...targetSizes
          };
        }
      } else if (isMobile) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          playbackState.venueMobileZoneSettings[vKey] = {
            ...DEFAULT_MOBILE_ZONE_SETTINGS,
            ...(playbackState.venueMobileZoneSettings[vKey] || {}),
            ...targetSizes
          };
        } else {
          playbackState.mobileZoneSettings = {
            ...playbackState.mobileZoneSettings,
            ...targetSizes
          };
        }
      } else if (isPortrait) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          playbackState.venuePortraitZoneSettings[vKey] = {
            ...DEFAULT_PORTRAIT_ZONE_SETTINGS,
            ...(playbackState.venuePortraitZoneSettings[vKey] || {}),
            ...targetSizes
          };
        } else {
          playbackState.portraitZoneSettings = {
            ...playbackState.portraitZoneSettings,
            ...targetSizes
          };
        }
      } else {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          playbackState.venueZoneSettings[vKey] = {
            ...DEFAULT_ZONE_SETTINGS,
            ...(playbackState.venueZoneSettings[vKey] || {}),
            ...targetSizes
          };
        } else {
          playbackState.zoneSettings = {
            ...playbackState.zoneSettings,
            ...targetSizes
          };
        }
      }
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      break;
    }

    case 'RESET_ZONE_SIZE': {
      const { venueId, zone, isPortrait, isMobile, isStream, orientation } = payload;
      const checkStream = Boolean(isStream || orientation === 'STREAM');
      const checkMobile = Boolean(isMobile || orientation === 'MOBILE');
      const checkPortrait = Boolean(isPortrait || orientation === 'PORTRAIT');

      if (checkStream) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          if (zone && zone !== 'ALL' && playbackState.venueStreamZoneSettings[vKey]) {
            delete playbackState.venueStreamZoneSettings[vKey][zone];
            if (Object.keys(playbackState.venueStreamZoneSettings[vKey]).length === 0) {
              delete playbackState.venueStreamZoneSettings[vKey];
            }
          } else {
            delete playbackState.venueStreamZoneSettings[vKey];
          }
        } else {
          if (zone && zone !== 'ALL' && DEFAULT_STREAM_ZONE_SETTINGS[zone] !== undefined) {
            playbackState.streamZoneSettings[zone] = DEFAULT_STREAM_ZONE_SETTINGS[zone];
          } else {
            playbackState.streamZoneSettings = { ...DEFAULT_STREAM_ZONE_SETTINGS };
          }
        }
      } else if (checkMobile) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          if (zone && zone !== 'ALL' && playbackState.venueMobileZoneSettings[vKey]) {
            delete playbackState.venueMobileZoneSettings[vKey][zone];
            if (Object.keys(playbackState.venueMobileZoneSettings[vKey]).length === 0) {
              delete playbackState.venueMobileZoneSettings[vKey];
            }
          } else {
            delete playbackState.venueMobileZoneSettings[vKey];
          }
        } else {
          if (zone && zone !== 'ALL' && DEFAULT_MOBILE_ZONE_SETTINGS[zone] !== undefined) {
            playbackState.mobileZoneSettings[zone] = DEFAULT_MOBILE_ZONE_SETTINGS[zone];
          } else {
            playbackState.mobileZoneSettings = { ...DEFAULT_MOBILE_ZONE_SETTINGS };
          }
        }
      } else if (checkPortrait) {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          if (zone && zone !== 'ALL' && playbackState.venuePortraitZoneSettings[vKey]) {
            delete playbackState.venuePortraitZoneSettings[vKey][zone];
            if (Object.keys(playbackState.venuePortraitZoneSettings[vKey]).length === 0) {
              delete playbackState.venuePortraitZoneSettings[vKey];
            }
          } else {
            delete playbackState.venuePortraitZoneSettings[vKey];
          }
        } else {
          if (zone && zone !== 'ALL' && DEFAULT_PORTRAIT_ZONE_SETTINGS[zone] !== undefined) {
            playbackState.portraitZoneSettings[zone] = DEFAULT_PORTRAIT_ZONE_SETTINGS[zone];
          } else {
            playbackState.portraitZoneSettings = { ...DEFAULT_PORTRAIT_ZONE_SETTINGS };
          }
        }
      } else {
        if (venueId && venueId !== 'ALL' && venueId !== 'GLOBAL') {
          const vKey = String(venueId);
          if (zone && zone !== 'ALL' && playbackState.venueZoneSettings[vKey]) {
            delete playbackState.venueZoneSettings[vKey][zone];
            if (Object.keys(playbackState.venueZoneSettings[vKey]).length === 0) {
              delete playbackState.venueZoneSettings[vKey];
            }
          } else {
            delete playbackState.venueZoneSettings[vKey];
          }
        } else {
          if (zone && zone !== 'ALL' && DEFAULT_ZONE_SETTINGS[zone] !== undefined) {
            playbackState.zoneSettings[zone] = DEFAULT_ZONE_SETTINGS[zone];
          } else {
            playbackState.zoneSettings = { ...DEFAULT_ZONE_SETTINGS };
          }
        }
      }
      playbackState.updatedAt = new Date().toISOString();
      broadcastSignageEvent('signage:playbackUpdated', { playbackState });
      broadcastSignageEvent('signage:adUpdated', { playbackState });
      break;
    }

    default:
      break;
  }

  return { ...playbackState };
};

/**
 * Helper to normalize ad entity
 */
const formatAd = (row) => {
  let venueIds = [];
  if (row.venue_ids) {
    if (typeof row.venue_ids === 'string') {
      try {
        venueIds = JSON.parse(row.venue_ids);
      } catch (e) {
        venueIds = [];
      }
    } else if (Array.isArray(row.venue_ids)) {
      venueIds = row.venue_ids;
    }
  }

  let tournamentIds = [];
  if (row.tournament_ids) {
    if (typeof row.tournament_ids === 'string') {
      try {
        tournamentIds = JSON.parse(row.tournament_ids);
      } catch (e) {
        tournamentIds = [];
      }
    } else if (Array.isArray(row.tournament_ids)) {
      tournamentIds = row.tournament_ids;
    }
  }
  if ((!tournamentIds || tournamentIds.length === 0) && row.tournament_id) {
    tournamentIds = [row.tournament_id];
  }

  let devices = ['MOBILE', 'TV', 'SIGNAGE'];
  if (row.devices) {
    if (typeof row.devices === 'string') {
      try {
        devices = JSON.parse(row.devices);
      } catch (e) {
        devices = ['MOBILE', 'TV', 'SIGNAGE'];
      }
    } else if (Array.isArray(row.devices)) {
      devices = row.devices;
    }
  } else if (row.device_target && row.device_target !== 'ALL') {
    devices = [row.device_target];
  }

  const validPositions = [
    'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'BOTH_SIDEBARS',
    'COURT', 'COURT_MIDDLE', 'MOBILE_TOP', 'MOBILE_BOTTOM',
    'STREAM_TOP', 'STREAM_BOTTOM', 'STREAM_LEFT', 'STREAM_RIGHT', 'STREAM_BREAK'
  ];
  const rawPos = (row.position || '').toUpperCase();
  const position = validPositions.includes(rawPos) ? rawPos : 'TOP';

  return {
    id: row.id,
    title: row.title || row.name,
    description: row.description || '',
    linkUrl: row.link_url || '',
    imageUrl: row.image_url,
    position,
    width: row.width || (
      position === 'LEFT' || position === 'RIGHT' ? '240px' :
      position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' ? '140px' :
      position === 'COURT_MIDDLE' ? '80px' : '100%'
    ),
    height: row.height || (
      position === 'TOP' ? '80px' :
      position === 'BOTTOM' ? '48px' :
      position === 'STREAM_TOP' ? '48px' :
      position === 'STREAM_BOTTOM' ? '52px' :
      position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' || position === 'STREAM_BREAK' ? '100%' :
      position === 'COURT_MIDDLE' ? '240px' :
      position === 'MOBILE_TOP' ? '64px' :
      position === 'MOBILE_BOTTOM' ? '56px' : 'auto'
    ),
    sizePreset: row.size_preset || 'RESPONSIVE',
    imageFit: row.image_fit || (position === 'COURT_MIDDLE' ? 'cover' : 'contain'),
    motionType: row.motion_type || (
      row.display_mode === 'MOTION' ? 'SCROLL' :
      (position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' || position === 'STREAM_BREAK') ? 'CROSSFADE' :
      'STATIC'
    ),
    movementDirection: row.movement_direction || (
      (row.scroll_direction === 'LEFT_TO_RIGHT' || position === 'STREAM_BOTTOM' || position === 'MOBILE_BOTTOM')
        ? 'LEFT_TO_RIGHT'
        : 'RIGHT_TO_LEFT'
    ),
    displayMode: row.display_mode || (position === 'TOP' ? 'STATIC' : 'MOTION'),
    status: row.status || 'ACTIVE',
    sortOrder: row.sort_order ?? row.priority ?? 0,
    speed: parseInt(row.speed || row.scroll_speed || (position === 'MOBILE_TOP' ? 50 : position === 'MOBILE_BOTTOM' ? 40 : position.startsWith('STREAM') ? 45 : 25), 10),
    slideInterval: parseInt(row.slide_interval || 6, 10),
    pauseOnHover: row.pause_on_hover === 1 || row.pause_on_hover === true || row.pause_on_hover === undefined,
    targetPage: row.target_page || 'ALL',
    deviceTarget: row.device_target || 'ALL',
    devices: Array.isArray(devices) && devices.length > 0 ? devices : ['MOBILE', 'TV', 'SIGNAGE'],
    venueIds: Array.isArray(venueIds) ? venueIds.map(Number).filter(n => !isNaN(n)) : [],
    tournamentIds: Array.isArray(tournamentIds) ? tournamentIds.map(Number).filter(n => !isNaN(n)) : [],
    startDate: row.start_date,
    endDate: row.end_date,
    tournamentId: row.tournament_id || (tournamentIds.length > 0 ? tournamentIds[0] : null),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
};

/**
 * Get active ads for signage display, mobile live viewer, and other pages.
 * Resolves tournament-specific vs global ad priority:
 * Tournament-specific ad -> Global ad -> No advertisement
 */
const getActiveAds = async ({ tournamentId, venueId, device } = {}) => {
  let resolvedTournId = null;
  let resolvedVenueId = venueId ? parseInt(venueId, 10) : null;

  if (tournamentId) {
    if (!isNaN(tournamentId)) {
      resolvedTournId = parseInt(tournamentId, 10);
    } else {
      // Look up internal id from uuid
      const tRows = await db.query('SELECT id, venue_id FROM tournaments WHERE uuid = ?', [tournamentId]);
      if (tRows.length > 0) {
        resolvedTournId = tRows[0].id;
        if (!resolvedVenueId && tRows[0].venue_id) {
          resolvedVenueId = tRows[0].venue_id;
        }
      }
    }
  }

  if (resolvedTournId && !resolvedVenueId) {
    const tRows = await db.query('SELECT venue_id FROM tournaments WHERE id = ?', [resolvedTournId]);
    if (tRows.length > 0 && tRows[0].venue_id) {
      resolvedVenueId = tRows[0].venue_id;
    }
  }

  // Query active ads within scheduled date range
  const allActiveRows = await db.query(`
    SELECT * FROM advertisements
    WHERE status = 'ACTIVE'
      AND (start_date IS NULL OR start_date <= CURDATE())
      AND (end_date IS NULL OR end_date >= CURDATE())
    ORDER BY sort_order ASC, priority DESC, id ASC
  `);

  let activeAds = allActiveRows.map(formatAd);

  // Filter by device if specified (MOBILE, TV, SIGNAGE)
  if (device && device !== 'ALL') {
    const devUpper = device.toUpperCase();
    activeAds = activeAds.filter(a => {
      if (!a.devices || a.devices.length === 0 || a.devices.includes('ALL')) return true;
      return a.devices.includes(devUpper);
    });
  }

  // Filter by venueId if resolvedVenueId is present
  if (resolvedVenueId) {
    activeAds = activeAds.filter(a => !a.venueIds || a.venueIds.length === 0 || a.venueIds.includes(resolvedVenueId));
  }

  // Display rule: match current tournament OR all tournaments
  if (resolvedTournId) {
    activeAds = activeAds.filter(a => !a.tournamentIds || a.tournamentIds.length === 0 || a.tournamentIds.includes(resolvedTournId));
  }

  // Resolution rule: show tournament-specific ads first, then rotate in the rest by display order
  const resolvePositionPriority = (ads) => {
    if (resolvedTournId) {
      const tournAds = ads.filter(a => a.tournamentIds && a.tournamentIds.includes(resolvedTournId));
      const allTournAds = ads.filter(a => !a.tournamentIds || a.tournamentIds.length === 0);
      return [...tournAds, ...allTournAds];
    }
    return ads.filter(a => !a.tournamentIds || a.tournamentIds.length === 0);
  };

  // Group by positions
  let topAds = resolvePositionPriority(activeAds.filter(a => a.position === 'TOP'));
  let bottomAds = resolvePositionPriority(activeAds.filter(a => a.position === 'BOTTOM'));
  let leftAds = resolvePositionPriority(activeAds.filter(a => a.position === 'LEFT' || a.position === 'BOTH_SIDEBARS'));
  let rightAds = resolvePositionPriority(activeAds.filter(a => a.position === 'RIGHT' || a.position === 'BOTH_SIDEBARS'));
  let courtAds = resolvePositionPriority(activeAds.filter(a => a.position === 'COURT'));
  let courtMiddleAds = resolvePositionPriority(activeAds.filter(a => a.position === 'COURT_MIDDLE'));
  let mobileTopAds = resolvePositionPriority(activeAds.filter(a => a.position === 'MOBILE_TOP'));
  let mobileBottomAds = resolvePositionPriority(activeAds.filter(a => a.position === 'MOBILE_BOTTOM'));
  let streamTopAds = resolvePositionPriority(activeAds.filter(a => a.position === 'STREAM_TOP'));
  let streamBottomAds = resolvePositionPriority(activeAds.filter(a => a.position === 'STREAM_BOTTOM'));
  let streamLeftAds = resolvePositionPriority(activeAds.filter(a => a.position === 'STREAM_LEFT'));
  let streamRightAds = resolvePositionPriority(activeAds.filter(a => a.position === 'STREAM_RIGHT'));
  let streamBreakAds = resolvePositionPriority(activeAds.filter(a => a.position === 'STREAM_BREAK'));

  const vKey = resolvedVenueId ? String(resolvedVenueId) : null;
  const resolvedZoneSettings = vKey && playbackState.venueZoneSettings[vKey]
    ? { ...DEFAULT_ZONE_SETTINGS, ...playbackState.zoneSettings, ...playbackState.venueZoneSettings[vKey] }
    : { ...DEFAULT_ZONE_SETTINGS, ...playbackState.zoneSettings };

  const resolvedPortraitZoneSettings = vKey && playbackState.venuePortraitZoneSettings?.[vKey]
    ? { ...DEFAULT_PORTRAIT_ZONE_SETTINGS, ...playbackState.portraitZoneSettings, ...playbackState.venuePortraitZoneSettings[vKey] }
    : { ...DEFAULT_PORTRAIT_ZONE_SETTINGS, ...playbackState.portraitZoneSettings };

  const resolvedMobileZoneSettings = vKey && playbackState.venueMobileZoneSettings?.[vKey]
    ? { ...DEFAULT_MOBILE_ZONE_SETTINGS, ...playbackState.mobileZoneSettings, ...playbackState.venueMobileZoneSettings[vKey] }
    : { ...DEFAULT_MOBILE_ZONE_SETTINGS, ...playbackState.mobileZoneSettings };

  const resolvedStreamZoneSettings = vKey && playbackState.venueStreamZoneSettings?.[vKey]
    ? { ...DEFAULT_STREAM_ZONE_SETTINGS, ...playbackState.streamZoneSettings, ...playbackState.venueStreamZoneSettings[vKey] }
    : { ...DEFAULT_STREAM_ZONE_SETTINGS, ...playbackState.streamZoneSettings };

  return {
    state: getPlaybackState(),
    zoneSettings: resolvedZoneSettings,
    venueZoneSettings: playbackState.venueZoneSettings,
    portraitZoneSettings: resolvedPortraitZoneSettings,
    venuePortraitZoneSettings: playbackState.venuePortraitZoneSettings,
    mobileZoneSettings: resolvedMobileZoneSettings,
    venueMobileZoneSettings: playbackState.venueMobileZoneSettings,
    streamZoneSettings: resolvedStreamZoneSettings,
    venueStreamZoneSettings: playbackState.venueStreamZoneSettings,
    topAds,
    bottomAds,
    leftAds,
    rightAds,
    courtAds,
    courtMiddleAds,
    mobileTopAds,
    mobileBottomAds,
    streamTopAds,
    streamBottomAds,
    streamLeftAds,
    streamRightAds,
    streamBreakAds,
    allActiveAds: activeAds
  };
};

/**
 * Get all advertisements for Super Admin dashboard
 */
const getAllAds = async () => {
  const rows = await db.query(`
    SELECT a.*, t.name as tournament_name
    FROM advertisements a
    LEFT JOIN tournaments t ON a.tournament_id = t.id
    ORDER BY 
      CASE a.position
        WHEN 'TOP' THEN 1
        WHEN 'LEFT' THEN 2
        WHEN 'RIGHT' THEN 3
        WHEN 'BOTH_SIDEBARS' THEN 4
        WHEN 'BOTTOM' THEN 5
        WHEN 'COURT' THEN 6
        WHEN 'COURT_MIDDLE' THEN 7
        WHEN 'MOBILE_TOP' THEN 8
        WHEN 'MOBILE_BOTTOM' THEN 9
        WHEN 'STREAM_TOP' THEN 10
        WHEN 'STREAM_BOTTOM' THEN 11
        WHEN 'STREAM_LEFT' THEN 12
        WHEN 'STREAM_RIGHT' THEN 13
        WHEN 'STREAM_BREAK' THEN 14
        ELSE 15
      END,
      a.sort_order ASC, a.id DESC
  `);
  return rows.map(r => ({
    ...formatAd(r),
    tournamentName: r.tournament_name
  }));
};

/**
 * Create new advertisement with sizing and motion parameters
 */
const createAd = async (adData, userId = null) => {
  const title = adData.title || adData.name || 'Advertisement';
  const description = adData.description || null;
  const linkUrl = adData.linkUrl || adData.link_url || null;
  const imageUrl = adData.imageUrl || adData.image_url;
  
  const validPositions = [
    'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'BOTH_SIDEBARS',
    'COURT', 'COURT_MIDDLE', 'MOBILE_TOP', 'MOBILE_BOTTOM',
    'STREAM_TOP', 'STREAM_BOTTOM', 'STREAM_LEFT', 'STREAM_RIGHT', 'STREAM_BREAK'
  ];
  const posUpper = (adData.position || '').toUpperCase();
  const position = validPositions.includes(posUpper) ? posUpper : 'TOP';

  const width = adData.width || (
    position === 'LEFT' || position === 'RIGHT' ? '240px' :
    position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' ? '140px' :
    position === 'COURT' ? '50%' :
    position === 'COURT_MIDDLE' ? '80px' : '100%'
  );
  const height = adData.height || (
    position === 'TOP' ? '80px' :
    position === 'BOTTOM' ? '48px' :
    position === 'STREAM_TOP' ? '48px' :
    position === 'STREAM_BOTTOM' ? '52px' :
    position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' || position === 'STREAM_BREAK' ? '100%' :
    position === 'COURT' ? '80%' :
    position === 'COURT_MIDDLE' ? '240px' :
    position === 'MOBILE_TOP' ? '64px' :
    position === 'MOBILE_BOTTOM' ? '56px' : 'auto'
  );
  const sizePreset = adData.sizePreset || adData.size_preset || 'RESPONSIVE';
  const imageFit = ['contain', 'cover', 'fill', 'scale-down'].includes(adData.imageFit) ? adData.imageFit : (position === 'COURT_MIDDLE' ? 'cover' : 'contain');

  const validMotionTypes = ['STATIC', 'SCROLL', 'SLIDE', 'CAROUSEL', 'MARQUEE', 'CROSSFADE'];
  const motionType = validMotionTypes.includes(adData.motionType)
    ? adData.motionType
    : (position === 'BOTTOM' || position === 'MOBILE_TOP' || position === 'MOBILE_BOTTOM' ? 'SCROLL' : 'STATIC');

  const validDirections = ['RIGHT_TO_LEFT', 'LEFT_TO_RIGHT', 'BOTTOM_TO_TOP', 'TOP_TO_BOTTOM'];
  const movementDirection = validDirections.includes(adData.movementDirection)
    ? adData.movementDirection
    : (position === 'LEFT' || position === 'RIGHT' ? 'BOTTOM_TO_TOP' :
       position === 'MOBILE_BOTTOM' ? 'LEFT_TO_RIGHT' : 'RIGHT_TO_LEFT');

  const displayMode = motionType === 'STATIC' ? 'STATIC' : 'MOTION';
  const speed = parseInt(adData.speed || adData.scrollSpeed || (position === 'MOBILE_TOP' ? 50 : position === 'MOBILE_BOTTOM' ? 40 : 25), 10);
  const slideInterval = parseInt(adData.slideInterval || 6, 10);
  const pauseOnHover = adData.pauseOnHover === false || adData.pauseOnHover === 'false' || adData.pauseOnHover === 0 ? 0 : 1;
  const targetPage = adData.targetPage || 'ALL';
  const deviceTarget = adData.deviceTarget || 'ALL';

  let devices = ['MOBILE', 'TV', 'SIGNAGE'];
  if (adData.devices) {
    if (typeof adData.devices === 'string') {
      try { devices = JSON.parse(adData.devices); }
      catch (e) { devices = adData.devices.split(',').map(s => s.trim().toUpperCase()); }
    } else if (Array.isArray(adData.devices)) {
      devices = adData.devices;
    }
  } else if (adData.deviceTarget && adData.deviceTarget !== 'ALL') {
    devices = [adData.deviceTarget];
  }
  const devicesJson = JSON.stringify(devices);

  let venueIds = [];
  if (adData.venueIds) {
    if (typeof adData.venueIds === 'string') {
      try {
        venueIds = JSON.parse(adData.venueIds);
      } catch (e) {
        venueIds = adData.venueIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    } else if (Array.isArray(adData.venueIds)) {
      venueIds = adData.venueIds;
    }
  }
  const venueIdsJson = JSON.stringify(Array.isArray(venueIds) ? venueIds.map(Number).filter(n => !isNaN(n)) : []);

  let tournamentIds = [];
  if (adData.tournamentIds) {
    if (typeof adData.tournamentIds === 'string') {
      try {
        tournamentIds = JSON.parse(adData.tournamentIds);
      } catch (e) {
        tournamentIds = adData.tournamentIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    } else if (Array.isArray(adData.tournamentIds)) {
      tournamentIds = adData.tournamentIds;
    }
  } else if (adData.tournamentId) {
    tournamentIds = [parseInt(adData.tournamentId, 10)];
  }
  const tournamentIdsJson = JSON.stringify(Array.isArray(tournamentIds) ? tournamentIds.map(Number).filter(n => !isNaN(n)) : []);
  const tournamentId = tournamentIds.length > 0 ? tournamentIds[0] : (adData.tournamentId ? parseInt(adData.tournamentId, 10) : null);

  const status = adData.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  const sortOrder = parseInt(adData.sortOrder ?? adData.sort_order ?? 0, 10);
  const startDate = adData.startDate || null;
  const endDate = adData.endDate || null;

  const result = await db.query(
    `INSERT INTO advertisements 
     (title, name, description, link_url, image_url, width, height, size_preset, image_fit, position, display_mode, motion_type, movement_direction, speed, scroll_speed, slide_interval, pause_on_hover, venue_ids, tournament_ids, target_page, device_target, devices, status, sort_order, priority, start_date, end_date, tournament_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, title, description, linkUrl, imageUrl, width, height, sizePreset, imageFit, position, displayMode, motionType, movementDirection, speed, speed, slideInterval, pauseOnHover, venueIdsJson, tournamentIdsJson, targetPage, deviceTarget, devicesJson, status, sortOrder, sortOrder, startDate, endDate, tournamentId, userId]
  );

  const insertedId = result.insertId;
  const [createdRow] = await db.query('SELECT * FROM advertisements WHERE id = ?', [insertedId]);
  const formatted = formatAd(createdRow);

  // Broadcast real-time update
  broadcastSignageEvent('signage:adAdded', { ad: formatted });
  broadcastSignageEvent('signage:adUpdated', { ad: formatted });

  return formatted;
};

/**
 * Update an existing advertisement
 */
const updateAd = async (id, adData) => {
  const [existing] = await db.query('SELECT * FROM advertisements WHERE id = ?', [id]);
  if (!existing) {
    throw new Error('Advertisement not found');
  }

  const title = adData.title !== undefined ? adData.title : (existing.title || existing.name);
  const description = adData.description !== undefined ? adData.description : existing.description;
  const linkUrl = (adData.linkUrl !== undefined || adData.link_url !== undefined)
    ? (adData.linkUrl !== undefined ? adData.linkUrl : adData.link_url)
    : existing.link_url;
  const imageUrl = adData.imageUrl || adData.image_url || existing.image_url;
  const validPositions = [
    'TOP', 'BOTTOM', 'LEFT', 'RIGHT', 'BOTH_SIDEBARS',
    'COURT', 'COURT_MIDDLE', 'MOBILE_TOP', 'MOBILE_BOTTOM',
    'STREAM_TOP', 'STREAM_BOTTOM', 'STREAM_LEFT', 'STREAM_RIGHT', 'STREAM_BREAK'
  ];
  const posUpper = (adData.position || '').toUpperCase();
  const position = posUpper && validPositions.includes(posUpper) ? posUpper : (existing.position || 'TOP');
  const width = adData.width !== undefined ? adData.width : (
    existing.width || (
      position === 'COURT_MIDDLE' ? '80px' :
      (position === 'STREAM_LEFT' || position === 'STREAM_RIGHT') ? '140px' : '100%'
    )
  );
  const height = adData.height !== undefined ? adData.height : (
    existing.height || (
      position === 'COURT_MIDDLE' ? '240px' :
      position === 'STREAM_TOP' ? '48px' :
      position === 'STREAM_BOTTOM' ? '52px' :
      (position === 'STREAM_LEFT' || position === 'STREAM_RIGHT' || position === 'STREAM_BREAK') ? '100%' :
      'auto'
    )
  );
  const sizePreset = adData.sizePreset || adData.size_preset || existing.size_preset || 'RESPONSIVE';
  const imageFit = adData.imageFit || adData.image_fit || existing.image_fit || (position === 'COURT_MIDDLE' ? 'cover' : 'contain');
  const motionType = adData.motionType || adData.motion_type || existing.motion_type || 'STATIC';
  const movementDirection = adData.movementDirection || adData.movement_direction || existing.movement_direction || 'RIGHT_TO_LEFT';
  const displayMode = motionType === 'STATIC' ? 'STATIC' : 'MOTION';
  const speed = adData.speed !== undefined ? parseInt(adData.speed, 10) : (existing.speed || existing.scroll_speed || 25);
  const slideInterval = adData.slideInterval !== undefined ? parseInt(adData.slideInterval, 10) : (existing.slide_interval || 6);
  const pauseOnHover = adData.pauseOnHover !== undefined ? (adData.pauseOnHover ? 1 : 0) : (existing.pause_on_hover ?? 1);
  const targetPage = adData.targetPage !== undefined ? adData.targetPage : (existing.target_page || 'ALL');
  const deviceTarget = adData.deviceTarget !== undefined ? adData.deviceTarget : (existing.device_target || 'ALL');

  let devicesJson = existing.devices;
  if (adData.devices !== undefined) {
    let devices = ['MOBILE', 'TV', 'SIGNAGE'];
    if (typeof adData.devices === 'string') {
      try { devices = JSON.parse(adData.devices); }
      catch (e) { devices = adData.devices.split(',').map(s => s.trim().toUpperCase()); }
    } else if (Array.isArray(adData.devices)) {
      devices = adData.devices;
    }
    devicesJson = JSON.stringify(devices);
  }

  let venueIdsJson = existing.venue_ids;
  if (adData.venueIds !== undefined) {
    let venueIds = [];
    if (typeof adData.venueIds === 'string') {
      try {
        venueIds = JSON.parse(adData.venueIds);
      } catch (e) {
        venueIds = adData.venueIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    } else if (Array.isArray(adData.venueIds)) {
      venueIds = adData.venueIds;
    }
    venueIdsJson = JSON.stringify(Array.isArray(venueIds) ? venueIds.map(Number).filter(n => !isNaN(n)) : []);
  }

  let tournamentIdsJson = existing.tournament_ids;
  let tournamentId = existing.tournament_id;
  if (adData.tournamentIds !== undefined) {
    let tournamentIds = [];
    if (typeof adData.tournamentIds === 'string') {
      try {
        tournamentIds = JSON.parse(adData.tournamentIds);
      } catch (e) {
        tournamentIds = adData.tournamentIds.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
      }
    } else if (Array.isArray(adData.tournamentIds)) {
      tournamentIds = adData.tournamentIds;
    }
    tournamentIdsJson = JSON.stringify(Array.isArray(tournamentIds) ? tournamentIds.map(Number).filter(n => !isNaN(n)) : []);
    tournamentId = tournamentIds.length > 0 ? tournamentIds[0] : null;
  } else if (adData.tournamentId !== undefined) {
    tournamentId = adData.tournamentId ? parseInt(adData.tournamentId, 10) : null;
    tournamentIdsJson = tournamentId ? JSON.stringify([tournamentId]) : JSON.stringify([]);
  }

  const status = adData.status || existing.status;
  const sortOrder = adData.sortOrder !== undefined ? parseInt(adData.sortOrder, 10) : (existing.sort_order || 0);
  const startDate = adData.startDate !== undefined ? adData.startDate : existing.start_date;
  const endDate = adData.endDate !== undefined ? adData.endDate : existing.end_date;

  await db.query(
    `UPDATE advertisements
     SET title = ?, name = ?, description = ?, link_url = ?, image_url = ?, width = ?, height = ?, size_preset = ?, image_fit = ?,
         position = ?, display_mode = ?, motion_type = ?, movement_direction = ?, speed = ?, scroll_speed = ?,
         slide_interval = ?, pause_on_hover = ?, venue_ids = ?, tournament_ids = ?, target_page = ?, device_target = ?, devices = ?, status = ?,
         sort_order = ?, priority = ?, start_date = ?, end_date = ?, tournament_id = ?
     WHERE id = ?`,
    [title, title, description, linkUrl, imageUrl, width, height, sizePreset, imageFit, position, displayMode, motionType, movementDirection, speed, speed, slideInterval, pauseOnHover, venueIdsJson, tournamentIdsJson, targetPage, deviceTarget, devicesJson, status, sortOrder, sortOrder, startDate, endDate, tournamentId, id]
  );

  const [updatedRow] = await db.query('SELECT * FROM advertisements WHERE id = ?', [id]);
  const formatted = formatAd(updatedRow);

  // Broadcast real-time update
  broadcastSignageEvent('signage:adUpdated', { ad: formatted });

  return formatted;
};

/**
 * Delete advertisement
 */
const deleteAd = async (id) => {
  const [existing] = await db.query('SELECT * FROM advertisements WHERE id = ?', [id]);
  if (!existing) {
    throw new Error('Advertisement not found');
  }

  await db.query('DELETE FROM advertisements WHERE id = ?', [id]);

  broadcastSignageEvent('signage:adRemoved', { id: parseInt(id, 10) });

  return { success: true, id };
};

/**
 * Dedicated public read endpoint for active live stream viewer ads
 */
const getStreamAds = async ({ matchId, tournamentId, venueId } = {}) => {
  let resolvedTournId = tournamentId;
  let resolvedVenueId = venueId;

  if (matchId && (!resolvedTournId || !resolvedVenueId)) {
    try {
      const rows = await db.query(
        `SELECT tournament_id, venue_id FROM tournament_matches WHERE uuid = ? OR id = ? LIMIT 1`,
        [String(matchId), isNaN(matchId) ? 0 : parseInt(matchId, 10)]
      );
      if (rows.length > 0) {
        if (!resolvedTournId) resolvedTournId = rows[0].tournament_id;
        if (!resolvedVenueId) resolvedVenueId = rows[0].venue_id;
      }
    } catch (e) {}
  }

  const ads = await getActiveAds({
    tournamentId: resolvedTournId,
    venueId: resolvedVenueId,
    device: 'STREAM'
  });

  return {
    streamTopAds: ads.streamTopAds || [],
    streamBottomAds: ads.streamBottomAds || [],
    streamLeftAds: ads.streamLeftAds || [],
    streamRightAds: ads.streamRightAds || [],
    streamBreakAds: ads.streamBreakAds || [],
    streamZoneSettings: ads.streamZoneSettings || { ...DEFAULT_STREAM_ZONE_SETTINGS },
    state: ads.state || {}
  };
};

module.exports = {
  getPlaybackState,
  controlPlayback,
  getActiveAds,
  getActiveAdsForSignage: getActiveAds,
  getStreamAds,
  getAllAds,
  createAd,
  updateAd,
  deleteAd,
  DEFAULT_STREAM_ZONE_SETTINGS
};
