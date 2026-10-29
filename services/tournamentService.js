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
      COALESCE(t.total_views, 0) as total_views,
      COALESCE(t.unique_viewers, 0) as unique_viewers,
      t.last_viewed_at,
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
      totalViews: parseInt(item.total_views, 10) || 0,
      uniqueViewers: parseInt(item.unique_viewers, 10) || 0,
      lastViewedAt: item.last_viewed_at || null,
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
      t.banner_url, t.max_teams, t.court_color,
      t.start_date, t.end_date, t.status, t.rules, t.has_auction,
      t.created_by, t.venue_id, v.owner_id as venue_owner_id,
      t.match_format, t.target_score, t.win_by_two, t.max_score, t.roster_size, t.groups_count,
      t.sport_config,
      COALESCE(t.total_views, 0) as total_views,
      COALESCE(t.unique_viewers, 0) as unique_viewers,
      t.last_viewed_at,
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
  let parsedSportConfig = {};
  try {
    parsedSportConfig = typeof t.sport_config === 'string' ? JSON.parse(t.sport_config) : (t.sport_config || {});
  } catch {}

  const scoringMode = parsedSportConfig?.scoringMode || 'RALLY';

  return {
    id: t.public_id,
    internalId: t.id,
    name: t.name,
    description: t.description,
    format: t.format,
    city: t.city,
    bannerUrl: t.banner_url,
    courtColor: t.court_color || '#0d5c3a',
    dates: {
      start: t.start_date,
      end: t.end_date
    },
    maxTeams: t.max_teams,
    totalTeams: t.max_teams,
    registeredTeams: parseInt(t.registered_teams_count, 10) || 0,
    registeredTeamsCount: parseInt(t.registered_teams_count, 10) || 0,
    teamsCount: parseInt(t.registered_teams_count, 10) || 0,
    totalViews: parseInt(t.total_views, 10) || 0,
    uniqueViewers: parseInt(t.unique_viewers, 10) || 0,
    lastViewedAt: t.last_viewed_at || null,
    status: t.status,
    rules: t.rules,
    createdBy: t.created_by,
    venueOwnerId: t.venue_owner_id,
    hasAuction: Boolean(t.has_auction || t.auction_id),
    auctionId: t.auction_id || null,
    auctionStatus: t.auction_status || null,
    matchFormat: t.match_format || 'DOUBLES',
    scoringMode,
    targetScore: t.target_score != null ? t.target_score : 15,
    winByTwo: t.win_by_two != null ? Boolean(t.win_by_two) : true,
    maxScore: t.max_score || null,
    rosterSize: t.roster_size || 12,
    groupsCount: t.groups_count || 2,
    sportConfig: parsedSportConfig,
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
      tm.show_on_display,
      tm.category,
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
      showOnDisplay: m.show_on_display === null || m.show_on_display === undefined ? true : Boolean(m.show_on_display),
      category: m.category || 'League',
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
      tm.id as internal_id,
      tm.uuid as public_id,
      tm.match_number,
      tm.match_date,
      tm.start_time,
      tm.end_time,
      tm.status,
      tm.show_on_display,
      tm.category,
      tm.counts_in_standings,
      tm.bracket_slot,
      tm.next_match_id,
      tm.scorer_id,
      tm.court_id,
      tm.team_a_id as team_a_internal_id,
      tm.team_b_id as team_b_internal_id,
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
      internalId: m.internal_id,
      matchNumber: m.match_number,
      showOnDisplay: m.show_on_display === null || m.show_on_display === undefined ? true : Boolean(m.show_on_display),
      category: m.category || 'League',
      countsInStandings: m.counts_in_standings === null || m.counts_in_standings === undefined ? (m.category === 'League' ? 1 : 0) : Boolean(m.counts_in_standings),
      bracketSlot: m.bracket_slot,
      nextMatchId: m.next_match_id,
      scorerId: m.scorer_id,
      courtId: m.court_id,
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
      teamA: { id: m.team_a_id, internalId: m.team_a_internal_id, name: m.team_a_name, logo: m.team_a_logo },
      teamB: { id: m.team_b_id, internalId: m.team_b_internal_id, name: m.team_b_name, logo: m.team_b_logo }
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
     WHERE tm.team_id = ? AND tm.deleted_at IS NULL
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
 * Updates a player in a team's squad for a tournament.
 */
const updatePlayerInTournamentTeamRoster = async (tournamentPublicId, teamPublicId, playerId, playerData, user) => {
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
    (Array.isArray(user?.roles) && user.roles.includes('ADMIN')) ||
    user?.id === team.owner_id ||
    user?.id === team.captain_id ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. You do not have permission to manage this team squad.' };
  }

  const isPlayerNum = /^\d+$/.test(String(playerId).trim());
  const memberRows = await db.query(
    'SELECT * FROM team_members WHERE (id = ?) AND team_id = ? AND deleted_at IS NULL',
    [isPlayerNum ? parseInt(playerId, 10) : -1, team.id]
  );
  if (!memberRows || memberRows.length === 0) {
    throw { statusCode: 404, message: 'Player not found in this team squad.' };
  }
  const existingMember = memberRows[0];

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

  const cleanName = (name && name.trim()) || existingMember.player_name;
  const parsedJersey = jerseyNumber != null && String(jerseyNumber).trim() !== '' ? parseInt(jerseyNumber, 10) : null;
  const isCap = Boolean(isCaptain);
  const isViceCap = Boolean(!isCap && isViceCaptain);

  // Maintain one-captain / one-vice-captain rule
  if (isCap) {
    await db.query(
      `UPDATE team_members SET is_captain = 0, role = (CASE WHEN role = 'CAPTAIN' THEN 'PLAYER' ELSE role END) WHERE team_id = ? AND id != ?`,
      [team.id, existingMember.id]
    );
  }
  if (isViceCap) {
    await db.query(
      `UPDATE team_members SET is_vice_captain = 0, role = (CASE WHEN role = 'VICE_CAPTAIN' THEN 'PLAYER' ELSE role END) WHERE team_id = ? AND id != ?`,
      [team.id, existingMember.id]
    );
  }

  const leadershipRole = isCap ? 'CAPTAIN' : isViceCap ? 'VICE_CAPTAIN' : 'PLAYER';

  await db.query(
    `UPDATE team_members
     SET player_name = ?, jersey_number = ?, position = ?, role = ?, is_captain = ?, is_vice_captain = ?
     WHERE id = ?`,
    [cleanName, parsedJersey, role || 'Player', leadershipRole, isCap ? 1 : 0, isViceCap ? 1 : 0, existingMember.id]
  );

  // If member has linked user_id and sports styles provided, update user record
  if (existingMember.user_id && (battingStyle || bowlingStyle || preferredHandFoot)) {
    try {
      await db.query(
        `UPDATE users
         SET batting_style = COALESCE(?, batting_style),
             bowling_style = COALESCE(?, bowling_style),
             preferred_hand_foot = COALESCE(?, preferred_hand_foot)
         WHERE id = ?`,
        [battingStyle || null, bowlingStyle || null, preferredHandFoot || null, existingMember.user_id]
      );
    } catch (uErr) {
      console.warn('Failed to update user sports style:', uErr);
    }
  }

  // Socket notification to sync Signage TV and Tournament live pages
  const { getIO } = require('./socketService');
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:rosterUpdated', {
      tournamentId: tournament.uuid,
      teamId: team.uuid,
      playerId: existingMember.id
    });
  }

  return {
    id: existingMember.id,
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
 * Removes a player from a team's squad in a tournament.
 */
const removePlayerFromTournamentTeamRoster = async (tournamentPublicId, teamPublicId, playerId, user) => {
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
    (Array.isArray(user?.roles) && user.roles.includes('ADMIN')) ||
    user?.id === team.owner_id ||
    user?.id === team.captain_id ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. You do not have permission to manage this team squad.' };
  }

  const isPlayerNum = /^\d+$/.test(String(playerId).trim());
  const memberRows = await db.query(
    'SELECT * FROM team_members WHERE (id = ?) AND team_id = ? AND deleted_at IS NULL',
    [isPlayerNum ? parseInt(playerId, 10) : -1, team.id]
  );
  if (!memberRows || memberRows.length === 0) {
    throw { statusCode: 404, message: 'Player not found in this team squad.' };
  }
  const existingMember = memberRows[0];

  // Soft delete from squad by marking deleted_at, keeping historical match data intact
  await db.query(
    `UPDATE team_members SET deleted_at = NOW() WHERE id = ?`,
    [existingMember.id]
  );

  // Sync WebSocket
  const { getIO } = require('./socketService');
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:rosterUpdated', {
      tournamentId: tournament.uuid,
      teamId: team.uuid,
      playerId: existingMember.id,
      action: 'REMOVED'
    });
  }

  return {
    success: true,
    message: `Player "${existingMember.player_name || 'Player'}" removed from squad successfully.`,
    playerId: existingMember.id
  };
};

