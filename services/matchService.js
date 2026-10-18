const db = require('../config/database');
const { broadcastTournamentMatchUpdate, broadcastMatchBallEvent } = require('./socketService');

/**
 * Returns single match state.
 */
const getMatchByPublicId = async (matchPublicId) => {
  const rows = await db.query(
    `SELECT 
      tm.id,
      tm.uuid as public_id,
      tm.match_number,
      tm.match_date,
      tm.start_time,
      tm.end_time,
      tm.status,
      tm.winner_team_id,
      tm.result_summary,
      COALESCE(tm.live_score_summary, 'Yet to Start') as live_score_summary,
      tm.live_subtext,
      tm.sport_state,
      t.uuid as tournament_public_id,
      t.name as tournament_name,
      s.slug as sport_slug,
      s.name as sport_name,
      c.name as court_name,
      v.name as venue_name,
      v.city as venue_city,
      ta.uuid as team_a_public_id, ta.name as team_a_name, ta.logo_url as team_a_logo,
      tb.uuid as team_b_public_id, tb.name as team_b_name, tb.logo_url as team_b_logo
     FROM tournament_matches tm
     JOIN tournaments t ON tm.tournament_id = t.id
     JOIN sports s ON t.sport_id = s.id
     LEFT JOIN courts c ON tm.court_id = c.id
     LEFT JOIN venues v ON tm.venue_id = v.id
     JOIN teams ta ON tm.team_a_id = ta.id
     JOIN teams tb ON tm.team_b_id = tb.id
     WHERE tm.uuid = ? OR tm.id = ?`,
    [matchPublicId, isNaN(matchPublicId) ? -1 : parseInt(matchPublicId, 10)]
  );

  if (!rows || rows.length === 0) {
    return null;
  }

  const m = rows[0];
  let parsedSportState = null;
  try {
    parsedSportState = typeof m.sport_state === 'string' ? JSON.parse(m.sport_state) : m.sport_state;
  } catch {
    parsedSportState = null;
  }

  return {
    id: m.public_id,
    matchNumber: m.match_number,
    status: m.status,
    tournament: {
      id: m.tournament_public_id,
      name: m.tournament_name
    },
    sport: {
      slug: m.sport_slug,
      name: m.sport_name
    },
    court: {
      name: m.court_name || 'Main Court',
      venueName: m.venue_name || 'Sports Arena',
      city: m.venue_city || 'Mumbai'
    },
    schedule: {
      date: m.match_date,
      startTime: m.start_time,
      endTime: m.end_time
    },
    teamA: {
      id: m.team_a_public_id,
      name: m.team_a_name,
      logo: m.team_a_logo
    },
    teamB: {
      id: m.team_b_public_id,
      name: m.team_b_name,
      logo: m.team_b_logo
    },
    score: {
      summary: m.live_score_summary,
      subtext: m.live_subtext,
      details: parsedSportState
    },
    resultSummary: m.result_summary
  };
};

/**
 * Returns paginated score events / commentary stream.
 */
