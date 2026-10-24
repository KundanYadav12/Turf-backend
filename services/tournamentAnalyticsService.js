const crypto = require('crypto');
const db = require('../config/database');

const SALT = process.env.ANALYTICS_SALT || 'turf_analytics_secure_salt_2026';
const DEDUPLICATION_COOLDOWN_MINUTES = 15;

/**
 * Creates a privacy-conscious SHA-256 hash
 */
function hashString(str) {
  if (!str) return null;
  return crypto.createHash('sha256').update(str + SALT).digest('hex').slice(0, 32);
}

/**
 * Formats a Date object to YYYY-MM-DD
 */
function formatDateToYMD(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Look up tournament by integer ID or UUID
 */
async function findTournament(identifier) {
  const isNumeric = /^\d+$/.test(String(identifier).trim());
  const rows = await db.query(
    `SELECT t.id, t.uuid, t.name, t.sport_id, t.status, t.created_by, t.created_at, 
            t.total_views, t.unique_viewers, t.last_viewed_at,
            s.name as sport_name, s.slug as sport_slug, s.icon as sport_icon,
            u.full_name as organizer_name, u.email as organizer_email
     FROM tournaments t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN users u ON t.created_by = u.id
     WHERE t.uuid = ? OR t.id = ? LIMIT 1`,
    [identifier, isNumeric ? parseInt(identifier, 10) : -1]
  );
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Records a tournament view with 15-minute deduplication window
 */
async function recordTournamentView({
  tournamentIdentifier,
  user = null,
  viewerId = null,
  platform = 'WEB',
  ip = null,
  userAgent = null
}) {
  const tournament = await findTournament(tournamentIdentifier);
  if (!tournament) {
    const err = new Error('Tournament not found');
    err.status = 404;
    throw err;
  }

  const normalizedPlatform = (platform || '').toUpperCase() === 'MOBILE' ? 'MOBILE' : 'WEB';
  const authenticatedUserId = user?.id ? parseInt(user.id, 10) : null;

  // Determine viewer identifier
  let viewerIdentifier = null;
  if (authenticatedUserId) {
    viewerIdentifier = `u_${authenticatedUserId}`;
  } else if (viewerId && String(viewerId).trim().length > 0) {
    const cleanId = String(viewerId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50);
    viewerIdentifier = `anon_${cleanId}`;
  } else {
    // Fallback to IP + User-Agent hash
    const ipUaHash = hashString(`${ip || ''}_${userAgent || ''}`);
    viewerIdentifier = `hash_${ipUaHash}`;
  }

  const ipHash = hashString(ip);
  const truncatedUa = userAgent ? String(userAgent).slice(0, 250) : null;

  // Check 15-minute cooldown deduplication for this tournament & viewer
  const cooldownRows = await db.query(
    `SELECT id, viewed_at 
     FROM tournament_view_events 
     WHERE tournament_id = ? AND viewer_identifier = ? 
       AND viewed_at >= NOW() - INTERVAL ? MINUTE 
     ORDER BY viewed_at DESC LIMIT 1`,
    [tournament.id, viewerIdentifier, DEDUPLICATION_COOLDOWN_MINUTES]
  );

  if (cooldownRows && cooldownRows.length > 0) {
    const lastViewedAt = new Date(cooldownRows[0].viewed_at);
    const diffSeconds = Math.floor((Date.now() - lastViewedAt.getTime()) / 1000);
    const remainingCooldown = Math.max(0, (DEDUPLICATION_COOLDOWN_MINUTES * 60) - diffSeconds);

    return {
      recorded: false,
      deduplicated: true,
      cooldownRemainingSeconds: remainingCooldown,
      totalViews: tournament.total_views || 0,
      uniqueViewers: tournament.unique_viewers || 0,
      lastViewedAt: tournament.last_viewed_at
    };
  }

  // Check if viewer has ever viewed this tournament before
  const priorRows = await db.query(
    `SELECT id FROM tournament_view_events 
     WHERE tournament_id = ? AND viewer_identifier = ? LIMIT 1`,
    [tournament.id, viewerIdentifier]
  );
  const isNewUniqueViewer = (!priorRows || priorRows.length === 0);

  // Insert view event record
  await db.query(
    `INSERT INTO tournament_view_events 
       (tournament_id, tournament_uuid, user_id, viewer_identifier, platform, ip_hash, user_agent, viewed_at, view_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), CURDATE())`,
    [
      tournament.id,
      tournament.uuid,
      authenticatedUserId,
      viewerIdentifier,
      normalizedPlatform,
      ipHash,
      truncatedUa
    ]
  );

  // Increment counters on tournaments table atomically
  const uniqueIncrement = isNewUniqueViewer ? 1 : 0;
  await db.query(
    `UPDATE tournaments 
     SET total_views = total_views + 1,
         unique_viewers = unique_viewers + ?,
         last_viewed_at = NOW()
     WHERE id = ?`,
    [uniqueIncrement, tournament.id]
  );

  const updatedTotalViews = (tournament.total_views || 0) + 1;
  const updatedUniqueViewers = (tournament.unique_viewers || 0) + uniqueIncrement;

  return {
    recorded: true,
    deduplicated: false,
    isNewUniqueViewer,
    totalViews: updatedTotalViews,
    uniqueViewers: updatedUniqueViewers,
    lastViewedAt: new Date()
  };
}

/**
 * Returns public aggregate metrics for a single tournament (no personal data)
 */
async function getTournamentPublicSummary(tournamentIdentifier) {
  const tournament = await findTournament(tournamentIdentifier);
  if (!tournament) {
    const err = new Error('Tournament not found');
    err.status = 404;
    throw err;
  }

  const [aggRow] = await db.query(
    `SELECT 
       COUNT(*) as total_events,
       COUNT(DISTINCT viewer_identifier) as distinct_viewers,
       SUM(CASE WHEN view_date = CURDATE() THEN 1 ELSE 0 END) as views_today,
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as views_7d,
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as views_30d,
       MAX(viewed_at) as latest_view_timestamp
     FROM tournament_view_events
     WHERE tournament_id = ?`,
    [tournament.id]
  );

  const totalViews = Math.max(tournament.total_views || 0, parseInt(aggRow?.total_events, 10) || 0);
  const uniqueViewers = Math.max(tournament.unique_viewers || 0, parseInt(aggRow?.distinct_viewers, 10) || 0);

  return {
    tournamentId: tournament.id,
    tournamentUuid: tournament.uuid,
    tournamentName: tournament.name,
    totalViews,
    uniqueViewers,
    viewsToday: parseInt(aggRow?.views_today, 10) || 0,
    views7Days: parseInt(aggRow?.views_7d, 10) || 0,
    views30Days: parseInt(aggRow?.views_30d, 10) || 0,
    lastViewedAt: aggRow?.latest_view_timestamp || tournament.last_viewed_at || null
  };
}

/**
 * Superadmin Overview: Summary KPI Cards + Ranked Tournament Table + Multi-Filtering
 */
async function getSuperadminAnalyticsOverview({
  search = '',
  sportId = null,
  sportSlug = null,
  status = null,
  dateRange = 'ALL',
  startDate = null,
  endDate = null,
  platform = 'ALL',
  organizer = '',
  sortBy = 'views_desc',
  page = 1,
  limit = 10
}) {
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  const offset = (safePage - 1) * safeLimit;

  // Build filter conditions for tournament view events
  const eventWhere = [];
  const eventParams = [];

  const platformNorm = (platform || '').toUpperCase();
  if (platformNorm === 'WEB' || platformNorm === 'MOBILE') {
    eventWhere.push('tve.platform = ?');
    eventParams.push(platformNorm);
  }

  if (dateRange === 'TODAY') {
    eventWhere.push('tve.view_date = CURDATE()');
  } else if (dateRange === 'LAST_7_DAYS') {
    eventWhere.push('tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)');
  } else if (dateRange === 'LAST_30_DAYS') {
    eventWhere.push('tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)');
  } else if (dateRange === 'CUSTOM' && startDate && endDate) {
    eventWhere.push('tve.view_date BETWEEN ? AND ?');
    eventParams.push(startDate, endDate);
  }

  // 1. Calculate Platform-Wide KPI Summaries
  const kpiFilterSql = eventWhere.length > 0 ? `WHERE ${eventWhere.join(' AND ')}` : '';
  const [globalKpis] = await db.query(
    `SELECT 
       COUNT(*) as total_views,
       COUNT(DISTINCT tve.viewer_identifier) as total_unique_viewers,
       COUNT(DISTINCT tve.tournament_id) as total_tournaments_tracked,
       SUM(CASE WHEN tve.view_date = CURDATE() THEN 1 ELSE 0 END) as views_today,
       SUM(CASE WHEN tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as views_7d,
       SUM(CASE WHEN tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as views_30d,
       SUM(CASE WHEN tve.platform = 'WEB' THEN 1 ELSE 0 END) as web_views,
       SUM(CASE WHEN tve.platform = 'MOBILE' THEN 1 ELSE 0 END) as mobile_views
     FROM tournament_view_events tve
     ${kpiFilterSql}`,
    eventParams
  );

  // 2. Build Tournament Ranking Query
  const tourneyWhere = [];
  const tourneyParams = [];

  if (search && search.trim().length > 0) {
    const trimmed = search.trim();
    const isNum = /^\d+$/.test(trimmed);
    if (isNum) {
      tourneyWhere.push('(t.name LIKE ? OR t.uuid LIKE ? OR u.full_name LIKE ? OR v.city LIKE ? OR t.id = ?)');
      const term = `%${trimmed}%`;
      tourneyParams.push(term, term, term, term, parseInt(trimmed, 10));
    } else {
      tourneyWhere.push('(t.name LIKE ? OR t.uuid LIKE ? OR u.full_name LIKE ? OR v.city LIKE ?)');
      const term = `%${trimmed}%`;
      tourneyParams.push(term, term, term, term);
    }
  }

  if (sportId) {
    tourneyWhere.push('t.sport_id = ?');
    tourneyParams.push(parseInt(sportId, 10));
  } else if (sportSlug) {
    tourneyWhere.push('s.slug = ?');
    tourneyParams.push(sportSlug);
  }

  if (status && status !== 'ALL') {
    tourneyWhere.push('t.status = ?');
    tourneyParams.push(status);
  }

  if (organizer && organizer.trim().length > 0) {
    tourneyWhere.push('(u.full_name LIKE ? OR u.email LIKE ?)');
    tourneyParams.push(`%${organizer.trim()}%`, `%${organizer.trim()}%`);
  }

  const tourneyWhereClause = tourneyWhere.length > 0 ? `WHERE ${tourneyWhere.join(' AND ')}` : '';

  // Count total tournaments matching filters for pagination
  const [countResult] = await db.query(
    `SELECT COUNT(*) as total_count 
     FROM tournaments t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN users u ON t.created_by = u.id
     LEFT JOIN venues v ON t.venue_id = v.id
     ${tourneyWhereClause}`,
    tourneyParams
  );
  const totalTournaments = parseInt(countResult?.total_count, 10) || 0;

  // Dynamic primary view column based on active date range or platform
  let primaryViewCol = 'total_views';
  if (dateRange === 'TODAY') {
    primaryViewCol = 'views_today';
  } else if (dateRange === 'LAST_7_DAYS') {
    primaryViewCol = 'views_7d';
  } else if (dateRange === 'LAST_30_DAYS') {
    primaryViewCol = 'views_30d';
  } else if (platformNorm === 'MOBILE') {
    primaryViewCol = 'mobile_views';
  } else if (platformNorm === 'WEB') {
    primaryViewCol = 'web_views';
  }

  // Sorting
  let orderByClause = `ORDER BY ${primaryViewCol} DESC, total_views DESC, t.id DESC`;
  switch (sortBy) {
    case 'views_asc':
      orderByClause = `ORDER BY ${primaryViewCol} ASC, total_views ASC, t.id ASC`;
      break;
    case 'unique_desc':
      orderByClause = 'ORDER BY unique_viewers DESC, total_views DESC, t.id DESC';
      break;
    case 'unique_asc':
      orderByClause = 'ORDER BY unique_viewers ASC, total_views ASC, t.id ASC';
      break;
    case 'recent_desc':
      orderByClause = 'ORDER BY last_viewed_at DESC, total_views DESC';
      break;
    case 'created_desc':
      orderByClause = 'ORDER BY t.created_at DESC';
      break;
    default:
      orderByClause = `ORDER BY ${primaryViewCol} DESC, total_views DESC, t.id DESC`;
  }

  // Query tournaments with dynamic aggregated view metrics
  const tournamentSql = `
    SELECT 
      t.id,
      t.uuid,
      t.name,
      t.status,
      t.format,
      t.created_at,
      t.last_viewed_at,
      COALESCE(t.total_views, 0) as total_views,
      COALESCE(t.unique_viewers, 0) as unique_viewers,
      s.id as sport_id,
      s.name as sport_name,
      s.slug as sport_slug,
      s.icon as sport_icon,
      u.id as organizer_id,
      COALESCE(u.full_name, 'Admin') as organizer_name,
      u.email as organizer_email,
      COALESCE(v.city, 'Mumbai') as city,
      (SELECT COUNT(*) FROM tournament_view_events tve WHERE tve.tournament_id = t.id AND tve.view_date = CURDATE()) as views_today,
      (SELECT COUNT(*) FROM tournament_view_events tve WHERE tve.tournament_id = t.id AND tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)) as views_7d,
      (SELECT COUNT(*) FROM tournament_view_events tve WHERE tve.tournament_id = t.id AND tve.view_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) as views_30d,
      (SELECT COUNT(*) FROM tournament_view_events tve WHERE tve.tournament_id = t.id AND tve.platform = 'WEB') as web_views,
      (SELECT COUNT(*) FROM tournament_view_events tve WHERE tve.tournament_id = t.id AND tve.platform = 'MOBILE') as mobile_views
    FROM tournaments t
    LEFT JOIN sports s ON t.sport_id = s.id
    LEFT JOIN users u ON t.created_by = u.id
    LEFT JOIN venues v ON t.venue_id = v.id
    ${tourneyWhereClause}
    ${orderByClause}
    LIMIT ? OFFSET ?
  `;

  const queryParams = [...tourneyParams, safeLimit, offset];
  const rows = await db.query(tournamentSql, queryParams);

  // Attach accurate ranking number
  const rankedTournaments = rows.map((row, idx) => {
    const rank = offset + idx + 1;
    const views = parseInt(row[primaryViewCol], 10) || 0;
    return {
      rank,
      isHighestViewed: (rank === 1 && views > 0 && safePage === 1),
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      status: row.status,
      format: row.format,
      city: row.city,
      createdAt: row.created_at,
      lastViewedAt: row.last_viewed_at,
      totalViews: parseInt(row.total_views, 10) || 0,
      uniqueViewers: parseInt(row.unique_viewers, 10) || 0,
      viewsToday: parseInt(row.views_today, 10) || 0,
      views7Days: parseInt(row.views_7d, 10) || 0,
      views30Days: parseInt(row.views_30d, 10) || 0,
      webViews: parseInt(row.web_views, 10) || 0,
      mobileViews: parseInt(row.mobile_views, 10) || 0,
      sport: {
        id: row.sport_id,
        name: row.sport_name || 'Sports',
        slug: row.sport_slug || 'sports',
        icon: row.sport_icon || 'trophy'
      },
      organizer: {
        id: row.organizer_id,
        name: row.organizer_name,
        email: row.organizer_email
      }
    };
  });

  return {
    summary: {
      totalViews: parseInt(globalKpis?.total_views, 10) || 0,
      totalUniqueViewers: parseInt(globalKpis?.total_unique_viewers, 10) || 0,
      totalTournamentsTracked: parseInt(globalKpis?.total_tournaments_tracked, 10) || 0,
      viewsToday: parseInt(globalKpis?.views_today, 10) || 0,
      views7Days: parseInt(globalKpis?.views_7d, 10) || 0,
      views30Days: parseInt(globalKpis?.views_30d, 10) || 0,
      platformBreakdown: {
        web: parseInt(globalKpis?.web_views, 10) || 0,
        mobile: parseInt(globalKpis?.mobile_views, 10) || 0
      }
    },
    tournaments: rankedTournaments,
    pagination: {
      page: safePage,
      limit: safeLimit,
      totalCount: totalTournaments,
      totalPages: Math.ceil(totalTournaments / safeLimit) || 1
    }
  };
}

/**
 * Superadmin Detail: Drilldown into single tournament analytics
 * (Daily Time-Series Chart, Platform Split, Period-over-Period Trend, Recent Events Stream)
 */
async function getSuperadminTournamentDetail(tournamentIdentifier, {
  periodDays = 30
} = {}) {
  const tournament = await findTournament(tournamentIdentifier);
  if (!tournament) {
    const err = new Error('Tournament not found');
    err.status = 404;
    throw err;
  }

  const days = Math.min(Math.max(parseInt(periodDays, 10) || 30, 7), 90);

  // 1. Fetch aggregate metrics
  const [metricRow] = await db.query(
    `SELECT 
       COUNT(*) as total_events,
       COUNT(DISTINCT viewer_identifier) as total_unique,
       SUM(CASE WHEN view_date = CURDATE() THEN 1 ELSE 0 END) as views_today,
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as views_7d,
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) as views_30d,
       SUM(CASE WHEN platform = 'WEB' THEN 1 ELSE 0 END) as web_views,
       SUM(CASE WHEN platform = 'MOBILE' THEN 1 ELSE 0 END) as mobile_views,
       MAX(viewed_at) as latest_view
     FROM tournament_view_events
     WHERE tournament_id = ?`,
    [tournament.id]
  );

  const totalViews = Math.max(tournament.total_views || 0, parseInt(metricRow?.total_events, 10) || 0);
  const uniqueViewers = Math.max(tournament.unique_viewers || 0, parseInt(metricRow?.total_unique, 10) || 0);
  const webViews = parseInt(metricRow?.web_views, 10) || 0;
  const mobileViews = parseInt(metricRow?.mobile_views, 10) || 0;

  // 2. Period-over-Period Comparison: Current period vs Previous period of same duration
  // E.g., if days = 30: current is [CURDATE() - 30 to CURDATE()], previous is [CURDATE() - 60 to CURDATE() - 30]
  const [periodComp] = await db.query(
    `SELECT 
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) THEN 1 ELSE 0 END) as current_period_views,
       SUM(CASE WHEN view_date >= DATE_SUB(CURDATE(), INTERVAL ? * 2 DAY) 
                 AND view_date < DATE_SUB(CURDATE(), INTERVAL ? DAY) THEN 1 ELSE 0 END) as previous_period_views
     FROM tournament_view_events
     WHERE tournament_id = ?`,
    [days, days, days, tournament.id]
  );

  const currentPeriodViews = parseInt(periodComp?.current_period_views, 10) || 0;
  const previousPeriodViews = parseInt(periodComp?.previous_period_views, 10) || 0;

  let percentageChange = 0;
  if (previousPeriodViews > 0) {
    percentageChange = Math.round(((currentPeriodViews - previousPeriodViews) / previousPeriodViews) * 100);
  } else if (currentPeriodViews > 0) {
    percentageChange = 100;
  }

  // 3. Daily Time-Series Data for Chart (Continuous date array with zero-fills)
  const dailyDbRows = await db.query(
    `SELECT 
       DATE_FORMAT(view_date, '%Y-%m-%d') as date_str,
       COUNT(*) as views,
       COUNT(DISTINCT viewer_identifier) as unique_viewers,
       SUM(CASE WHEN platform = 'WEB' THEN 1 ELSE 0 END) as web_views,
       SUM(CASE WHEN platform = 'MOBILE' THEN 1 ELSE 0 END) as mobile_views
     FROM tournament_view_events
     WHERE tournament_id = ? 
       AND view_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY view_date
     ORDER BY view_date ASC`,
    [tournament.id, days]
  );

  const dailyMap = new Map();
  dailyDbRows.forEach((r) => {
    dailyMap.set(r.date_str, {
      views: parseInt(r.views, 10) || 0,
      uniqueViewers: parseInt(r.unique_viewers, 10) || 0,
      webViews: parseInt(r.web_views, 10) || 0,
      mobileViews: parseInt(r.mobile_views, 10) || 0
    });
  });

  // Construct continuous date series
  const timeSeries = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(now.getDate() - i);
    const dateStr = formatDateToYMD(d);
    const existing = dailyMap.get(dateStr) || { views: 0, uniqueViewers: 0, webViews: 0, mobileViews: 0 };
    timeSeries.push({
      date: dateStr,
      displayDate: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      views: existing.views,
      uniqueViewers: existing.uniqueViewers,
      webViews: existing.webViews,
      mobileViews: existing.mobileViews
    });
  }

  // 4. Recent View Events Stream (Latest 25 events, privacy sanitized)
  const recentEvents = await db.query(
    `SELECT 
       tve.id,
       tve.platform,
       tve.viewed_at,
       (tve.user_id IS NOT NULL) as is_authenticated,
       tve.viewer_identifier
     FROM tournament_view_events tve
     WHERE tve.tournament_id = ?
     ORDER BY tve.viewed_at DESC
     LIMIT 25`,
    [tournament.id]
  );

  const sanitizedRecentEvents = recentEvents.map((ev) => ({
    id: ev.id,
    platform: ev.platform,
    viewedAt: ev.viewed_at,
    viewerType: ev.is_authenticated ? 'AUTHENTICATED' : 'ANONYMOUS',
    viewerTag: ev.is_authenticated ? 'Registered User' : 'Guest Visitor'
  }));

  return {
    tournament: {
      id: tournament.id,
      uuid: tournament.uuid,
      name: tournament.name,
      status: tournament.status,
      sport: {
        name: tournament.sport_name || 'Sports',
        slug: tournament.sport_slug || 'sports',
        icon: tournament.sport_icon || 'trophy'
      },
      organizer: {
        id: tournament.created_by,
        name: tournament.organizer_name || 'Organizer',
        email: tournament.organizer_email
      },
      createdAt: tournament.created_at,
      lastViewedAt: metricRow?.latest_view || tournament.last_viewed_at || null
    },
    metrics: {
      totalViews,
      uniqueViewers,
      viewsToday: parseInt(metricRow?.views_today, 10) || 0,
      views7Days: parseInt(metricRow?.views_7d, 10) || 0,
      views30Days: parseInt(metricRow?.views_30d, 10) || 0,
      platformBreakdown: {
        web: webViews,
        mobile: mobileViews,
        webPercentage: totalViews > 0 ? Math.round((webViews / totalViews) * 100) : 0,
        mobilePercentage: totalViews > 0 ? Math.round((mobileViews / totalViews) * 100) : 0
      },
      comparison: {
        periodDays: days,
        currentPeriodViews,
        previousPeriodViews,
        percentageChange,
        isPositive: percentageChange >= 0
      }
    },
    timeSeries,
    recentEvents: sanitizedRecentEvents
  };
}

module.exports = {
  recordTournamentView,
  getTournamentPublicSummary,
  getSuperadminAnalyticsOverview,
  getSuperadminTournamentDetail
};