/**
 * Updates whether a match is displayed on Signage TV and Smart TV broadcast.
 */
const updateTournamentMatchDisplay = async (tournamentPublicId, matchPublicId, showOnDisplay, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows || tournamentRows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }
  const tournament = tournamentRows[0];

  const canManage = user?.role === 'ADMIN' ||
    (Array.isArray(user?.roles) && user.roles.includes('ADMIN')) ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. Only tournament organizers and admins can configure display matches.' };
  }

  const isMatchNum = /^\d+$/.test(String(matchPublicId).trim());
  const matchRows = await db.query(
    `SELECT * FROM tournament_matches WHERE (uuid = ? OR id = ?) AND tournament_id = ?`,
    [matchPublicId, isMatchNum ? parseInt(matchPublicId, 10) : -1, tournament.id]
  );
  if (!matchRows || matchRows.length === 0) {
    throw { statusCode: 404, message: 'Match not found.' };
  }
  const match = matchRows[0];

  const flag = Boolean(showOnDisplay) ? 1 : 0;
  await db.query(
    `UPDATE tournament_matches SET show_on_display = ? WHERE id = ?`,
    [flag, match.id]
  );

  // Sync via WebSocket to TV & Signage displays
  const { getIO } = require('./socketService');
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchDisplayUpdated', {
      tournamentId: tournament.uuid,
      matchId: match.uuid,
      showOnDisplay: Boolean(flag)
    });
    io.to(`tv:${tournament.uuid}`).emit('display:matchesUpdated', {
      tournamentId: tournament.uuid
    });
  }

  return {
    success: true,
    message: `Match #${match.match_number} display updated to ${flag ? 'Visible' : 'Hidden'}.`,
    matchId: match.uuid,
    showOnDisplay: Boolean(flag)
  };
};

