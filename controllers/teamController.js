const db = require('../config/database');
const { getIO } = require('../services/socketService');

/**
 * Helper to resolve all venue IDs owned by the authenticated user
 */
const getOwnerVenueIds = async (userId) => {
  const venues = await db.query('SELECT id FROM venues WHERE owner_id = ?', [userId]);
  return venues.map((v) => v.id);
};

/**
 * Helper to resolve team entity from UUID or ID
 */
const resolveTeam = async (idOrUuid) => {
  const isNum = /^\d+$/.test(String(idOrUuid).trim());
  const rows = await db.query(
    `SELECT t.*, s.name as sport_name, s.slug as sport_slug,
            v.name as venue_name, v.city as venue_city,
            u.full_name as captain_name,
            tourn.name as tournament_name
     FROM teams t
     LEFT JOIN sports s ON t.sport_id = s.id
     LEFT JOIN venues v ON t.venue_id = v.id
     LEFT JOIN users u ON t.captain_id = u.id
     LEFT JOIN tournaments tourn ON t.tournament_id = tourn.id
     WHERE t.uuid = ? OR t.id = ?`,
    [idOrUuid, isNum ? parseInt(idOrUuid, 10) : -1]
  );
  if (!rows || rows.length === 0) return null;
  return rows[0];
};

/**
 * 1. GET /api/teams/my-teams (Protected, Multi-Tenant Isolated)
 */
const getMyTeams = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    let teamsQuery = '';
    let queryParams = [];

    if (userRole === 'VENUE_OWNER') {
      const venueIds = await getOwnerVenueIds(userId);
      const venuePlaceholders = venueIds.length > 0 ? venueIds.map(() => '?').join(',') : 'NULL';

      teamsQuery = `
        SELECT 
          t.id as _internal_id,
          t.uuid as id,
          t.name,
          t.logo_url as logoUrl,
          t.description,
          t.division,
          t.status,
          t.owner_id,
          t.venue_id,
          v.name as venue_name,
          v.city as venue_city,
          s.name as sport_name,
          s.slug as sport_slug,
          u.full_name as captain_name,
          (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as member_count,
          COALESCE(SUM(pt.matches_played), 0) as matches_played,
          COALESCE(SUM(pt.won), 0) as won,
          COALESCE(SUM(pt.lost), 0) as lost,
          COALESCE(SUM(COALESCE(pt.drawn, pt.tied, 0)), 0) as drawn
        FROM teams t
        LEFT JOIN venues v ON t.venue_id = v.id
        LEFT JOIN sports s ON t.sport_id = s.id
        LEFT JOIN users u ON t.captain_id = u.id
        LEFT JOIN points_table pt ON pt.team_id = t.id
        WHERE t.owner_id = ? OR t.venue_id IN (${venuePlaceholders})
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `;
      queryParams = [userId, ...venueIds];
    } else if (userRole === 'ADMIN') {
      teamsQuery = `
        SELECT 
          t.id as _internal_id,
          t.uuid as id,
          t.name,
          t.logo_url as logoUrl,
          t.description,
          t.division,
          t.status,
          t.owner_id,
          t.venue_id,
          v.name as venue_name,
          v.city as venue_city,
          s.name as sport_name,
          s.slug as sport_slug,
          u.full_name as captain_name,
          (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as member_count,
          COALESCE(SUM(pt.matches_played), 0) as matches_played,
          COALESCE(SUM(pt.won), 0) as won,
          COALESCE(SUM(pt.lost), 0) as lost,
          COALESCE(SUM(COALESCE(pt.drawn, pt.tied, 0)), 0) as drawn
        FROM teams t
        LEFT JOIN venues v ON t.venue_id = v.id
        LEFT JOIN sports s ON t.sport_id = s.id
        LEFT JOIN users u ON t.captain_id = u.id
        LEFT JOIN points_table pt ON pt.team_id = t.id
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `;
      queryParams = [];
    } else {
      teamsQuery = `
        SELECT DISTINCT
          t.id as _internal_id,
          t.uuid as id,
          t.name,
          t.logo_url as logoUrl,
          t.description,
          t.division,
          t.status,
          t.owner_id,
          t.venue_id,
          v.name as venue_name,
          v.city as venue_city,
          s.name as sport_name,
          s.slug as sport_slug,
          u.full_name as captain_name,
          (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as member_count,
          COALESCE(SUM(pt.matches_played), 0) as matches_played,
          COALESCE(SUM(pt.won), 0) as won,
          COALESCE(SUM(pt.lost), 0) as lost,
          COALESCE(SUM(COALESCE(pt.drawn, pt.tied, 0)), 0) as drawn
        FROM teams t
        LEFT JOIN venues v ON t.venue_id = v.id
        LEFT JOIN sports s ON t.sport_id = s.id
        LEFT JOIN users u ON t.captain_id = u.id
        LEFT JOIN team_members mem ON mem.team_id = t.id
        LEFT JOIN points_table pt ON pt.team_id = t.id
        WHERE t.captain_id = ? OR mem.user_id = ?
        GROUP BY t.id
        ORDER BY t.created_at DESC
      `;
      queryParams = [userId, userId];
    }

    const rows = await db.query(teamsQuery, queryParams);

    const items = rows.map((r) => ({
      id: r.id,
      name: r.name,
      logoUrl: r.logoUrl,
      description: r.description,
      division: r.division || 'Open',
      status: r.status,
      sport: {
        name: r.sport_name || 'Cricket',
        slug: r.sport_slug || 'cricket'
      },
      venue: r.venue_name ? { name: r.venue_name, city: r.venue_city } : null,
      captainName: r.captain_name,
      memberCount: parseInt(r.member_count, 10) || 0,
      matchesPlayed: parseInt(r.matches_played, 10) || 0,
      won: parseInt(r.won, 10) || 0,
      lost: parseInt(r.lost, 10) || 0,
      drawn: parseInt(r.drawn, 10) || 0
    }));

    res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

