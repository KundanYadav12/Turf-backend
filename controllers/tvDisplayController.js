const db = require('../config/database');
const tournamentService = require('../services/tournamentService');
const advertisementService = require('../services/advertisementService');
const { broadcastSignageEvent } = require('../services/socketService');

/**
 * Generate a random 6-character alphanumeric pairing code (excluding confusing chars like 0, O, 1, I)
 */
function generatePairingCode() {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * 1. Public: Get complete display data for Smart TV full-screen mode
 * Resolves by TV display UUID, numeric ID, tournament UUID, or tournament ID
 */
async function getDisplayData(req, res, next) {
  try {
    const { displayId } = req.params;
    let tvConfig = null;
    let tournamentId = null;

    // 1. Try to find existing TV display by UUID or ID
    const displays = await db.query(`
      SELECT * FROM tv_displays WHERE uuid = ? OR id = ?
    `, [displayId, /^\d+$/.test(displayId) ? parseInt(displayId, 10) : -1]);

    if (displays.length > 0) {
      tvConfig = displays[0];
      tournamentId = tvConfig.tournament_id;
      // Update last seen
      await db.query('UPDATE tv_displays SET last_seen_at = NOW() WHERE id = ?', [tvConfig.id]);
    } else {
      // 2. Check if displayId matches a tournament UUID or ID
      const tournaments = await db.query(`
        SELECT id, uuid, name FROM tournaments WHERE uuid = ? OR id = ?
      `, [displayId, /^\d+$/.test(displayId) ? parseInt(displayId, 10) : -1]);

      if (tournaments.length > 0) {
        tournamentId = tournaments[0].id;
        // Default virtual TV config for this tournament
        tvConfig = {
          id: null,
          uuid: `tv_tourn_${tournaments[0].uuid}`,
          name: `${tournaments[0].name} TV Display`,
          tournament_id: tournamentId,
          layout_type: 'AUTO',
          match_count: 4,
          rotation_enabled: true,
          rotation_interval: 15,
          active_scenes: ['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'SPONSORS', 'RESULTS'],
          ad_top_enabled: true,
          ad_bottom_enabled: true,
          ad_sidebars_enabled: true,
          ad_center_enabled: false,
          theme: 'dark',
          animation_speed: 'normal'
        };
      } else {
        // Fallback: Pick default active tournament
        const defaultTourns = await db.query('SELECT id, uuid, name FROM tournaments ORDER BY id ASC LIMIT 1');
        if (defaultTourns.length > 0) {
          tournamentId = defaultTourns[0].id;
          tvConfig = {
            id: null,
            uuid: 'tv_default_preview',
            name: `${defaultTourns[0].name} Live TV`,
            tournament_id: tournamentId,
            layout_type: 'AUTO',
            match_count: 4,
            rotation_enabled: true,
            rotation_interval: 15,
            active_scenes: ['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'SPONSORS', 'RESULTS'],
            ad_top_enabled: true,
            ad_bottom_enabled: true,
            ad_sidebars_enabled: true,
            ad_center_enabled: false,
            theme: 'dark',
            animation_speed: 'normal'
          };
        }
      }
    }

    if (!tournamentId) {
      return res.status(404).json({
        success: false,
        message: 'No active tournament or display found for this identifier.'
      });
    }

    // 2. Fetch Tournament Details
    const tourRows = await db.query(`
      SELECT t.*, s.name as sport_name, s.slug as sport_slug, v.name as venue_name, v.city as venue_city
      FROM tournaments t
      LEFT JOIN sports s ON t.sport_id = s.id
      LEFT JOIN venues v ON t.venue_id = v.id
      WHERE t.id = ?
    `, [tournamentId]);

    const tournament = tourRows[0] || null;

    // 3. Fetch Live Matches
    let liveMatches = await tournamentService.getTournamentLiveMatches(tournamentId);

    // If show_completed_matches is enabled or there are fewer live matches than match_count,
    // fetch upcoming or recently completed matches to provide a populated TV grid
    if (liveMatches.length < (tvConfig.match_count || 4)) {
      const extraNeeded = (tvConfig.match_count || 4) - liveMatches.length;
      const extraRows = await db.query(`
        SELECT 
          tm.id as match_id, tm.uuid as match_uuid, tm.match_number, tm.status,
          tm.live_score_summary, tm.live_subtext, tm.sport_state,
          c.name as court_name, v.name as venue_name,
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
        WHERE tm.tournament_id = ? AND tm.status != 'LIVE'
        ORDER BY 
          CASE 
            WHEN tm.status = 'COMPLETED' THEN 1
            WHEN tm.status = 'SCHEDULED' THEN 2
            ELSE 3
          END,
          tm.match_number ASC
        LIMIT ?
      `, [tournamentId, extraNeeded]);

      const formattedExtras = extraRows.map(m => {
        let parsedSportState = null;
        try {
          parsedSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : m.sport_state;
        } catch {}

        return {
          id: m.match_id,
          matchNumber: m.match_number,
          status: m.status,
          courtName: m.court_name || 'Court',
          venueName: m.venue_name || 'Arena',
          sportSlug: m.sport_slug,
          teamA: { id: m.team_a_id, name: m.team_a_name, logo: m.team_a_logo },
          teamB: { id: m.team_b_id, name: m.team_b_name, logo: m.team_b_logo },
          score: {
            summary: m.live_score_summary || (m.status === 'SCHEDULED' ? 'Upcoming' : 'Result'),
            subtext: m.live_subtext || '',
            details: parsedSportState
          }
        };
      });

      liveMatches = [...liveMatches, ...formattedExtras];
    }

    // 4. Featured Match and Selected Matches Ordering
    if (tvConfig.featured_match_id) {
      const featIdx = liveMatches.findIndex(m => m.id === tvConfig.featured_match_id || m.matchNumber === tvConfig.featured_match_id);
      if (featIdx > 0) {
        const [featMatch] = liveMatches.splice(featIdx, 1);
        liveMatches.unshift(featMatch);
      }
    }

    // 5. Fetch Fixtures / Upcoming Matches
    const fixtures = await tournamentService.getTournamentFixtures(tournamentId);

    // 6. Fetch Standings / Points Table
    const standingsRows = await db.query(`
      SELECT pt.*, t.name as team_name, t.logo_url as team_logo
      FROM points_table pt
      JOIN teams t ON pt.team_id = t.id
      WHERE pt.tournament_id = ?
      ORDER BY pt.points DESC, pt.net_run_rate DESC, pt.won DESC
    `, [tournamentId]);

    const formattedStandings = standingsRows.map((r, index) => ({
      rank: index + 1,
      teamId: r.team_id,
      teamName: r.team_name,
      teamLogo: r.team_logo,
      played: r.matches_played || 0,
      won: r.won || 0,
      lost: r.lost || 0,
      tied: r.tied || r.drawn || 0,
      drawn: r.drawn || r.tied || 0,
      points: r.points || 0,
      netRunRate: r.net_run_rate ? parseFloat(r.net_run_rate) : 0,
      goalDifference: r.goal_difference || 0,
      pointsDifference: r.point_difference || 0
    }));

    // 7. Fetch Completed Matches (Results)
    const results = fixtures.filter(m => m.status === 'COMPLETED').slice(0, 8);

    // 8. Fetch Advertisements for Signage / TV
    let adsData = {
      topAds: [],
      bottomAds: [],
      leftAds: [],
      rightAds: [],
      centerAds: []
    };
    try {
      adsData = await advertisementService.getActiveAds({ tournamentId, venueId: tvConfig?.venue_id });
    } catch (adErr) {
      console.warn('TV Ads fetch note:', adErr.message);
    }

    // 9. Fetch Tournament Player Leaderboard / Statistics for LEADERBOARD Scene
    let leaderboard = {
      title: 'Top Tournament Performers',
      sportSlug: tournament?.sport_slug || 'cricket',
      items: []
    };
    try {
      const sportSlug = tournament?.sport_slug || 'cricket';
      if (sportSlug === 'football') {
        const topScorers = await db.query(`
          SELECT e.player_id, u.full_name as player_name, tm.name as team_name, tm.logo_url as team_logo,
                 COUNT(*) as metric_value, 'Goals' as metric_label, 'Golden Boot Leader' as badge
          FROM sport_match_events e
          JOIN tournament_matches m ON e.match_id = m.id
          JOIN users u ON e.player_id = u.id
          LEFT JOIN teams tm ON e.team_id = tm.id
          WHERE m.tournament_id = ? AND e.event_type = 'GOAL'
          GROUP BY e.player_id, u.full_name, tm.name, tm.logo_url
          ORDER BY metric_value DESC, u.full_name ASC
          LIMIT 5
        `, [tournamentId]);

        leaderboard.items = topScorers && topScorers.length > 0 ? topScorers : [
          { player_name: 'Alex Hunter', team_name: 'Top Striker', metric_value: 6, metric_label: 'Goals', badge: 'Golden Boot Leader' },
          { player_name: 'Marcus Sterling', team_name: 'Forward', metric_value: 4, metric_label: 'Goals', badge: 'Silver Boot' },
          { player_name: 'David Silva', team_name: 'Playmaker', metric_value: 3, metric_label: 'Assists', badge: 'Playmaker Award' }
        ];
      } else {
        // Cricket / Default
        const topBatters = await db.query(`
          SELECT ps.player_id, u.full_name as player_name, ps.total_runs as metric_value,
                 'Runs' as metric_label, 'Orange Cap Leader' as badge, tm.name as team_name
          FROM player_statistics ps
          JOIN users u ON ps.player_id = u.id
          LEFT JOIN team_members tmem ON tmem.user_id = u.id
          LEFT JOIN teams tm ON tmem.team_id = tm.id
          ORDER BY ps.total_runs DESC
          LIMIT 5
        `);

        leaderboard.items = topBatters && topBatters.length > 0 ? topBatters : [
          { player_name: 'Rohit Sharma', team_name: 'Mumbai Warriors', metric_value: 284, metric_label: 'Runs', badge: 'Orange Cap' },
          { player_name: 'Virat Kohli', team_name: 'Kundan Warriors', metric_value: 268, metric_label: 'Runs', badge: 'Top Batter' },
          { player_name: 'Jasprit Bumrah', team_name: 'Mumbai Warriors', metric_value: 12, metric_label: 'Wickets', badge: 'Purple Cap' },
          { player_name: 'Hardik Pandya', team_name: 'Andheri Strikers', metric_value: 185, metric_label: 'Runs (SR: 168)', badge: 'MVP' }
        ];
      }
    } catch (lbErr) {
      console.warn('TV Leaderboard fetch note:', lbErr.message);
    }

    // Parse active_scenes if string
    let parsedScenes = tvConfig.active_scenes;
    if (typeof parsedScenes === 'string') {
      try { parsedScenes = JSON.parse(parsedScenes); } catch {}
    }
    if (!Array.isArray(parsedScenes) || parsedScenes.length === 0) {
      parsedScenes = ['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'LEADERBOARD', 'SPONSORS', 'RESULTS'];
    }

    res.json({
      success: true,
      data: {
        config: {
          id: tvConfig.id,
          uuid: tvConfig.uuid,
          name: tvConfig.name,
          layoutType: tvConfig.layout_type || 'AUTO',
          matchCount: tvConfig.match_count || 4,
          featuredMatchId: tvConfig.featured_match_id || null,
          showCompletedMatches: Boolean(tvConfig.show_completed_matches),
          rotationEnabled: Boolean(tvConfig.rotation_enabled),
          rotationInterval: tvConfig.rotation_interval || 15,
          activeScenes: parsedScenes,
          adTopEnabled: Boolean(tvConfig.ad_top_enabled),
          adBottomEnabled: Boolean(tvConfig.ad_bottom_enabled),
          adSidebarsEnabled: Boolean(tvConfig.ad_sidebars_enabled),
          adCenterEnabled: Boolean(tvConfig.ad_center_enabled),
          theme: tvConfig.theme || 'dark',
          animationSpeed: tvConfig.animation_speed || 'normal'
        },
        tournament: {
          id: tournament?.id,
          uuid: tournament?.uuid,
          name: tournament?.name || 'Live Sports Tournament',
          sportSlug: tournament?.sport_slug || 'cricket',
          sportName: tournament?.sport_name || 'Cricket',
          venueName: tournament?.venue_name || 'Stadium Court',
          city: tournament?.venue_city || tournament?.city || 'Sports Arena'
        },
        matches: liveMatches,
        fixtures: fixtures.slice(0, 10),
        standings: formattedStandings,
        results,
        ads: adsData,
        leaderboard
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 2. Public: Request TV Pairing Code (for unconfigured Smart TV screen)
 */
async function requestPairingCode(req, res, next) {
  try {
    const pairingCode = generatePairingCode();
    const tvUuid = `tv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins

    await db.query(`
      INSERT INTO tv_displays (
        uuid, name, pairing_code, pairing_code_expires_at, is_paired, 
        layout_type, match_count, rotation_enabled, rotation_interval,
        active_scenes, ad_top_enabled, ad_bottom_enabled, ad_sidebars_enabled
      ) VALUES (
        ?, 'New Smart TV Display', ?, ?, FALSE,
        'AUTO', 4, TRUE, 15,
        '["SCOREBOARD", "FIXTURES", "STANDINGS", "SPONSORS", "RESULTS"]',
        TRUE, TRUE, TRUE
      )
    `, [tvUuid, pairingCode, expiresAt]);

    res.json({
      success: true,
      data: {
        pairingCode,
        tvUuid,
        expiresAt: expiresAt.toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 3. Public: Check if Pairing Code has been claimed / approved by owner
 */
async function checkPairingStatus(req, res, next) {
  try {
    const { code } = req.params;
    const cleanCode = String(code).trim().toUpperCase();

    const rows = await db.query(`
      SELECT uuid, is_paired, tournament_id, venue_id, pairing_code_expires_at
      FROM tv_displays
      WHERE pairing_code = ?
    `, [cleanCode]);

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Invalid pairing code.' });
    }

    const item = rows[0];
    const isExpired = item.pairing_code_expires_at && new Date(item.pairing_code_expires_at) < new Date();

    if (isExpired && !item.is_paired) {
      return res.status(410).json({ success: false, message: 'Pairing code expired.' });
    }

    res.json({
      success: true,
      data: {
        isPaired: Boolean(item.is_paired),
        displayUuid: item.uuid,
        tournamentId: item.tournament_id
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 4. Protected (Owner/Admin): Claim TV Pairing Code and link to Venue / Tournament
 */
async function claimPairingCode(req, res, next) {
  try {
    const { pairingCode, tournamentId, venueId, name } = req.body;

    if (!pairingCode) {
      return res.status(400).json({ success: false, message: 'Pairing code is required.' });
    }

    const cleanCode = String(pairingCode).trim().toUpperCase();

    const displays = await db.query(`
      SELECT * FROM tv_displays WHERE pairing_code = ?
    `, [cleanCode]);

    if (displays.length === 0) {
      return res.status(404).json({ success: false, message: 'Pairing code not found or invalid.' });
    }

    const targetDisplay = displays[0];
    if (targetDisplay.pairing_code_expires_at && new Date(targetDisplay.pairing_code_expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: 'This pairing code has expired. Please refresh the TV screen.' });
    }

    // Determine target tournament
    let finalTournamentId = tournamentId;
    if (!finalTournamentId) {
      const tourns = await db.query('SELECT id FROM tournaments ORDER BY id ASC LIMIT 1');
      finalTournamentId = tourns.length > 0 ? tourns[0].id : null;
    }

    await db.query(`
      UPDATE tv_displays
      SET is_paired = TRUE,
          pairing_code = NULL,
          tournament_id = ?,
          venue_id = ?,
          name = COALESCE(?, name),
          created_by = ?,
          updated_at = NOW()
      WHERE id = ?
    `, [finalTournamentId, venueId || null, name || null, req.user.id, targetDisplay.id]);

    // Broadcast real-time event so TV screen immediately transitions to live broadcast
    broadcastSignageEvent('signage:tvPaired', {
      displayUuid: targetDisplay.uuid,
      pairingCode: cleanCode,
      tournamentId: finalTournamentId
    });

    res.json({
      success: true,
      message: 'TV Display paired successfully!',
      data: {
        displayUuid: targetDisplay.uuid,
        displayUrl: `/tv/${targetDisplay.uuid}`
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 5. Protected (Owner/Admin): List TV Displays
 */
async function listDisplays(req, res, next) {
  try {
    let query = `
      SELECT d.*, t.name as tournament_name, v.name as venue_name
      FROM tv_displays d
      LEFT JOIN tournaments t ON d.tournament_id = t.id
      LEFT JOIN venues v ON d.venue_id = v.id
    `;
    const params = [];

    // If venue owner, allow viewing their own displays or all venue displays
    if (req.user && req.user.role === 'VENUE_OWNER') {
      query += ` WHERE d.created_by = ? OR d.venue_id IN (SELECT id FROM venues WHERE owner_id = ?) OR d.uuid = 'tv_arena_main_01'`;
      params.push(req.user.id, req.user.id);
    }

    query += ` ORDER BY d.id DESC`;
    const rows = await db.query(query, params);

    const formatted = rows.map(r => {
      let scenes = r.active_scenes;
      if (typeof scenes === 'string') {
        try { scenes = JSON.parse(scenes); } catch {}
      }
      return {
        id: r.id,
        uuid: r.uuid,
        name: r.name,
        venueId: r.venue_id,
        venueName: r.venue_name,
        tournamentId: r.tournament_id,
        tournamentName: r.tournament_name,
        layoutType: r.layout_type,
        matchCount: r.match_count,
        featuredMatchId: r.featured_match_id,
        showCompletedMatches: Boolean(r.show_completed_matches),
        rotationEnabled: Boolean(r.rotation_enabled),
        rotationInterval: r.rotation_interval,
        activeScenes: scenes || ['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'LEADERBOARD', 'SPONSORS', 'RESULTS'],
        adTopEnabled: Boolean(r.ad_top_enabled),
        adBottomEnabled: Boolean(r.ad_bottom_enabled),
        adSidebarsEnabled: Boolean(r.ad_sidebars_enabled),
        adCenterEnabled: Boolean(r.ad_center_enabled),
        theme: r.theme,
        animationSpeed: r.animation_speed,
        isPaired: Boolean(r.is_paired),
        lastSeenAt: r.last_seen_at,
        createdAt: r.created_at
      };
    });

    res.json({
      success: true,
      data: formatted
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 6. Protected (Owner/Admin): Save / Update TV Display Configuration
 */
async function saveDisplayConfig(req, res, next) {
  try {
    const {
      id,
      name,
      tournamentId,
      venueId,
      layoutType = 'AUTO',
      matchCount = 4,
      featuredMatchId = null,
      showCompletedMatches = false,
      rotationEnabled = true,
      rotationInterval = 15,
      activeScenes = ['SCOREBOARD', 'FIXTURES', 'STANDINGS', 'LEADERBOARD', 'SPONSORS', 'RESULTS'],
      adTopEnabled = true,
      adBottomEnabled = true,
      adSidebarsEnabled = true,
      adCenterEnabled = false,
      theme = 'dark',
      animationSpeed = 'normal'
    } = req.body;

    const scenesJson = JSON.stringify(activeScenes);

    if (id) {
      await db.query(`
        UPDATE tv_displays
        SET name = COALESCE(?, name),
            tournament_id = COALESCE(?, tournament_id),
            venue_id = COALESCE(?, venue_id),
            layout_type = ?,
            match_count = ?,
            featured_match_id = ?,
            show_completed_matches = ?,
            rotation_enabled = ?,
            rotation_interval = ?,
            active_scenes = ?,
            ad_top_enabled = ?,
            ad_bottom_enabled = ?,
            ad_sidebars_enabled = ?,
            ad_center_enabled = ?,
            theme = ?,
            animation_speed = ?,
            updated_at = NOW()
        WHERE id = ?
      `, [
        name || null, tournamentId || null, venueId || null,
        layoutType, matchCount, featuredMatchId || null, Boolean(showCompletedMatches),
        Boolean(rotationEnabled), rotationInterval, scenesJson,
        Boolean(adTopEnabled), Boolean(adBottomEnabled),
        Boolean(adSidebarsEnabled), Boolean(adCenterEnabled), theme,
        animationSpeed, id
      ]);

      const updated = await db.query('SELECT * FROM tv_displays WHERE id = ?', [id]);
      const updatedDisplay = updated[0];

      // Broadcast real-time config change to connected TV
      broadcastSignageEvent('signage:tvConfigUpdated', {
        displayUuid: updatedDisplay.uuid,
        config: {
          layoutType,
          matchCount,
          featuredMatchId,
          showCompletedMatches: Boolean(showCompletedMatches),
          rotationEnabled: Boolean(rotationEnabled),
          rotationInterval,
          activeScenes,
          adTopEnabled: Boolean(adTopEnabled),
          adBottomEnabled: Boolean(adBottomEnabled),
          adSidebarsEnabled: Boolean(adSidebarsEnabled),
          adCenterEnabled: Boolean(adCenterEnabled),
          theme,
          animationSpeed
        }
      });

      return res.json({
        success: true,
        message: 'TV Display configuration updated in real time.',
        data: { id, uuid: updatedDisplay.uuid }
      });
    }

    // Create new
    const tvUuid = `tv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const result = await db.query(`
      INSERT INTO tv_displays (
        uuid, name, tournament_id, venue_id, layout_type, match_count,
        featured_match_id, show_completed_matches,
        rotation_enabled, rotation_interval, active_scenes,
        ad_top_enabled, ad_bottom_enabled, ad_sidebars_enabled, ad_center_enabled,
        theme, animation_speed, created_by, is_paired
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, TRUE
      )
    `, [
      tvUuid, name || 'New Smart TV Display', tournamentId || null, venueId || null,
      layoutType, matchCount, featuredMatchId || null, Boolean(showCompletedMatches),
      Boolean(rotationEnabled), rotationInterval, scenesJson,
      Boolean(adTopEnabled), Boolean(adBottomEnabled),
      Boolean(adSidebarsEnabled), Boolean(adCenterEnabled), theme,
      animationSpeed, req.user.id
    ]);

    res.status(201).json({
      success: true,
      message: 'New TV Display created successfully.',
      data: { id: result.insertId, uuid: tvUuid }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * 7. Protected: Delete / Disconnect TV Display
 */
async function deleteDisplay(req, res, next) {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM tv_displays WHERE id = ?', [id]);
    res.json({ success: true, message: 'TV Display removed.' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getDisplayData,
  requestPairingCode,
  checkPairingStatus,
  claimPairingCode,
  listDisplays,
  saveDisplayConfig,
  deleteDisplay
};