/**
 * Bulk updates display visibility for all or specified matches.
 */
const bulkUpdateTournamentMatchesDisplay = async (tournamentPublicId, { matchIds, showOnDisplay, selectAll, clearAll }, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows || tournamentRows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }
  const tournament = tournamentRows[0];

  const canManage = user?.role === 'ADMIN' ||
    (Array.isArray(user?.roles) && user.roles.includes('ADMIN')) ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. Only tournament organizers and admins can configure display matches.' };
  }

  let flag = 1;
  if (clearAll) {
    flag = 0;
    await db.query(`UPDATE tournament_matches SET show_on_display = 0 WHERE tournament_id = ?`, [tournament.id]);
  } else if (selectAll) {
    flag = 1;
    await db.query(`UPDATE tournament_matches SET show_on_display = 1 WHERE tournament_id = ?`, [tournament.id]);
  } else if (Array.isArray(matchIds) && matchIds.length > 0) {
    flag = showOnDisplay !== false ? 1 : 0;
    const placeholders = matchIds.map(() => '?').join(',');
    await db.query(
      `UPDATE tournament_matches SET show_on_display = ? WHERE tournament_id = ? AND (uuid IN (${placeholders}) OR id IN (${placeholders}))`,
      [flag, tournament.id, ...matchIds, ...matchIds]
    );
  }

  // Live WebSocket Sync
  const { getIO } = require('./socketService');
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:matchDisplayUpdated', {
      tournamentId: tournament.uuid,
      bulk: true,
      showOnDisplay: Boolean(flag)
    });
    io.to(`tv:${tournament.uuid}`).emit('display:matchesUpdated', {
      tournamentId: tournament.uuid
    });
  }

  return {
    success: true,
    message: clearAll ? 'All matches hidden from TV displays.' : selectAll ? 'All matches visible on TV displays.' : 'Match display preferences updated.',
    showOnDisplay: Boolean(flag)
  };
};

/**
 * Updates court background color for a tournament.
 */