/**
 * 2. GET /api/teams (Public Discovery Feed with Search and Filtering)
 */
const discoverTeams = async (req, res, next) => {
  try {
    const { city, sportSlug, search, tournamentId, limit = 50 } = req.query;
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    const conditions = ["t.status = 'ACTIVE'"];
    const params = [];

    if (city) {
      conditions.push('v.city = ?');
      params.push(city);
    }
    if (sportSlug) {
      conditions.push('s.slug = ?');
      params.push(sportSlug);
    }
    if (tournamentId) {
      conditions.push('t.tournament_id = ?');
      params.push(tournamentId);
    }
    if (search) {
      conditions.push('(t.name LIKE ? OR v.city LIKE ? OR u.full_name LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const sql = `
      SELECT 
        t.uuid as id,
        t.name,
        t.logo_url as logoUrl,
        t.description,
        t.division,
        t.status,
        v.name as venue_name,
        v.city as venue_city,
        s.name as sport_name,
        s.slug as sport_slug,
        u.full_name as captain_name,
        tourn.name as tournament_name,
        (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as member_count,
        COALESCE(SUM(pt.matches_played), 0) as matches_played,
        COALESCE(SUM(pt.won), 0) as won,
        COALESCE(SUM(pt.lost), 0) as lost,
        COALESCE(SUM(COALESCE(pt.drawn, pt.tied, 0)), 0) as drawn
      FROM teams t
      LEFT JOIN venues v ON t.venue_id = v.id
      LEFT JOIN sports s ON t.sport_id = s.id
      LEFT JOIN users u ON t.captain_id = u.id
      LEFT JOIN tournaments tourn ON t.tournament_id = tourn.id
      LEFT JOIN points_table pt ON pt.team_id = t.id
      ${whereClause}
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT ?
    `;

    params.push(safeLimit);
    const rows = await db.query(sql, params);

    const items = rows.map((r) => {
      const p = parseInt(r.matches_played, 10) || 0;
      const w = parseInt(r.won, 10) || 0;
      const winRate = p > 0 ? ((w / p) * 100).toFixed(0) : '0';

      return {
        id: r.id,
        name: r.name,
        logoUrl: r.logoUrl,
        description: r.description,
        division: r.division || 'Open',
        status: r.status,
        sport: {
          name: r.sport_name || 'Cricket',
          slug: r.sport_slug || 'cricket'
        },
        venue: r.venue_name ? { name: r.venue_name, city: r.venue_city } : null,
        captainName: r.captain_name || 'Not Assigned',
        tournamentName: r.tournament_name || null,
        memberCount: parseInt(r.member_count, 10) || 0,
        matchesPlayed: p,
        won: w,
        lost: parseInt(r.lost, 10) || 0,
        drawn: parseInt(r.drawn, 10) || 0,
        winPercentage: `${winRate}%`
      };
    });

    res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

/**
 * 3. GET /api/teams/:id (Single Team Details, Roster, Stats, and Recent Fixtures)
 */
const getTeamById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await resolveTeam(id);

    if (!team) {
      return res.status(404).json({ success: false, message: 'Team not found.' });
    }

    const callerId = req.user?.id;
    const callerRole = req.user?.role;

    // Check manage authorization
    let canManage = false;
    if (callerRole === 'ADMIN') {
      canManage = true;
    } else if (callerId) {
      if (team.owner_id === callerId || team.captain_id === callerId) {
        canManage = true;
      } else if (callerRole === 'VENUE_OWNER') {
        const ownedVenues = await getOwnerVenueIds(callerId);
        if (team.venue_id && ownedVenues.includes(team.venue_id)) {
          canManage = true;
        }
      }
    }

    // 1. Fetch Roster Members with user photos, usernames, roles, jerseys, positions
    const members = await db.query(
      `SELECT tm.id as member_id, tm.user_id, tm.role, tm.jersey_number, tm.position,
              tm.is_captain, tm.is_vice_captain, tm.joined_at,
              COALESCE(u.full_name, tm.player_name, 'Player') as name,
              u.username,
              COALESCE(u.profile_photo, tm.photo_url) as profile_photo,
              u.dob, u.primary_sport_slug, u.experience_level
       FROM team_members tm
       LEFT JOIN users u ON tm.user_id = u.id
       WHERE tm.team_id = ?
       ORDER BY tm.is_captain DESC, tm.is_vice_captain DESC, tm.id ASC`,
      [team.id]
    );

    // 2. Fetch Team Record & Scoring Stats
    const ptRows = await db.query(
      `SELECT SUM(matches_played) as total_played,
              SUM(won) as total_won,
              SUM(lost) as total_lost,
              SUM(COALESCE(drawn, tied, 0)) as total_drawn,
              SUM(COALESCE(points_scored, goals_for, 0)) as total_scored,
              SUM(COALESCE(points_conceded, goals_against, 0)) as total_conceded
       FROM points_table WHERE team_id = ?`,
      [team.id]
    );

    const pt = ptRows[0] || {};
    const matchesPlayed = parseInt(pt.total_played, 10) || 0;
    const won = parseInt(pt.total_won, 10) || 0;
    const lost = parseInt(pt.total_lost, 10) || 0;
    const drawn = parseInt(pt.total_drawn, 10) || 0;
    const scored = parseInt(pt.total_scored, 10) || 0;
    const conceded = parseInt(pt.total_conceded, 10) || 0;
    const winRate = matchesPlayed > 0 ? ((won / matchesPlayed) * 100).toFixed(0) : '0';

    // 3. Fetch Recent Matches and Upcoming Fixtures
    const matches = await db.query(
      `SELECT tm.id, tm.uuid as match_id, tm.match_number, tm.match_date, tm.start_time,
              tm.status, tm.live_score_summary, tm.result_summary,
              t.name as tournament_name, c.name as court_name,
              opp.uuid as opponent_uuid, opp.name as opponent_name, opp.logo_url as opponent_logo,
              tm.team_a_id, tm.team_b_id
       FROM tournament_matches tm
       LEFT JOIN tournaments t ON tm.tournament_id = t.id
       LEFT JOIN courts c ON tm.court_id = c.id
       LEFT JOIN teams opp ON (CASE WHEN tm.team_a_id = ? THEN tm.team_b_id ELSE tm.team_a_id END) = opp.id
       WHERE tm.team_a_id = ? OR tm.team_b_id = ?
       ORDER BY tm.match_date DESC, tm.start_time DESC
       LIMIT 10`,
      [team.id, team.id, team.id]
    );

    const recentMatches = matches.filter(m => m.status === 'COMPLETED');
    const upcomingFixtures = matches.filter(m => m.status === 'SCHEDULED' || m.status === 'LIVE');

    res.json({
      success: true,
      data: {
        id: team.uuid,
        name: team.name,
        logoUrl: team.logo_url,
        description: team.description,
        division: team.division || 'Open',
        coachName: team.coach_name || null,
        contactPhone: team.contact_phone || null,
        homeLocation: team.home_location || null,
        status: team.status,
        sport: {
          name: team.sport_name || 'Cricket',
          slug: team.sport_slug || 'cricket'
        },
        venue: team.venue_name ? { name: team.venue_name, city: team.venue_city } : null,
        captain: {
          id: team.captain_id,
          name: team.captain_name || 'Not Assigned'
        },
        tournamentName: team.tournament_name || null,
        memberCount: members.length,
        canManage,
        statistics: {
          matchesPlayed,
          won,
          lost,
          drawn,
          scored,
          conceded,
          winPercentage: `${winRate}%`
        },
        members: members.map(m => ({
          memberId: m.member_id,
          userId: m.user_id,
          name: m.name,
          username: m.username || (m.user_id ? `user_${m.user_id}` : null),
          profilePhoto: m.profile_photo || null,
          role: m.role || 'PLAYER',
          position: m.position || 'Player',
          jerseyNumber: m.jersey_number,
          isCaptain: Boolean(m.is_captain),
          isViceCaptain: Boolean(m.is_vice_captain),
          experienceLevel: m.experience_level || 'Club',
          joinedAt: m.joined_at
        })),
        recentMatches: recentMatches.map(m => ({
          id: m.match_id,
          matchNumber: m.match_number,
          date: m.match_date,
          tournamentName: m.tournament_name,
          opponent: m.opponent_name || 'Opponent',
          opponentLogo: m.opponent_logo,
          scoreSummary: m.live_score_summary,
          result: m.result_summary || 'Completed'
        })),
        upcomingFixtures: upcomingFixtures.map(m => ({
          id: m.match_id,
          matchNumber: m.match_number,
          date: m.match_date,
          startTime: m.start_time,
          courtName: m.court_name,
          tournamentName: m.tournament_name,
          opponent: m.opponent_name || 'Opponent',
          opponentLogo: m.opponent_logo,
          status: m.status
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 4. POST /api/teams (Create Team with Full Metadata & Optional Initial Squad)
 */
const createTeam = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    const {
      name,
      logoUrl,
      description,
      sportId = 1,
      sportSlug,
      venueId,
      tournamentId,
      division = 'Open',
      coachName,
      contactPhone,
      homeLocation,
      captainId,
      status = 'ACTIVE',
      initialPlayers = []
    } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ success: false, message: 'Team name is required.' });
    }

    let resolvedSportId = sportId;
    if (sportSlug) {
      const [sp] = await db.query('SELECT id FROM sports WHERE slug = ?', [sportSlug]);
      if (sp) resolvedSportId = sp.id;
    }

    let assignedOwnerId = userId;
    let assignedVenueId = null;

    if (userRole === 'VENUE_OWNER') {
      const ownedVenueIds = await getOwnerVenueIds(userId);
      if (venueId) {
        if (!ownedVenueIds.includes(parseInt(venueId, 10))) {
          return res.status(403).json({
            success: false,
            message: 'Forbidden: You can only assign teams to venues you own.'
          });
        }
        assignedVenueId = parseInt(venueId, 10);
      } else if (ownedVenueIds.length > 0) {
        assignedVenueId = ownedVenueIds[0];
      }
    } else {
      assignedVenueId = venueId || null;
    }

    const assignedCaptainId = captainId || userId;

    // Create Team
    const insertRes = await db.query(
      `INSERT INTO teams (
        uuid, name, logo_url, captain_id, owner_id, venue_id, sport_id,
        description, division, coach_name, contact_phone, home_location,
        tournament_id, status
      ) VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name.trim(),
        logoUrl || null,
        assignedCaptainId,
        assignedOwnerId,
        assignedVenueId,
        resolvedSportId,
        description || null,
        division || 'Open',
        coachName || null,
        contactPhone || null,
        homeLocation || null,
        tournamentId || null,
        status || 'ACTIVE'
      ]
    );

    const teamId = insertRes.insertId;
    const [teamRow] = await db.query('SELECT id, uuid, name, logo_url FROM teams WHERE id = ?', [teamId]);

    // Seed Initial Squad Players if provided
    if (Array.isArray(initialPlayers) && initialPlayers.length > 0) {
      for (const p of initialPlayers) {
        let pUserId = p.userId;
        const pName = typeof p === 'string' ? p : (p.fullName || p.name);

        if (!pUserId && pName) {
          // Check for existing user or create one
          const [existingUser] = await db.query(
            `SELECT id FROM users WHERE full_name = ? OR (phone = ? AND phone IS NOT NULL)`,
            [pName.trim(), p.phone || '']
          );
          if (existingUser) {
            pUserId = existingUser.id;
          } else {
            const userIns = await db.query(
              `INSERT INTO users (full_name, phone, email, password_hash, status)
               VALUES (?, ?, ?, 'NOPASSWORD', 'ACTIVE')`,
              [pName.trim(), p.phone || null, p.email || null]
            );
            pUserId = userIns.insertId;
          }
        }

        if (pUserId) {
          await db.query(
            `INSERT INTO team_members (team_id, user_id, role, jersey_number, position, player_name)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              teamId,
              pUserId,
              p.role || 'PLAYER',
              p.jerseyNumber || null,
              p.position || 'Player',
              pName || 'Player'
            ]
          );
        }
      }
    }

    // Socket notification
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('team:created', {
        id: teamRow.uuid,
        name: teamRow.name,
        logoUrl: teamRow.logo_url
      });
    }

    res.status(201).json({
      success: true,
      message: 'Team created successfully!',
      data: {
        id: teamRow.uuid,
        name: teamRow.name,
        logoUrl: teamRow.logo_url
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 5. PUT /api/teams/:id (Update Team Metadata)
 */
const updateTeam = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== 'ADMIN' && team.owner_id !== userId && team.captain_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden. You do not have permission to edit this team.' });
    }

    const {
      name,
      logoUrl,
      description,
      division,
      coachName,
      contactPhone,
      homeLocation,
      tournamentId,
      status,
      captainId
    } = req.body;

    await db.query(
      `UPDATE teams SET
        name = COALESCE(?, name),
        logo_url = COALESCE(?, logo_url),
        description = COALESCE(?, description),
        division = COALESCE(?, division),
        coach_name = COALESCE(?, coach_name),
        contact_phone = COALESCE(?, contact_phone),
        home_location = COALESCE(?, home_location),
        tournament_id = COALESCE(?, tournament_id),
        status = COALESCE(?, status),
        captain_id = COALESCE(?, captain_id)
       WHERE id = ?`,
      [
        name ? name.trim() : null,
        logoUrl,
        description,
        division,
        coachName,
        contactPhone,
        homeLocation,
        tournamentId,
        status,
        captainId,
        team.id
      ]
    );

    res.json({ success: true, message: 'Team updated successfully!' });
  } catch (error) {
    next(error);
  }
};

/**
 * 6. DELETE /api/teams/:id (Delete Team)
 */
const deleteTeam = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    if (req.user.role !== 'ADMIN' && team.owner_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    await db.query('DELETE FROM teams WHERE id = ?', [team.id]);
    res.json({ success: true, message: 'Team deleted successfully!' });
  } catch (error) {
    next(error);
  }
};

/**
 * 7. POST /api/teams/:id/players (Add Player to Team Roster)
 * Reuses existing player identities to avoid duplicate records!
 */
const addPlayerToTeam = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const userId = req.user.id;
    const userRole = req.user.role;

    if (userRole !== 'ADMIN' && team.owner_id !== userId && team.captain_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden. Only organizers/captains can manage squad rosters.' });
    }

    const {
      userId: targetUserId,
      fullName,
      username,
      phone,
      email,
      role = 'PLAYER',
      jerseyNumber,
      position = 'Player',
      isCaptain = false,
      isViceCaptain = false,
      photoUrl: initialPhotoUrl
    } = req.body;

    let finalUserId = targetUserId;
    let uploadedPhotoUrl = initialPhotoUrl || null;

    // Process photo if file uploaded via multipart
    if (req.file) {
      const { processAvatarImage } = require('../services/imageService');
      const processed = await processAvatarImage(req.file.path, `player-t${team.id}-${Date.now()}`);
      uploadedPhotoUrl = processed.url;
    }

    const { normalizeUsername, checkUsernameAvailability } = require('../services/usernameService');

    // Search existing player before creating a duplicate!
    if (!finalUserId) {
      if (!fullName || fullName.trim().length === 0) {
        return res.status(400).json({ success: false, message: 'Player name or user ID is required.' });
      }

      // Check by username first if provided
      if (username && username.trim()) {
        const [existingByUsername] = await db.query(
          `SELECT id, full_name, username, profile_photo FROM users WHERE LOWER(username) = ?`,
          [username.trim().toLowerCase()]
        );
        if (existingByUsername) {
          finalUserId = existingByUsername.id;
        }
      }

      // Check by phone or email or name
      if (!finalUserId) {
        const conditions = [];
        const params = [];
        if (phone && phone.trim()) {
          conditions.push('phone = ?');
          params.push(phone.trim());
        }
        if (email && email.trim()) {
          conditions.push('email = ?');
          params.push(email.trim());
        }
        if (conditions.length === 0) {
          conditions.push('full_name = ?');
          params.push(fullName.trim());
        }

        const existingUsers = await db.query(
          `SELECT id, full_name, username, profile_photo FROM users WHERE ${conditions.join(' OR ')} LIMIT 1`,
          params
        );

        if (existingUsers && existingUsers.length > 0) {
          finalUserId = existingUsers[0].id;
        } else {
          // Generate unique username
          let targetUsername = username;
          if (targetUsername) {
            const check = await checkUsernameAvailability(targetUsername);
            if (!check.valid) {
              return res.status(400).json({ success: false, message: check.reason });
            }
            if (!check.available) {
              return res.status(409).json({
                success: false,
                message: 'This username is already taken. Please choose another username.',
                suggestions: check.suggestions
              });
            }
            targetUsername = check.normalized;
          } else {
            let base = normalizeUsername(fullName || 'player');
            if (base.length < 3) base = `player_${Date.now().toString().slice(-4)}`;
            let candidate = base;
            let counter = 1;
            while (true) {
              const existing = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [candidate]);
              if (existing.length === 0) break;
              candidate = `${base}_${counter++}`;
            }
            targetUsername = candidate;
          }

          // Create new player record in users table
          const insertUser = await db.query(
            `INSERT INTO users (full_name, username, phone, email, password_hash, primary_position, jersey_number, profile_photo, status)
             VALUES (?, ?, ?, ?, 'NOPASSWORD', ?, ?, ?, 'ACTIVE')`,
            [fullName.trim(), targetUsername, phone || null, email || null, position || 'Player', jerseyNumber || null, uploadedPhotoUrl]
          );
          finalUserId = insertUser.insertId;
        }
      }
    }

    // Check if player is already registered in this team
    const [alreadyInTeam] = await db.query(
      `SELECT id FROM team_members WHERE team_id = ? AND user_id = ?`,
      [team.id, finalUserId]
    );

    if (alreadyInTeam) {
      return res.status(400).json({ success: false, message: 'Player is already a registered member of this team.' });
    }

    const [userRecord] = await db.query(`SELECT full_name, username, profile_photo FROM users WHERE id = ?`, [finalUserId]);
    const finalPhoto = uploadedPhotoUrl || userRecord?.profile_photo || null;

    const memberIns = await db.query(
      `INSERT INTO team_members (
        team_id, user_id, role, jersey_number, position,
        is_captain, is_vice_captain, player_name, photo_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        team.id,
        finalUserId,
        role,
        jerseyNumber || null,
        position || 'Player',
        isCaptain ? 1 : 0,
        isViceCaptain ? 1 : 0,
        userRecord?.full_name || fullName || 'Player',
        finalPhoto
      ]
    );

    // If marked captain, update team's captain_id
    if (isCaptain || role === 'CAPTAIN') {
      await db.query(`UPDATE teams SET captain_id = ? WHERE id = ?`, [finalUserId, team.id]);
    }

    const memberCountRes = await db.query(
      `SELECT COUNT(*) as count FROM team_members WHERE team_id = ?`,
      [team.id]
    );

    res.status(201).json({
      success: true,
      message: `Player "${userRecord?.full_name || fullName}" added to roster!`,
      data: {
        memberId: memberIns.insertId,
        userId: finalUserId,
        name: userRecord?.full_name || fullName,
        username: userRecord?.username || (finalUserId ? `user_${finalUserId}` : null),
        profilePhoto: finalPhoto,
        role,
        position,
        jerseyNumber,
        isCaptain: Boolean(isCaptain),
        isViceCaptain: Boolean(isViceCaptain),
        totalRosterSize: memberCountRes[0]?.count || 1
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 8. PUT /api/teams/:id/players/:memberId (Update Team Player Role / Position)
 */
const updateTeamPlayer = async (req, res, next) => {
  try {
    const { id, memberId } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const userId = req.user.id;
    if (req.user.role !== 'ADMIN' && team.owner_id !== userId && team.captain_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const { role, jerseyNumber, position, isCaptain, isViceCaptain } = req.body;

    await db.query(
      `UPDATE team_members SET
        role = COALESCE(?, role),
        jersey_number = COALESCE(?, jersey_number),
        position = COALESCE(?, position),
        is_captain = COALESCE(?, is_captain),
        is_vice_captain = COALESCE(?, is_vice_captain)
       WHERE id = ? AND team_id = ?`,
      [role, jerseyNumber, position, isCaptain != null ? (isCaptain ? 1 : 0) : null, isViceCaptain != null ? (isViceCaptain ? 1 : 0) : null, memberId, team.id]
    );

    res.json({ success: true, message: 'Player details updated successfully!' });
  } catch (error) {
    next(error);
  }
};

/**
 * 9. DELETE /api/teams/:id/players/:memberId (Remove Player from Roster)
 * Historical match statistics remain intact!
 */
const removePlayerFromTeam = async (req, res, next) => {
  try {
    const { id, memberId } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const userId = req.user.id;
    if (req.user.role !== 'ADMIN' && team.owner_id !== userId && team.captain_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    await db.query(`DELETE FROM team_members WHERE id = ? AND team_id = ?`, [memberId, team.id]);

    const memberCountRes = await db.query(
      `SELECT COUNT(*) as count FROM team_members WHERE team_id = ?`,
      [team.id]
    );

    res.json({
      success: true,
      message: 'Player removed from squad roster.',
      totalRosterSize: memberCountRes[0]?.count || 0
    });
  } catch (error) {
    next(error);
  }
};

/**
 * 10. POST /api/teams/:id/players/bulk (Bulk Import Players to Team)
 */
const bulkAddPlayers = async (req, res, next) => {
  try {
    const { id } = req.params;
    const team = await resolveTeam(id);
    if (!team) return res.status(404).json({ success: false, message: 'Team not found.' });

    const { players = [] } = req.body;
    if (!Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ success: false, message: 'No players provided.' });
    }

    let addedCount = 0;
    for (const p of players) {
      const pName = typeof p === 'string' ? p : (p.fullName || p.name);
      if (!pName || !pName.trim()) continue;

      let pUserId = p.userId;
      if (!pUserId) {
        const [existing] = await db.query(`SELECT id FROM users WHERE full_name = ? LIMIT 1`, [pName.trim()]);
        if (existing) {
          pUserId = existing.id;
        } else {
          const userIns = await db.query(
            `INSERT INTO users (full_name, status) VALUES (?, 'ACTIVE')`,
            [pName.trim()]
          );
          pUserId = userIns.insertId;
        }
      }

      const [inRoster] = await db.query(
        `SELECT id FROM team_members WHERE team_id = ? AND user_id = ?`,
        [team.id, pUserId]
      );

      if (!inRoster) {
        await db.query(
          `INSERT INTO team_members (team_id, user_id, role, position, player_name)
           VALUES (?, ?, 'PLAYER', 'Player', ?)`,
          [team.id, pUserId, pName.trim()]
        );
        addedCount++;
      }
    }

    res.json({ success: true, message: `Successfully added ${addedCount} players to squad!`, addedCount });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyTeams,
  discoverTeams,
  getTeamById,
  createTeam,
  updateTeam,
  deleteTeam,
  addPlayerToTeam,
  updateTeamPlayer,
  removePlayerFromTeam,
  bulkAddPlayers
};