const getMatchEventsPaginated = async (matchPublicId, { cursor, limit = 20 }) => {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50);

  // 1. Get internal match id
  const matchRows = await db.query(
    'SELECT id FROM tournament_matches WHERE uuid = ? OR id = ?',
    [matchPublicId, isNaN(matchPublicId) ? -1 : parseInt(matchPublicId, 10)]
  );
  if (!matchRows || matchRows.length === 0) {
    return null;
  }
  const matchId = matchRows[0].id;

  const conditions = ['match_id = ?'];
  const params = [matchId];

  if (cursor) {
    const cursorSeq = parseInt(cursor, 10);
    if (!isNaN(cursorSeq)) {
      conditions.push('id < ?');
      params.push(cursorSeq);
    }
  }

  const sql = `
    SELECT 
      id,
      event_type,
      payload,
      created_at
    FROM score_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY id DESC
    LIMIT ?
  `;

  params.push(safeLimit + 1);
  const rows = await db.query(sql, params);

  const hasMore = rows.length > safeLimit;
  const items = hasMore ? rows.slice(0, safeLimit) : rows;

  let nextCursor = null;
  if (hasMore && items.length > 0) {
    nextCursor = items[items.length - 1].id;
  }

  const cleanItems = items.map(ev => {
    let payload = {};
    try {
      payload = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : (ev.payload || {});
    } catch {
      payload = {};
    }
    return {
      seq: ev.id,
      type: ev.event_type,
      commentary: payload.commentary || `${ev.event_type} scored!`,
      details: payload,
      createdAt: ev.created_at
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
 * Authoritative Scorer Write:
 * - Appends immutable score_event
 * - Updates tournament_matches live state
 * - Emits tiered Socket.IO notifications to isolated rooms
 */
const recordScoreEvent = async ({
  matchPublicId,
  eventType,
  scoreSummary,
  subtext,
  sportStateUpdate,
  commentaryText,
  authorId,
  authorName
}) => {

  return await db.transaction(async (connection) => {
    // 1. Fetch match and tournament details
    const [matches] = await connection.query(
      `SELECT tm.id, tm.uuid as public_id, tm.status, tm.tournament_id, tm.court_id,
              c.name as court_name, t.uuid as tournament_public_id,
              tm.sport_state, tm.live_score_summary, tm.live_subtext
       FROM tournament_matches tm
       JOIN tournaments t ON tm.tournament_id = t.id
       LEFT JOIN courts c ON tm.court_id = c.id
       WHERE tm.uuid = ? OR tm.id = ?
       FOR UPDATE`,
      [matchPublicId, isNaN(matchPublicId) ? -1 : parseInt(matchPublicId, 10)]
    );

    if (!matches || matches.length === 0) {
      throw { statusCode: 404, message: 'Match not found.' };
    }

    const match = matches[0];

    // 2. Merge sport_state
    let currentSportState = {};
    try {
      currentSportState = typeof match.sport_state === 'string' ? JSON.parse(match.sport_state) : (match.sport_state || {});
    } catch {
      currentSportState = {};
    }
    const mergedSportState = { ...currentSportState, ...(sportStateUpdate || {}) };

    const payloadObj = {
      commentary: commentaryText || '',
      ...mergedSportState
    };

    // 3. Insert score event
    const [insertResult] = await connection.query(
      `INSERT INTO score_events (match_id, event_type, payload) VALUES (?, ?, ?)`,
      [match.id, eventType || 'SCORE_UPDATE', JSON.stringify(payloadObj)]
    );

    // 4. Update match record
    await connection.query(
      `UPDATE tournament_matches 
       SET live_score_summary = ?,
           live_subtext = ?,
           sport_state = ?,
           status = 'LIVE'
       WHERE id = ?`,
      [
        scoreSummary || match.live_score_summary,
        subtext !== undefined ? subtext : match.live_subtext,
        JSON.stringify(mergedSportState),
        match.id
      ]
    );

    const updatedMatchData = {
      public_id: match.public_id,
      status: 'LIVE',
      live_score_summary: scoreSummary || match.live_score_summary,
      live_subtext: subtext !== undefined ? subtext : match.live_subtext,
      court_name: match.court_name || 'Main Court'
    };

    // 5. Broadcast to Tournament room (lightweight summary)
    broadcastTournamentMatchUpdate(match.tournament_public_id, updatedMatchData);

    // 6. Broadcast to Match room (detailed event)
    broadcastMatchBallEvent(match.public_id, {
      seq: insertResult.insertId,
      type: eventType,
      scoreSummary: updatedMatchData.live_score_summary,
      subtext: updatedMatchData.live_subtext,
      commentary: commentaryText,
      details: sportStateUpdate
    });

    // 7. Process structured @mentions and notify tagged users
    if (commentaryText && commentaryText.includes('@')) {
      const { processCommentaryMentions } = require('./notificationService');
      processCommentaryMentions({
        matchId: match.id,
        matchPublicId: match.public_id,
        matchTitle: `${match.tournament_name || 'Tournament'} Match`,
        authorId: authorId || null,
        authorName: authorName || 'Match Scorer',
        commentaryText
      }).catch(err => console.warn('[Mentions error]:', err.message));
    }

    return {
      success: true,
      sequenceNumber: insertResult.insertId,
      scoreSummary: updatedMatchData.live_score_summary
    };
  });
};


module.exports = {
  getMatchByPublicId,
  getMatchEventsPaginated,
  recordScoreEvent
};