const updateTournamentCourtColor = async (tournamentPublicId, courtColor, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, v.owner_id as venue_owner_id
     FROM tournaments t
     LEFT JOIN venues v ON t.venue_id = v.id
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows || tournamentRows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }
  const tournament = tournamentRows[0];

  const canManage = user?.role === 'ADMIN' ||
    (Array.isArray(user?.roles) && user.roles.includes('ADMIN')) ||
    tournament.created_by === user?.id ||
    tournament.venue_owner_id === user?.id;

  if (!canManage) {
    throw { statusCode: 403, message: 'Forbidden. Only tournament organizers and admins can customize court color.' };
  }

  const validColor = courtColor && typeof courtColor === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(courtColor.trim())
    ? courtColor.trim()
    : '#0d5c3a';

  await db.query(`UPDATE tournaments SET court_color = ? WHERE id = ?`, [validColor, tournament.id]);

  // Live WebSocket broadcast to tournament, TV, and signage screens
  const { getIO } = require('./socketService');
  const io = getIO();
  if (io) {
    io.to(`tournament:${tournament.uuid}`).emit('tournament:courtColorUpdated', {
      tournamentId: tournament.uuid,
      courtColor: validColor
    });
    io.to(`tv:${tournament.uuid}`).emit('tournament:courtColorUpdated', {
      tournamentId: tournament.uuid,
      courtColor: validColor
    });
    io.emit('court:colorUpdated', {
      tournamentId: tournament.uuid,
      courtColor: validColor
    });
  }

  return {
    success: true,
    message: 'Court color updated successfully.',
    courtColor: validColor
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
  scoringMode = 'RALLY',
  targetScore = 15,
  winByTwo = true,
  maxScore = null,
  rosterSize = 12,
  groupsCount = 2,
  sportConfig = null,
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
  const resolvedScoringMode = String(scoringMode || '').toUpperCase() === 'SIDE_OUT' ? 'SIDE_OUT' : 'RALLY';
  const resolvedSportConfig = {
    ...(typeof sportConfig === 'object' && sportConfig !== null ? sportConfig : {}),
    scoringMode: resolvedScoringMode
  };

  // 13. Persistence
  await db.query(
    `INSERT INTO tournaments (
      uuid, name, sport_id, description, banner_url, format, venue_id,
      start_date, end_date, registration_deadline, entry_fee, max_teams,
      rules, status, created_by, has_auction,
      match_format, target_score, win_by_two, max_score, roster_size, groups_count, sport_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      parsedGroupsCount,
      JSON.stringify(resolvedSportConfig)
    ]
  );

  return await getTournamentByPublicId(publicId);
};

/**
 * Returns impact of removing a team from a tournament (completed matches, fixtures, standings).
 */
const getTeamRemovalImpact = async (tournamentPublicId, teamPublicId) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT id, uuid, name FROM tournaments WHERE uuid = ? OR id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows.length) throw { statusCode: 404, message: 'Tournament not found' };
  const tournament = tournamentRows[0];

  const isTeamNum = /^\d+$/.test(String(teamPublicId).trim());
  const teamRows = await db.query(
    `SELECT id, uuid, name FROM teams WHERE uuid = ? OR id = ?`,
    [teamPublicId, isTeamNum ? parseInt(teamPublicId, 10) : -1]
  );
  if (!teamRows.length) throw { statusCode: 404, message: 'Team not found' };
  const team = teamRows[0];

  // 1. Completed matches
  const completedMatches = await db.query(
    `SELECT COUNT(*) as count FROM tournament_matches 
     WHERE tournament_id = ? AND (team_a_id = ? OR team_b_id = ?) AND status = 'COMPLETED'`,
    [tournament.id, team.id, team.id]
  );

  // 2. Scheduled fixtures
  const scheduledFixtures = await db.query(
    `SELECT COUNT(*) as count FROM tournament_matches 
     WHERE tournament_id = ? AND (team_a_id = ? OR team_b_id = ?) AND status NOT IN ('COMPLETED', 'CANCELLED', 'ABANDONED')`,
    [tournament.id, team.id, team.id]
  );

  // 3. Standings records
  const standingsRows = await db.query(
    `SELECT COUNT(*) as count FROM points_table 
     WHERE tournament_id = ? AND team_id = ?`,
    [tournament.id, team.id]
  );

  return {
    tournament: { id: tournament.uuid, name: tournament.name },
    team: { id: team.uuid, name: team.name },
    completedMatchesCount: Number(completedMatches[0]?.count || 0),
    scheduledFixturesCount: Number(scheduledFixtures[0]?.count || 0),
    standingsCount: Number(standingsRows[0]?.count || 0)
  };
};

/**
 * Removes a team from a tournament, handles fixtures/matches cleanup, recalculates standings, and audits.
 */
const removeTeamFromTournament = async (tournamentPublicId, teamPublicId, { mode = 'CANCEL_FIXTURES', confirmWord = '' } = {}, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT id, uuid, name FROM tournaments WHERE uuid = ? OR id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows.length) throw { statusCode: 404, message: 'Tournament not found' };
  const tournament = tournamentRows[0];

  const isTeamNum = /^\d+$/.test(String(teamPublicId).trim());
  const teamRows = await db.query(
    `SELECT id, uuid, name FROM teams WHERE uuid = ? OR id = ?`,
    [teamPublicId, isTeamNum ? parseInt(teamPublicId, 10) : -1]
  );
  if (!teamRows.length) throw { statusCode: 404, message: 'Team not found' };
  const team = teamRows[0];

  const impact = await getTeamRemovalImpact(tournamentPublicId, teamPublicId);
  const { completedMatchesCount, scheduledFixturesCount } = impact;

  if (completedMatchesCount > 0) {
    if (mode === 'BLOCK') {
      throw { statusCode: 400, message: `Removal blocked: Team "${team.name}" has ${completedMatchesCount} completed match(es) in this tournament.` };
    }
    const normalizedWord = String(confirmWord || '').trim().toLowerCase();
    const expectedWords = ['remove', team.name.toLowerCase().trim()];
    if (!expectedWords.includes(normalizedWord)) {
      throw { statusCode: 400, message: `Confirmation word mismatch. Please type "REMOVE" or "${team.name}" to confirm deleting completed match records.` };
    }

    const matchRows = await db.query(
      `SELECT id FROM tournament_matches WHERE tournament_id = ? AND (team_a_id = ? OR team_b_id = ?)`,
      [tournament.id, team.id, team.id]
    );
    const mIds = matchRows.map(m => m.id);
    if (mIds.length > 0) {
      await db.query(`DELETE FROM score_events WHERE match_id IN (?)`, [mIds]).catch(() => {});
      await db.query(`DELETE FROM cricket_balls WHERE match_id IN (?)`, [mIds]).catch(() => {});
      await db.query(`DELETE FROM cricket_overs WHERE match_id IN (?)`, [mIds]).catch(() => {});
      await db.query(`DELETE FROM cricket_innings WHERE match_id IN (?)`, [mIds]).catch(() => {});
      await db.query(`DELETE FROM pickleball_score_logs WHERE match_id IN (?)`, [mIds]).catch(() => {});
      await db.query(`DELETE FROM tournament_matches WHERE id IN (?)`, [mIds]);
    }
  } else if (scheduledFixturesCount > 0) {
    await db.query(
      `DELETE FROM tournament_matches 
       WHERE tournament_id = ? AND (team_a_id = ? OR team_b_id = ?) AND status NOT IN ('COMPLETED')`,
      [tournament.id, team.id, team.id]
    );
  }

  // Delete registration in this tournament (keeps the team itself intact)
  await db.query(
    `DELETE FROM tournament_teams WHERE tournament_id = ? AND team_id = ?`,
    [tournament.id, team.id]
  );

  // Delete points table entry for this tournament
  await db.query(
    `DELETE FROM points_table WHERE tournament_id = ? AND team_id = ?`,
    [tournament.id, team.id]
  );

  // Recalculate standings
  try {
    const { recalculateStandings } = require('./tournamentEngineService');
    await recalculateStandings(tournament.id);
  } catch (err) {
    console.warn('Standings recalculation error after team removal:', err);
  }

  // Audit log entry
  try {
    await db.query(
      `INSERT INTO tournament_audit_logs (tournament_id, action_type, user_id, user_role, previous_state, new_state, notes)
       VALUES (?, 'REMOVE_TEAM', ?, ?, ?, ?, ?)`,
      [
        tournament.id,
        user?.id || 1,
        user?.role || 'ORGANIZER',
        JSON.stringify({ teamId: team.id, teamName: team.name, impact }),
        JSON.stringify({ status: 'REMOVED' }),
        `Removed team "${team.name}" from tournament "${tournament.name}". Mode: ${mode}`
      ]
    );
  } catch (logErr) {
    console.warn('Audit log write error:', logErr);
  }

  // Real-time WebSocket sync
  try {
    const { getIO } = require('./socketService');
    const io = getIO();
    if (io) {
      io.to(`tournament:${tournament.uuid}`).emit('tournament:teamRemoved', {
        tournamentId: tournament.uuid,
        teamId: team.uuid,
        teamName: team.name
      });
      io.to(`tournament:${tournament.uuid}`).emit('tournament:teamsUpdated', {
        tournamentId: tournament.uuid
      });
      io.to(`tournament:${tournament.uuid}`).emit('tournament:standingsUpdated', {
        tournamentId: tournament.uuid
      });
      io.to(`tournament:${tournament.uuid}`).emit('tournament:fixturesUpdated', {
        tournamentId: tournament.uuid
      });
    }
  } catch (wsErr) {
    console.warn('WebSocket broadcast error:', wsErr);
  }

  return {
    success: true,
    message: `Team "${team.name}" was removed from ${tournament.name} successfully.`
  };
};

/**
 * Bulk registers multiple teams to a tournament.
 */
const bulkAddTeamsToTournament = async (tournamentPublicId, { teamIds = [], groupName = 'Group 1' } = {}, user) => {
  if (!Array.isArray(teamIds) || teamIds.length === 0) {
    throw { statusCode: 400, message: 'Please select at least one team to register.' };
  }

  const isTournNum = /^\d+$/.test(String(tournamentPublicId).trim());
  const tournamentRows = await db.query(
    `SELECT t.*, s.slug as sport_slug, s.name as sport_name 
     FROM tournaments t 
     JOIN sports s ON t.sport_id = s.id 
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentPublicId, isTournNum ? parseInt(tournamentPublicId, 10) : -1]
  );
  if (!tournamentRows.length) throw { statusCode: 404, message: 'Tournament not found' };
  const tournament = tournamentRows[0];

  const results = [];
  let registeredCount = 0;
  let skippedCount = 0;

  for (const tid of teamIds) {
    try {
      const isNum = /^\d+$/.test(String(tid).trim());
      const teamRows = await db.query(
        `SELECT id, uuid, name, logo_url, sport_id FROM teams WHERE uuid = ? OR id = ?`,
        [tid, isNum ? parseInt(tid, 10) : -1]
      );
      if (!teamRows.length) {
        results.push({ teamId: tid, status: 'FAILED', reason: 'Team not found' });
        skippedCount++;
        continue;
      }
      const team = teamRows[0];

      // Sport compatibility
      if (team.sport_id && tournament.sport_id && team.sport_id !== tournament.sport_id) {
        results.push({ teamId: tid, teamName: team.name, status: 'SKIPPED', reason: 'Sport does not match tournament' });
        skippedCount++;
        continue;
      }

      // Check duplicate registration
      const existing = await db.query(
        `SELECT id FROM tournament_teams WHERE tournament_id = ? AND team_id = ?`,
        [tournament.id, team.id]
      );
      if (existing.length > 0) {
        results.push({ teamId: tid, teamName: team.name, status: 'SKIPPED', reason: 'Already registered' });
        skippedCount++;
        continue;
      }

      // Register team
      await db.query(
        `INSERT INTO tournament_teams (tournament_id, team_id, registration_status, payment_status, group_name)
         VALUES (?, ?, 'APPROVED', 'PAID', ?)`,
        [tournament.id, team.id, groupName || 'Group 1']
      );

      // Check if team has members, auto-populate default roster if empty
      const members = await db.query(`SELECT id FROM team_members WHERE team_id = ?`, [team.id]);
      if (!members || members.length === 0) {
        const rosterSize = tournament.roster_size || 12;
        for (let idx = 0; idx < rosterSize; idx++) {
          const pName = `${team.name} Player ${idx + 1}`;
          const role = idx === 0 ? 'CAPTAIN' : (idx === 1 ? 'VICE_CAPTAIN' : 'PLAYER');
          const isCap = idx === 0 ? 1 : 0;
          const isViceCap = idx === 1 ? 1 : 0;
          await db.query(
            `INSERT INTO team_members (team_id, user_id, player_name, role, jersey_number, is_captain, is_vice_captain)
             VALUES (?, NULL, ?, ?, ?, ?, ?)`,
            [team.id, pName, role, idx + 1, isCap, isViceCap]
          );
        }
      }

      results.push({ teamId: tid, teamName: team.name, status: 'SUCCESS' });
      registeredCount++;
    } catch (err) {
      results.push({ teamId: tid, status: 'FAILED', reason: err.message || 'Registration failed' });
      skippedCount++;
    }
  }

  // Recalculate standings
  try {
    const { recalculateStandings } = require('./tournamentEngineService');
    await recalculateStandings(tournament.id);
  } catch (err) {
    console.warn('Standings recalculation error after bulk team add:', err);
  }

  // Audit log entry
  try {
    await db.query(
      `INSERT INTO tournament_audit_logs (tournament_id, action_type, user_id, user_role, new_state, notes)
       VALUES (?, 'BULK_REGISTER_TEAMS', ?, ?, ?, ?)`,
      [
        tournament.id,
        user?.id || 1,
        user?.role || 'ORGANIZER',
        JSON.stringify({ registeredCount, skippedCount, groupName }),
        `Bulk registered ${registeredCount} teams into "${groupName}".`
      ]
    );
  } catch (logErr) {
    console.warn('Audit log write error:', logErr);
  }

  // WebSocket sync
  try {
    const { getIO } = require('./socketService');
    const io = getIO();
    if (io) {
      io.to(`tournament:${tournament.uuid}`).emit('tournament:teamsUpdated', {
        tournamentId: tournament.uuid
      });
      io.to(`tournament:${tournament.uuid}`).emit('tournament:standingsUpdated', {
        tournamentId: tournament.uuid
      });
    }
  } catch (wsErr) {
    console.warn('WebSocket broadcast error:', wsErr);
  }

  return {
    success: true,
    message: `Registered ${registeredCount} team${registeredCount === 1 ? '' : 's'}${skippedCount > 0 ? ` (${skippedCount} skipped)` : ''}.`,
    registeredCount,
    skippedCount,
    results
  };
};

