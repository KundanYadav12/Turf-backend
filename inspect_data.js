const db = require('./config/database');

async function inspect() {
  try {
    const pts = await db.query(`
      SELECT pt.id, pt.tournament_id, pt.team_id, t.name as team_name, pt.matches_played, pt.won, pt.lost, pt.points, pt.net_run_rate, pt.point_difference, tr.name as tournament_name
      FROM points_table pt 
      JOIN teams t ON pt.team_id = t.id 
      JOIN tournaments tr ON pt.tournament_id = tr.id
    `);
    console.log('Points table entries:');
    console.table(pts);

    const matches = await db.query(`
      SELECT m.id, m.tournament_id, m.team_a_id, ta.name as team_a, m.team_b_id, tb.name as team_b, m.winner_team_id, m.score_a, m.score_b, m.overs_a, m.overs_b, m.wickets_a, m.wickets_b, m.status, m.sport_state 
      FROM matches m
      LEFT JOIN teams ta ON m.team_a_id = ta.id
      LEFT JOIN teams tb ON m.team_b_id = tb.id
    `);
    console.log('Matches:');
    console.table(matches.map(m => ({
      id: m.id,
      tournament_id: m.tournament_id,
      match: `${m.team_a} vs ${m.team_b}`,
      winner_team_id: m.winner_team_id,
      score_a: m.score_a,
      overs_a: m.overs_a,
      wickets_a: m.wickets_a,
      score_b: m.score_b,
      overs_b: m.overs_b,
      wickets_b: m.wickets_b,
      status: m.status
    })));

    for (const m of matches) {
      if (m.sport_state) {
        console.log(`Match ${m.id} sport_state:`, m.sport_state);
      }
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}

inspect();
