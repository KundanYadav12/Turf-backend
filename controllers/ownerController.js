const db = require('../config/database');
const slotService = require('../services/slotService');

const getOwnerDashboardStats = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    // Fetch venues owned
    const venues = await db.query(`SELECT id, name FROM venues WHERE owner_id = ?`, [ownerId]);
    if (!venues || venues.length === 0) {
      return res.json({
        success: true,
        data: {
          totalVenues: 0,
          todayBookingsCount: 0,
          todayRevenue: 0.00,
          occupiedSlots: 0,
          totalSlots: 0,
          recentBookings: []
        }
      });
    }

    const venueIds = venues.map(v => v.id);
    const venueIdPlaceholders = venueIds.map(() => '?').join(',');

    // Today's Bookings & Revenue
    const todayStats = await db.query(
      `SELECT 
        COUNT(id) as total_count,
        COALESCE(SUM(final_amount), 0) as total_revenue
       FROM bookings 
       WHERE venue_id IN (${venueIdPlaceholders}) AND booking_date = ? AND booking_status != 'CANCELLED'`,
      [...venueIds, today]
    );

    // Recent Bookings List
    const recentBookings = await db.query(
      `SELECT 
        b.*,
        u.full_name as user_name,
        u.phone as user_phone,
        c.name as court_name,
        v.name as venue_name
       FROM bookings b
       JOIN users u ON b.user_id = u.id
       JOIN courts c ON b.court_id = c.id
       JOIN venues v ON b.venue_id = v.id
       WHERE b.venue_id IN (${venueIdPlaceholders})
       ORDER BY b.created_at DESC
       LIMIT 10`,
      venueIds
    );

    res.json({
      success: true,
      data: {
        totalVenues: venues.length,
        todayBookingsCount: todayStats[0]?.total_count || 0,
        todayRevenue: parseFloat(todayStats[0]?.total_revenue || 0),
        recentBookings: recentBookings.map(b => ({
          id: b.id,
          bookingNumber: b.booking_number,
          userName: b.user_name,
          userPhone: b.user_phone,
          venueName: b.venue_name,
          courtName: b.court_name,
          bookingDate: b.booking_date,
          startTime: b.start_time,
          endTime: b.end_time,
          finalAmount: parseFloat(b.final_amount),
          bookingType: b.booking_type,
          bookingStatus: b.booking_status
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

const getOwnerCalendarGrid = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Fetch venues owned
    const venues = await db.query(`SELECT id, name FROM venues WHERE owner_id = ?`, [ownerId]);
    if (!venues || venues.length === 0) {
      return res.json({ success: true, data: [] });
    }

    const calendarData = await Promise.all(venues.map(async (v) => {
      const courts = await db.query(`SELECT id, name, base_price_per_hour FROM courts WHERE venue_id = ?`, [v.id]);

      const courtGrids = await Promise.all(courts.map(async (c) => {
        const slots = await slotService.getCourtSlots(c.id, targetDate);
        return {
          courtId: c.id,
          courtName: c.name,
          basePrice: parseFloat(c.base_price_per_hour),
          slots: slots
        };
      }));

      return {
        venueId: v.id,
        venueName: v.name,
        courts: courtGrids
      };
    }));

    res.json({
      success: true,
      data: calendarData
    });
  } catch (error) {
    next(error);
  }
};

const getOrganizerTournamentSummary = async (req, res, next) => {
  try {
    const ownerId = req.user.id;
    const userRole = req.user.role;

    let teamsFilter = '';
    let tournFilter = '';
    let matchesFilter = '';
    let params = [];

    if (userRole !== 'ADMIN') {
      const venues = await db.query('SELECT id FROM venues WHERE owner_id = ?', [ownerId]);
      const vIds = venues.map(v => v.id);
      const vPlaceholders = vIds.length > 0 ? vIds.map(() => '?').join(',') : 'NULL';

      teamsFilter = `WHERE (t.owner_id = ? OR t.venue_id IN (${vPlaceholders}))`;
      tournFilter = `WHERE (tourn.created_by = ? OR tourn.venue_id IN (${vPlaceholders}))`;
      matchesFilter = `WHERE (v.owner_id = ? OR tm.venue_id IN (${vPlaceholders}))`;
      params = [ownerId, ...vIds];
    }

    // 1. Teams & Registered Players
    const teams = await db.query(
      `SELECT t.id, t.uuid, t.name, t.status, s.name as sport_name,
              (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) as player_count
       FROM teams t
       LEFT JOIN sports s ON t.sport_id = s.id
       ${teamsFilter}
       ORDER BY t.created_at DESC`,
      params
    );

    const totalTeams = teams.length;
    const activeTeams = teams.filter(t => t.status === 'ACTIVE').length;
    let totalPlayers = 0;
    let fullRostersCount = 0;
    for (const t of teams) {
      const cnt = parseInt(t.player_count, 10) || 0;
      totalPlayers += cnt;
      if (cnt >= 11) fullRostersCount++; // 11+ is standard squad
    }
    const rosterCompletionRate = totalTeams > 0 ? ((fullRostersCount / totalTeams) * 100).toFixed(0) : '0';

    // 2. Recent Player Registrations in Owner's Teams
    const teamIds = teams.map(t => t.id);
    let recentRegistrations = [];
    if (teamIds.length > 0) {
      const tPlaceholders = teamIds.map(() => '?').join(',');
      recentRegistrations = await db.query(
        `SELECT tm.id as member_id, tm.role, tm.jersey_number, tm.position, tm.joined_at,
                u.id as user_id, u.full_name as player_name, u.profile_photo,
                t.name as team_name, t.uuid as team_id
         FROM team_members tm
         JOIN users u ON tm.user_id = u.id
         JOIN teams t ON tm.team_id = t.id
         WHERE tm.team_id IN (${tPlaceholders})
         ORDER BY tm.id DESC LIMIT 8`,
        teamIds
      );
    }

    // 3. Upcoming Matches and Recent Results
    const matches = await db.query(
      `SELECT tm.id, tm.uuid as match_id, tm.match_number, tm.match_date, tm.start_time,
              tm.status, tm.live_score_summary, tm.result_summary,
              t.name as tournament_name, c.name as court_name,
              ta.name as team_a_name, tb.name as team_b_name
       FROM tournament_matches tm
       LEFT JOIN tournaments t ON tm.tournament_id = t.id
       LEFT JOIN courts c ON tm.court_id = c.id
       LEFT JOIN venues v ON tm.venue_id = v.id
       LEFT JOIN teams ta ON tm.team_a_id = ta.id
       LEFT JOIN teams tb ON tm.team_b_id = tb.id
       ${matchesFilter}
       ORDER BY tm.match_date DESC, tm.start_time DESC
       LIMIT 20`,
      params
    );

    const upcomingMatches = matches.filter(m => m.status === 'SCHEDULED' || m.status === 'LIVE').slice(0, 6);
    const recentResults = matches.filter(m => m.status === 'COMPLETED').slice(0, 6);

    // 4. Tournaments Count
    const tournRows = await db.query(
      `SELECT COUNT(*) as count FROM tournaments tourn ${tournFilter}`,
      params
    );

    res.json({
      success: true,
      data: {
        totalTeamsManaged: totalTeams,
        activeTeams,
        totalRegisteredPlayers: totalPlayers,
        rosterCompletionPercentage: `${rosterCompletionRate}%`,
        tournamentsCount: tournRows[0]?.count || 0,
        recentPlayerRegistrations: recentRegistrations.map(r => ({
          memberId: r.member_id,
          userId: r.user_id,
          name: r.player_name,
          profilePhoto: r.profile_photo,
          teamName: r.team_name,
          teamId: r.team_id,
          role: r.role,
          position: r.position,
          jerseyNumber: r.jersey_number,
          joinedAt: r.joined_at
        })),
        upcomingMatches: upcomingMatches.map(m => ({
          id: m.match_id,
          matchNumber: m.match_number,
          date: m.match_date,
          startTime: m.start_time,
          courtName: m.court_name,
          tournamentName: m.tournament_name,
          fixture: `${m.team_a_name || 'Team A'} vs ${m.team_b_name || 'Team B'}`,
          status: m.status
        })),
        recentResults: recentResults.map(m => ({
          id: m.match_id,
          matchNumber: m.match_number,
          date: m.match_date,
          tournamentName: m.tournament_name,
          fixture: `${m.team_a_name || 'Team A'} vs ${m.team_b_name || 'Team B'}`,
          scoreSummary: m.live_score_summary,
          result: m.result_summary || 'Completed'
        }))
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getOwnerDashboardStats,
  getOwnerCalendarGrid,
  getOrganizerTournamentSummary
};