/**
 * 16. Get Tournament Deletion Impact Summary
 */
/**
 * 16. Get Tournament Deletion Impact Summary
 */
const getTournamentDeleteImpact = async (tournamentId, user) => {
  const isTournNum = /^\d+$/.test(String(tournamentId).trim());
  const rows = await db.query(
    'SELECT t.*, v.owner_id as venue_owner_id FROM tournaments t LEFT JOIN venues v ON t.venue_id = v.id WHERE t.uuid = ? OR (t.id = ? AND ? > 0)',
    [tournamentId, isTournNum ? parseInt(tournamentId, 10) : -1, isTournNum ? parseInt(tournamentId, 10) : -1]
  );
  if (!rows || rows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found' };
  }
  const tournament = rows[0];

  const isSuperAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  const isCreator = (tournament.created_by && String(tournament.created_by) === String(user.id)) ||
                    (tournament.venue_owner_id && String(tournament.venue_owner_id) === String(user.id));

  if (!isSuperAdmin && !isCreator) {
    throw { statusCode: 403, message: 'Access denied. Only the tournament creator or a superadmin can delete this tournament.' };
  }

  // Count matches
  const matchRows = await db.query(
    `SELECT 
       COUNT(*) as total_matches,
       SUM(CASE WHEN status = 'LIVE' THEN 1 ELSE 0 END) as live_matches,
       SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as completed_matches,
       SUM(CASE WHEN status = 'SCHEDULED' THEN 1 ELSE 0 END) as scheduled_matches
     FROM tournament_matches WHERE tournament_id = ?`,
    [tournament.id]
  );
  const matchStats = matchRows[0] || {};

  // Count teams
  const teamRows = await db.query(
    'SELECT COUNT(*) as registered_teams FROM tournament_teams WHERE tournament_id = ?',
    [tournament.id]
  );

  // Count player registrations
  const playerRows = await db.query(
    'SELECT COUNT(*) as registered_players FROM tournament_player_registrations WHERE tournament_id = ?',
    [tournament.id]
  );

  // Count auction items if any
  const auctionRows = await db.query(
    'SELECT COUNT(*) as auction_count FROM tournament_auctions WHERE tournament_id = ?',
    [tournament.id]
  );

  const impactData = {
    tournament: {
      id: tournament.uuid,
      name: tournament.name,
      status: tournament.status,
      startDate: tournament.start_date,
      format: tournament.format
    },
    matches: {
      total: parseInt(matchStats.total_matches, 10) || 0,
      live: parseInt(matchStats.live_matches, 10) || 0,
      completed: parseInt(matchStats.completed_matches, 10) || 0,
      scheduled: parseInt(matchStats.scheduled_matches, 10) || 0
    },
    teamsCount: parseInt(teamRows[0]?.registered_teams, 10) || 0,
    playerRegistrationsCount: parseInt(playerRows[0]?.registered_players, 10) || 0,
    auctionCount: parseInt(auctionRows[0]?.auction_count, 10) || 0,
    hasActiveMatches: (parseInt(matchStats.live_matches, 10) || 0) > 0,
    hasCompletedRecords: (parseInt(matchStats.completed_matches, 10) || 0) > 0
  };

  return {
    success: true,
    data: impactData,
    ...impactData
  };
};

