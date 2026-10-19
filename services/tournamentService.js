const db = require('../config/database');
const sportRolesConfig = require('../config/sportRoles');

/**
 * Returns lightweight tournament summary cards with cursor-based pagination.
 * Zero heavy payloads (no players, balls, or nested stats).
 */
const getTournamentsPaginated = async ({
  city,
  sportSlug,
  status,
  search,
  cursor,
  limit = 20
}) => {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);
  const conditions = [];
  const params = [];

  if (city) {
    conditions.push('v.city = ?');
    params.push(city);
  }

  if (sportSlug) {
    conditions.push('s.slug = ?');
    params.push(sportSlug);
  }

  if (status) {
    conditions.push('t.status = ?');
    params.push(status);
  }

  if (search) {
    conditions.push('(t.name LIKE ? OR v.city LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }

  if (cursor) {
    try {
      const decoded = Buffer.from(cursor, 'base64').toString('ascii');
      const [cDate, cId] = JSON.parse(decoded);
      conditions.push('(t.start_date < ? OR (t.start_date = ? AND t.id < ?))');
      params.push(cDate, cDate, cId);
    } catch {
      // Ignore malformed cursor
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT 
      t.id as _internal_id,
      t.uuid as public_id,
      t.name,
      t.format,
      t.banner_url,
      t.max_teams,
      t.start_date,
      t.end_date,
      t.status,
      COALESCE(v.city, 'Mumbai') as city,
      s.name as sport_name,
      s.slug as sport_slug,
      s.icon as sport_icon,
      (SELECT COUNT(*) FROM tournament_matches tm WHERE tm.tournament_id = t.id AND tm.status = 'LIVE') as live_match_count,
      (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id AND tt.registration_status = 'APPROVED') as registered_teams_count
    FROM tournaments t
    JOIN sports s ON t.sport_id = s.id
    LEFT JOIN venues v ON t.venue_id = v.id
    ${whereClause}
    ORDER BY t.start_date DESC, t.id DESC
    LIMIT ?
  `;

  params.push(safeLimit + 1);
  const rows = await db.query(sql, params);

  const hasMore = rows.length > safeLimit;
  const items = hasMore ? rows.slice(0, safeLimit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify([lastItem.start_date, lastItem._internal_id])
    ).toString('base64');
  }

  // Format response: Strip internal _internal_id completely
  const cleanItems = items.map(item => {
    const regCount = parseInt(item.registered_teams_count, 10) || 0;
    return {
      id: item.public_id,
      name: item.name,
      format: item.format,
      city: item.city,
      bannerUrl: item.banner_url,
      totalTeams: item.max_teams,
      maxTeams: item.max_teams,
      registeredTeams: regCount,
      registeredTeamsCount: regCount,
      teamsCount: regCount,
      startDate: item.start_date,
      endDate: item.end_date,
      status: item.status,
      liveMatchCount: parseInt(item.live_match_count, 10) || 0,
      sport: {
        name: item.sport_name,
        slug: item.sport_slug,
        icon: item.sport_icon
      }
    };
  });

  return {
    items: cleanItems,
    pagination: {
      hasMore,
      nextCursor
    }
  };
};

/**
 * Returns single tournament overview details.
 */
const getTournamentByPublicId = async (publicId) => {
  const rows = await db.query(
    `SELECT 
      t.id, t.uuid as public_id, t.name, t.description, t.format,
      t.banner_url, t.max_teams,
      t.start_date, t.end_date, t.status, t.rules, t.has_auction,
      t.match_format, t.target_score, t.win_by_two, t.max_score, t.roster_size, t.groups_count,
      COALESCE(v.city, 'Mumbai') as city,
      s.name as sport_name, s.slug as sport_slug,
      v.name as venue_name, v.address as venue_address,
      (SELECT COUNT(*) FROM tournament_teams tt WHERE tt.tournament_id = t.id AND tt.registration_status = 'APPROVED') as registered_teams_count,
      (SELECT uuid FROM tournament_auctions ta WHERE ta.tournament_id = t.id LIMIT 1) as auction_id,
      (SELECT status FROM tournament_auctions ta WHERE ta.tournament_id = t.id LIMIT 1) as auction_status
     FROM tournaments t
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [publicId, /^\d+$/.test(String(publicId).trim()) ? parseInt(publicId, 10) : -1]
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const t = rows[0];

  return {
    id: t.public_id,
    name: t.name,
    description: t.description,
    format: t.format,
    city: t.city,
    bannerUrl: t.banner_url,
    dates: {
      start: t.start_date,
      end: t.end_date
    },
    maxTeams: t.max_teams,
    totalTeams: t.max_teams,
    registeredTeams: parseInt(t.registered_teams_count, 10) || 0,
    registeredTeamsCount: parseInt(t.registered_teams_count, 10) || 0,
    teamsCount: parseInt(t.registered_teams_count, 10) || 0,
    status: t.status,
    rules: t.rules,
    hasAuction: Boolean(t.has_auction || t.auction_id),
    auctionId: t.auction_id || null,
    auctionStatus: t.auction_status || null,
    matchFormat: t.match_format || 'DOUBLES',
    targetScore: t.target_score != null ? t.target_score : 15,
    winByTwo: t.win_by_two != null ? Boolean(t.win_by_two) : true,
    maxScore: t.max_score || null,
    rosterSize: t.roster_size || 12,
    groupsCount: t.groups_count || 2,
    sport: {
      name: t.sport_name,
      slug: t.sport_slug
    },
    venue: t.venue_name ? {
      name: t.venue_name,
      address: t.venue_address,
      city: t.city
    } : null
  };
};

/**
 * Returns live match summaries for a specific tournament.
 * Used by Tournament Live Screen and Signage.
 */
const getTournamentLiveMatches = async (publicId) => {
  const rows = await db.query(
    `SELECT 
      tm.uuid as match_id,
      tm.match_number,
      tm.status,
      COALESCE(tm.live_score_summary, 'Yet to Start') as live_score_summary,
      tm.live_subtext,
      tm.sport_state,
      c.name as court_name,
      v.name as venue_name,
      ta.uuid as team_a_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
      tb.uuid as team_b_id, tb.name as team_b_name, tb.logo_url as team_b_logo,
      s.slug as sport_slug
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN courts c ON tm.court_id = c.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE (t.uuid = ? OR t.id = ?) AND tm.status = 'LIVE'
     ORDER BY tm.match_number ASC`,
    [publicId, /^\d+$/.test(String(publicId).trim()) ? parseInt(publicId, 10) : -1]
  );

  return rows.map(m => {
    let parsedSportState = null;
    try {
      parsedSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : m.sport_state;
    } catch {
      parsedSportState = null;
    }

    return {
      id: m.match_id,
      matchNumber: m.match_number,
      status: m.status,
      courtName: m.court_name || 'Main Court',
      venueName: m.venue_name || 'Sports Arena',
      sportSlug: m.sport_slug,
      teamA: {
        id: m.team_a_id,
        name: m.team_a_name,
        logo: m.team_a_logo
      },
      teamB: {
        id: m.team_b_id,
        name: m.team_b_name,
        logo: m.team_b_logo
      },
      score: {
        summary: m.live_score_summary,
        subtext: m.live_subtext,
        details: parsedSportState
      }
    };
  });
};

/**
 * Returns tournament fixtures & schedule.
 */
const getTournamentFixtures = async (publicId) => {
  const rows = await db.query(
    `SELECT 
      tm.uuid as public_id,
      tm.match_number,
      tm.match_date,
      tm.start_time,
      tm.end_time,
      tm.status,
      tm.result_summary,
      COALESCE(tm.live_score_summary, 'Yet to Start') as live_score_summary,
      tm.group_name,
      tm.team_a_score,
      tm.team_b_score,
      tm.team_a_lineup,
      tm.team_b_lineup,
      c.name as court_name,
      v.name as venue_name,
      ta.uuid as team_a_id,
      ta.name as team_a_name,
      ta.logo_url as team_a_logo,
      tb.uuid as team_b_id,
      tb.name as team_b_name,
      tb.logo_url as team_b_logo,
      t.match_format,
      t.target_score,
      s.slug as sport_slug
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN courts c ON tm.court_id = c.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE t.uuid = ? OR t.id = ?
     ORDER BY tm.group_name ASC, tm.match_number ASC, tm.match_date ASC, tm.start_time ASC`,
    [publicId, isNaN(publicId) ? -1 : parseInt(publicId, 10)]
  );

  return rows.map(m => {
    let parsedALineup = null;
    let parsedBLineup = null;
    try {
      parsedALineup = typeof m.team_a_lineup === 'string' ? JSON.parse(m.team_a_lineup) : m.team_a_lineup;
      parsedBLineup = typeof m.team_b_lineup === 'string' ? JSON.parse(m.team_b_lineup) : m.team_b_lineup;
    } catch {
      // ignore
    }

    return {
      id: m.public_id,
      matchNumber: m.match_number,
      courtName: m.court_name || 'Court 1',
      venueName: m.venue_name || 'Sports Arena',
      date: m.match_date,
      startTime: m.start_time,
      endTime: m.end_time,
      status: m.status,
      groupName: m.group_name || 'Group 1',
      teamAScore: m.team_a_score != null ? m.team_a_score : 0,
      teamBScore: m.team_b_score != null ? m.team_b_score : 0,
      teamALineup: parsedALineup,
      teamBLineup: parsedBLineup,
      matchFormat: m.match_format || 'DOUBLES',
      targetScore: m.target_score || 15,
      sportSlug: m.sport_slug,
      resultSummary: m.result_summary,
      liveScoreSummary: m.live_score_summary,
      teamA: { id: m.team_a_id, name: m.team_a_name, logo: m.team_a_logo },
      teamB: { id: m.team_b_id, name: m.team_b_name, logo: m.team_b_logo }
    };
  });
};

/**
 * Returns tournament teams list.
 */
const getTournamentTeams = async (publicId) => {
  const rows = await db.query(
    `SELECT 
      tm.id as internal_team_id,
      tm.uuid as public_id,
      tm.name,
      tm.logo_url,
      tt.seed_number,
      tt.registration_status,
      COALESCE(tt.group_name, 'Group 1') as group_name
     FROM tournament_teams tt
     JOIN tournaments t ON tt.tournament_id = t.id
     JOIN teams tm ON tt.team_id = tm.id
     WHERE t.uuid = ? OR t.id = ?
     ORDER BY tt.group_name ASC, tt.seed_number ASC, tm.name ASC`,
    [publicId, /^\d+$/.test(String(publicId).trim()) ? parseInt(publicId, 10) : -1]
  );

  const teamsWithMembers = await Promise.all(rows.map(async (t) => {
    const members = await db.query(
      `SELECT tm.id, tm.role, tm.jersey_number, tm.position, tm.is_captain, tm.is_vice_captain,
              COALESCE(u.full_name, tm.player_name, 'Player') as name,
              COALESCE(u.profile_photo, tm.photo_url) as avatar,
              tm.user_id,
              u.batting_style, u.bowling_style, u.preferred_hand_foot
       FROM team_members tm
       LEFT JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = ?
       ORDER BY (CASE WHEN tm.is_captain = 1 OR tm.role = 'CAPTAIN' THEN 0 WHEN tm.is_vice_captain = 1 OR tm.role = 'VICE_CAPTAIN' THEN 1 ELSE 2 END), tm.id ASC`,
      [t.internal_team_id]
    );
    return {
      id: t.public_id,
      internalId: t.internal_team_id,
      name: t.name,
      logo: t.logo_url,
      seed: t.seed_number,
      status: t.registration_status,
      groupName: t.group_name || 'Group 1',
      playersCount: members.length,
      members: members.map(m => ({
        id: m.id,
        name: m.name,
        role: m.position || (m.role === 'CAPTAIN' ? 'Captain' : m.role === 'VICE_CAPTAIN' ? 'Vice-Captain' : 'Player'),
        leadershipRole: m.role || 'PLAYER',
        isCaptain: Boolean(m.is_captain || m.role === 'CAPTAIN'),
        isViceCaptain: Boolean(m.is_vice_captain || m.role === 'VICE_CAPTAIN'),
        jerseyNumber: m.jersey_number,
        avatar: m.avatar,
        userId: m.user_id,
        battingStyle: m.batting_style || null,
        bowlingStyle: m.bowling_style || null,
        preferredHandFoot: m.preferred_hand_foot || null
      }))
    };
  }));

  return teamsWithMembers;
};

/**
 * Returns detailed squad roster for a specific team in a tournament.
 */
const getTournamentTeamRoster = async (tournamentPublicId, teamPublicId, user = null) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, s.name as sport_name, s.slug as sport_slug,
            v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );

  if (!tournamentRows || tournamentRows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }
  const tournament = tournamentRows[0];

  const isTeamNum = /^\d+$/.test(String(teamPublicId).trim());
  const teamRows = await db.query(
    `SELECT tm.*, s.name as sport_name, s.slug as sport_slug,
            tt.group_name, tt.seed_number, tt.registration_status,
            u.full_name as captain_user_name
     FROM teams tm
     LEFT JOIN tournament_teams tt ON (tt.team_id = tm.id AND tt.tournament_id = ?)
     LEFT JOIN sports s ON tm.sport_id = s.id
     LEFT JOIN users u ON tm.captain_id = u.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [tournament.id, teamPublicId, isTeamNum ? parseInt(teamPublicId, 10) : -1]
  );

  if (!teamRows || teamRows.length === 0) {
    throw { statusCode: 404, message: 'Team not found.' };
  }
  const team = teamRows[0];

  const members = await db.query(
    `SELECT tm.id as member_id, tm.team_id, tm.user_id, tm.role, tm.jersey_number, tm.position,
            tm.is_captain, tm.is_vice_captain, tm.joined_at,
            COALESCE(u.full_name, tm.player_name, 'Player') as name,
            COALESCE(u.profile_photo, tm.photo_url) as avatar,
            u.username,
            u.batting_style,
            u.bowling_style,
            u.preferred_hand_foot,
            u.primary_position,
            u.experience_level
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?
     ORDER BY 
       (CASE WHEN tm.is_captain = 1 THEN 0
             WHEN tm.role = 'CAPTAIN' OR (tm.user_id IS NOT NULL AND tm.user_id = ?) THEN 1
             WHEN tm.is_vice_captain = 1 THEN 2
             WHEN tm.role = 'VICE_CAPTAIN' THEN 3
             ELSE 4 END),
       tm.jersey_number IS NULL, tm.jersey_number ASC,
       tm.id ASC`,
    [team.id, team.captain_id || -1]
  );

  let captainAssigned = false;
  let viceCaptainAssigned = false;

  const formattedPlayers = members.map((m) => {
    let isCap = false;
    let isViceCap = false;

    if (!captainAssigned && (m.is_captain === 1 || m.role === 'CAPTAIN' || (team.captain_id && m.user_id === team.captain_id))) {
      isCap = true;
      captainAssigned = true;
    } else if (!viceCaptainAssigned && (m.is_vice_captain === 1 || m.role === 'VICE_CAPTAIN')) {
      isViceCap = true;
      viceCaptainAssigned = true;
    }

    const roleCaption = m.position || m.primary_position || 'Player';

    return {
      id: m.member_id,
      userId: m.user_id,
      name: m.name,
      username: m.username || null,
      avatar: m.avatar || null,
      jerseyNumber: m.jersey_number != null ? m.jersey_number : null,
      role: roleCaption,
      leadershipRole: isCap ? 'CAPTAIN' : isViceCap ? 'VICE_CAPTAIN' : 'PLAYER',
      isCaptain: isCap,
      isViceCaptain: isViceCap,
      battingStyle: m.batting_style || null,
      bowlingStyle: m.bowling_style || null,
      preferredHandFoot: m.preferred_hand_foot || null,
      experienceLevel: m.experience_level || 'Club',
      joinedAt: m.joined_at
    };
  });

  // Sort: Captain first, Vice-Captain second, then by jersey or name
  formattedPlayers.sort((a, b) => {
    if (a.isCaptain && !b.isCaptain) return -1;
    if (!a.isCaptain && b.isCaptain) return 1;
    if (a.isViceCaptain && !b.isViceCaptain) return -1;
    if (!a.isViceCaptain && b.isViceCaptain) return 1;
    if (a.jerseyNumber != null && b.jerseyNumber != null) return a.jerseyNumber - b.jerseyNumber;
    if (a.jerseyNumber != null) return -1;
    if (b.jerseyNumber != null) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  const capPlayer = formattedPlayers.find(p => p.isCaptain);
  const vcPlayer = formattedPlayers.find(p => p.isViceCaptain);

  let canManage = false;
  if (user) {
    if (user.role === 'ADMIN') {
      canManage = true;
    } else if (user.id === team.owner_id || user.id === team.captain_id) {
      canManage = true;
    } else if (tournament.created_by === user.id || tournament.venue_owner_id === user.id) {
      canManage = true;
    }
  }

  return {
    tournament: {
      id: tournament.uuid,
      name: tournament.name,
      sportSlug: tournament.sport_slug || 'cricket',
      sportName: tournament.sport_name || 'Cricket'
    },
    team: {
      id: team.uuid,
      internalId: team.id,
      name: team.name,
      logoUrl: team.logo_url,
      groupName: team.group_name || 'Group 1',
      totalPlayers: formattedPlayers.length,
      captainName: capPlayer ? capPlayer.name : (team.captain_user_name || null),
      viceCaptainName: vcPlayer ? vcPlayer.name : null
    },
    canManage,
    players: formattedPlayers
  };
};

/**
 * Adds a player to a team's squad in a tournament.
 */
const addPlayerToTournamentTeamRoster = async (tournamentPublicId, teamPublicId, playerData, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, s.slug as sport_slug, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows || tournamentRows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }
  const tournament = tournamentRows[0];

  const isTeamNum = /^\d+$/.test(String(teamPublicId).trim());
  const teamRows = await db.query(
    'SELECT * FROM teams WHERE uuid = ? OR id = ?',
    [teamPublicId, isTeamNum ? parseInt(teamPublicId, 10) : -1]
  );
  if (!teamRows || teamRows.length === 0) {
    throw { statusCode: 404, message: 'Team not found.' };
  }
  const team = teamRows[0];

  const canManage = user?.role === 'ADMIN' ||
    user?.id === team.owner_id ||
    user?.id === team.captain_id ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. You do not have permission to manage this team squad.' };
  }

  const {
    name,
    jerseyNumber,
    role = 'Player',
    isCaptain = false,
    isViceCaptain = false,
    battingStyle,
    bowlingStyle,
    preferredHandFoot
  } = playerData;

  if (!name || !name.trim()) {
    throw { statusCode: 400, message: 'Player name is required.' };
  }

  const cleanName = name.trim();
  const parsedJersey = jerseyNumber != null && String(jerseyNumber).trim() !== '' ? parseInt(jerseyNumber, 10) : null;
  const isCap = Boolean(isCaptain);
  const isViceCap = Boolean(!isCap && isViceCaptain);

  if (isCap) {
    await db.query(
      `UPDATE team_members SET is_captain = 0, role = (CASE WHEN role = 'CAPTAIN' THEN 'PLAYER' ELSE role END) WHERE team_id = ?`,
      [team.id]
    );
  }
  if (isViceCap) {
    await db.query(
      `UPDATE team_members SET is_vice_captain = 0, role = (CASE WHEN role = 'VICE_CAPTAIN' THEN 'PLAYER' ELSE role END) WHERE team_id = ?`,
      [team.id]
    );
  }

  const leadershipRole = isCap ? 'CAPTAIN' : isViceCap ? 'VICE_CAPTAIN' : 'PLAYER';

  const insertResult = await db.query(
    `INSERT INTO team_members (
      team_id, user_id, player_name, role, jersey_number, position, is_captain, is_vice_captain
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    [team.id, cleanName, leadershipRole, parsedJersey, role || 'Player', isCap ? 1 : 0, isViceCap ? 1 : 0]
  );

  return {
    id: insertResult.insertId,
    name: cleanName,
    jerseyNumber: parsedJersey,
    role: role || 'Player',
    isCaptain: isCap,
    isViceCaptain: isViceCap,
    battingStyle: battingStyle || null,
    bowlingStyle: bowlingStyle || null,
    preferredHandFoot: preferredHandFoot || null
  };
};

/**
 * Creates a new tournament with full validation, authorization, and persistence.
 */
const createTournament = async ({
  name,
  sportId,
  sportSlug,
  description,
  bannerUrl,
  format = 'LEAGUE',
  venueId,
  startDate,
  endDate,
  registrationDeadline,
  entryFee = 0,
  maxTeams = 16,
  rules,
  status = 'PUBLISHED',
  hasAuction = false,
  matchFormat = 'DOUBLES',
  targetScore = 15,
  winByTwo = true,
  maxScore = null,
  rosterSize = 12,
  groupsCount = 2,
  user
}) => {
  const crypto = require('crypto');

  // 1. Role validation
  if (!user || !['ADMIN', 'VENUE_OWNER'].includes(user.role)) {
    throw { statusCode: 403, message: 'Forbidden. Only administrators and venue owners can create tournaments.' };
  }

  // 2. Name validation
  if (!name || typeof name !== 'string' || name.trim().length < 3) {
    throw { statusCode: 400, message: 'Tournament name is required and must be at least 3 characters long.' };
  }
  if (name.trim().length > 150) {
    throw { statusCode: 400, message: 'Tournament name must not exceed 150 characters.' };
  }

  // 3. Sport validation
  let resolvedSportId = null;
  if (sportId) {
    const parsedId = parseInt(sportId, 10);
    const sports = await db.query('SELECT id, name, slug FROM sports WHERE id = ?', [parsedId]);
    if (sports && sports.length > 0) {
      resolvedSportId = sports[0].id;
    }
  } else if (sportSlug) {
    const sports = await db.query('SELECT id, name, slug FROM sports WHERE slug = ?', [sportSlug]);
    if (sports && sports.length > 0) {
      resolvedSportId = sports[0].id;
    }
  }

  if (!resolvedSportId) {
    // Default to Cricket (id: 1) if not explicitly matched
    resolvedSportId = 1;
  }

  // 4. Date validation
  if (!startDate) {
    throw { statusCode: 400, message: 'Start date is required.' };
  }
  if (!endDate) {
    throw { statusCode: 400, message: 'End date is required.' };
  }

  const startObj = new Date(startDate);
  const endObj = new Date(endDate);
  if (isNaN(startObj.getTime())) {
    throw { statusCode: 400, message: 'Invalid start date format.' };
  }
  if (isNaN(endObj.getTime())) {
    throw { statusCode: 400, message: 'Invalid end date format.' };
  }
  if (endObj < startObj) {
    throw { statusCode: 400, message: 'Tournament end date cannot be earlier than start date.' };
  }

  const startDateStr = startObj.toISOString().slice(0, 10);
  const endDateStr = endObj.toISOString().slice(0, 10);

  let regDeadlineStr = startDateStr;
  if (registrationDeadline) {
    const regObj = new Date(registrationDeadline);
    if (isNaN(regObj.getTime())) {
      throw { statusCode: 400, message: 'Invalid registration deadline format.' };
    }
    if (regObj > startObj) {
      throw { statusCode: 400, message: 'Registration deadline cannot be after tournament start date.' };
    }
    regDeadlineStr = regObj.toISOString().slice(0, 10);
  }

  // 5. Format validation
  const allowedFormats = ['LEAGUE', 'KNOCKOUT', 'LEAGUE_KNOCKOUT'];
  const resolvedFormat = allowedFormats.includes(format) ? format : 'LEAGUE';

  // 6. Max teams validation
  const parsedMaxTeams = parseInt(maxTeams, 10) || 16;
  if (parsedMaxTeams < 2 || parsedMaxTeams > 64) {
    throw { statusCode: 400, message: 'Maximum teams must be between 2 and 64.' };
  }

  // 7. Entry fee validation
  const parsedEntryFee = Math.max(0, parseFloat(entryFee) || 0);

  // 8. Venue validation
  let resolvedVenueId = null;
  if (venueId) {
    const parsedVId = parseInt(venueId, 10);
    if (!isNaN(parsedVId) && parsedVId > 0) {
      const venues = await db.query('SELECT id, owner_id, name, city FROM venues WHERE id = ?', [parsedVId]);
      if (!venues || venues.length === 0) {
        throw { statusCode: 400, message: 'Selected venue not found.' };
      }
      if (user.role === 'VENUE_OWNER' && venues[0].owner_id !== user.id) {
        throw { statusCode: 403, message: 'You are not authorized to schedule a tournament at another owner\'s venue.' };
      }
      resolvedVenueId = parsedVId;
    }
  }

  // 9. Status validation
  const allowedStatuses = ['DRAFT', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED'];
  const resolvedStatus = allowedStatuses.includes(status) ? status : 'PUBLISHED';

  // 10. Default banner if not provided
  let resolvedBannerUrl = bannerUrl ? bannerUrl.trim() : null;
  if (!resolvedBannerUrl) {
    if (resolvedSportId === 1) {
      resolvedBannerUrl = 'https://images.unsplash.com/photo-1540747913346-19e32dc3e97e?auto=format&fit=crop&w=1200&q=80';
    } else if (resolvedSportId === 2) {
      resolvedBannerUrl = 'https://images.unsplash.com/photo-1508098682722-e99c43a406b2?auto=format&fit=crop&w=1200&q=80';
    } else if (resolvedSportId === 3) {
      resolvedBannerUrl = 'https://images.unsplash.com/photo-1626224583764-f87db24ac4ea?auto=format&fit=crop&w=1200&q=80';
    } else if (resolvedSportId === 6) {
      resolvedBannerUrl = 'https://images.unsplash.com/photo-1599586120429-48281b6f0ece?auto=format&fit=crop&w=1200&q=80';
    } else {
      resolvedBannerUrl = 'https://images.unsplash.com/photo-1517649763962-0c623266ddc0?auto=format&fit=crop&w=1200&q=80';
    }
  }

  // 11. UUID generation
  const publicId = crypto.randomUUID();

  // 12. Pickleball parameters
  const parsedTargetScore = Math.max(1, parseInt(targetScore, 10) || 15);
  const parsedWinByTwo = winByTwo === false || winByTwo === 'false' || winByTwo === 0 ? 0 : 1;
  const parsedMaxScore = maxScore ? parseInt(maxScore, 10) : null;
  const parsedRosterSize = Math.max(1, parseInt(rosterSize, 10) || 12);
  const parsedGroupsCount = Math.max(1, parseInt(groupsCount, 10) || 2);
  const resolvedMatchFormat = matchFormat === 'SINGLES' ? 'SINGLES' : 'DOUBLES';

  // 13. Persistence
  await db.query(
    `INSERT INTO tournaments (
      uuid, name, sport_id, description, banner_url, format, venue_id,
      start_date, end_date, registration_deadline, entry_fee, max_teams,
      rules, status, created_by, has_auction,
      match_format, target_score, win_by_two, max_score, roster_size, groups_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      publicId,
      name.trim(),
      resolvedSportId,
      description ? description.trim() : null,
      resolvedBannerUrl,
      resolvedFormat,
      resolvedVenueId,
      startDateStr,
      endDateStr,
      regDeadlineStr,
      parsedEntryFee,
      parsedMaxTeams,
      rules ? rules.trim() : null,
      resolvedStatus,
      user.id,
      hasAuction ? 1 : 0,
      resolvedMatchFormat,
      parsedTargetScore,
      parsedWinByTwo,
      parsedMaxScore,
      parsedRosterSize,
      parsedGroupsCount
    ]
  );

  return await getTournamentByPublicId(publicId);
};

module.exports = {
  getTournamentsPaginated,
  getTournamentByPublicId,
  getTournamentLiveMatches,
  getTournamentFixtures,
  getTournamentTeams,
  getTournamentTeamRoster,
  addPlayerToTournamentTeamRoster,
  createTournament
};