/**
 * 17. Safely delete tournament and all dependent child records in a transaction
 */
const deleteTournament = async ({ tournamentId, user, force = false }) => {
  const isTournNum = /^\d+$/.test(String(tournamentId).trim());
  const rows = await db.query(
    'SELECT t.*, v.owner_id as venue_owner_id FROM tournaments t LEFT JOIN venues v ON t.venue_id = v.id WHERE t.uuid = ? OR (t.id = ? AND ? > 0)',
    [tournamentId, isTournNum ? parseInt(tournamentId, 10) : -1, isTournNum ? parseInt(tournamentId, 10) : -1]
  );
  if (!rows || rows.length === 0) {
    throw { statusCode: 404, message: 'Tournament not found' };
  }
  const tournament = rows[0];

  const isSuperAdmin = user.role === 'ADMIN' || user.role === 'SUPER_ADMIN';
  const isCreator = (tournament.created_by && String(tournament.created_by) === String(user.id)) ||
                    (tournament.venue_owner_id && String(tournament.venue_owner_id) === String(user.id));

  if (!isSuperAdmin && !isCreator) {
    throw { statusCode: 403, message: 'Access denied. Only the tournament creator or a superadmin can delete this tournament.' };
  }

  // Safety safeguard if live matches exist and force is not set
  const [liveCheck] = await db.query(
    "SELECT COUNT(*) as live_count FROM tournament_matches WHERE tournament_id = ? AND status = 'LIVE'",
    [tournament.id]
  );
  if (liveCheck?.live_count > 0 && !force) {
    return {
      success: false,
      requiresConfirmation: true,
      message: `Tournament "${tournament.name}" currently has ${liveCheck.live_count} active LIVE match(es). Ending live matches is required or confirm force deletion to proceed.`
    };
  }

  // Run full deletion cascade inside db.transaction
  await db.transaction(async (conn) => {
    const tId = tournament.id;

    // 1. Get all matches belonging to tournament
    const matchesRes = await conn.query('SELECT id FROM tournament_matches WHERE tournament_id = ?', [tId]);
    const matchesList = Array.isArray(matchesRes[0]) ? matchesRes[0] : matchesRes;
    const matchIds = Array.isArray(matchesList) ? matchesList.map(m => m.id).filter(Boolean) : [];

    if (matchIds.length > 0) {
      const matchInClause = matchIds.join(',');
      await conn.query(`DELETE FROM cricket_balls WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM cricket_innings WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM cricket_matches WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM match_players WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM score_events WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM score_corrections WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM pickleball_score_logs WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM sport_match_events WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM scoring_undo_audit WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM match_mentions WHERE match_id IN (${matchInClause})`);
      await conn.query(`DELETE FROM tournament_scorers WHERE tournament_id = ? OR match_id IN (${matchInClause})`, [tId]);
      await conn.query('DELETE FROM tournament_matches WHERE tournament_id = ?', [tId]);
    } else {
      await conn.query('DELETE FROM tournament_scorers WHERE tournament_id = ?', [tId]);
      await conn.query('DELETE FROM tournament_matches WHERE tournament_id = ?', [tId]);
    }

    // 2. Clean up auction records if any
    const auctionsRes = await conn.query('SELECT id FROM tournament_auctions WHERE tournament_id = ?', [tId]);
    const auctionsList = Array.isArray(auctionsRes[0]) ? auctionsRes[0] : auctionsRes;
    const auctionIds = Array.isArray(auctionsList) ? auctionsList.map(a => a.id).filter(Boolean) : [];
    if (auctionIds.length > 0) {
      const auctionInClause = auctionIds.join(',');
      await conn.query(`DELETE FROM auction_audit_logs WHERE auction_id IN (${auctionInClause})`);
      await conn.query(`DELETE FROM auction_bids WHERE auction_id IN (${auctionInClause})`);
      await conn.query(`DELETE FROM auction_squads WHERE auction_id IN (${auctionInClause})`);
      await conn.query(`DELETE FROM auction_players WHERE auction_id IN (${auctionInClause})`);
      await conn.query(`DELETE FROM auction_teams WHERE auction_id IN (${auctionInClause})`);
      await conn.query(`DELETE FROM auction_categories WHERE auction_id IN (${auctionInClause})`);
      await conn.query('DELETE FROM tournament_auctions WHERE tournament_id = ?', [tId]);
    }

    // 3. Clean up points table, rounds, awards, registrations
    await conn.query('DELETE FROM points_table WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_rounds WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_awards WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_player_registrations WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_player_registration_configs WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_teams WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tv_displays WHERE tournament_id = ?', [tId]);
    await conn.query('DELETE FROM tournament_audit_logs WHERE tournament_id = ?', [tId]);

    // 4. Safely unlink advertisements and teams without deleting the teams themselves
    await conn.query('UPDATE advertisements SET tournament_id = NULL WHERE tournament_id = ?', [tId]);
    await conn.query('UPDATE teams SET tournament_id = NULL WHERE tournament_id = ?', [tId]);

    // 5. Delete tournament record
    await conn.query('DELETE FROM tournaments WHERE id = ?', [tId]);
  });

  // Real-time broadcast
  try {
    const { getIO } = require('./socketService');
    const io = getIO();
    if (io) {
      io.emit('tournament:deleted', {
        tournamentId: tournament.uuid,
        id: tournament.id,
        name: tournament.name
      });
    }
  } catch (wsErr) {
    console.warn('WebSocket broadcast error on delete:', wsErr);
  }

  return {
    success: true,
    message: `Tournament "${tournament.name}" deleted successfully.`
  };
};

module.exports = {
  getTournamentsPaginated,
  getTournamentByPublicId,
  getTournamentLiveMatches,
  getTournamentFixtures,
  getTournamentTeams,
  getTournamentTeamRoster,
  addPlayerToTournamentTeamRoster,
  createTournament,
  getTeamRemovalImpact,
  removeTeamFromTournament,
  bulkAddTeamsToTournament,
  updatePlayerInTournamentTeamRoster,
  removePlayerFromTournamentTeamRoster,
  updateTournamentMatchDisplay,
  bulkUpdateTournamentMatchesDisplay,
  updateTournamentCourtColor,
  getTournamentDeleteImpact,
  deleteTournament
};
