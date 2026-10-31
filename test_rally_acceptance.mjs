import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculatePickleballDoublesPositions,
  PickleballAdapter,
  getSportAdapter,
  getInitialCourtState,
  applyPointToCourtState,
  computeCourtStateFromHistory,
  getScreenBox,
  getDiagonalReceiverBox
} from '../frontend/src/components/court/courtRulesEngine.js';

describe('Pickleball Rally-Scoring Acceptance Tests (Prompt Specifications)', () => {

  const baseConfig = {
    sport: 'pickleball',
    format: 'DOUBLES',
    scoringMode: 'RALLY',
    rotationRule: 'OFFICIAL',
    teamA: { id: 'teamA', name: 'Team A' },
    teamB: { id: 'teamB', name: 'Team B' },
    lineup: {
      teamA: [
        { id: 'A_P1', name: 'Alice (P1)', startCourt: 'RIGHT' },
        { id: 'A_P2', name: 'Aaron (P2)', startCourt: 'LEFT' }
      ],
      teamB: [
        { id: 'B_P1', name: 'Bob (P1)', startCourt: 'RIGHT' },
        { id: 'B_P2', name: 'Betty (P2)', startCourt: 'LEFT' }
      ]
    },
    startingServingTeam: 'teamA'
  };

  it('Acceptance Test 1: Start 0-0, Team A serves from Right (P1). A wins the rally: A is 1-0, A\'s players swap, the same server serves from the Left court, B is unchanged.', () => {
    // Start at 0-0
    const startState = getInitialCourtState(baseConfig);
    assert.strictEqual(startState.scoreA, 0);
    assert.strictEqual(startState.scoreB, 0);
    assert.strictEqual(startState.servingTeam, 'teamA');
    assert.strictEqual(startState.serviceCourt, 'RIGHT', '0 is even -> Right court');
    assert.strictEqual(startState.servingPlayer?.id, 'A_P1', 'Server is P1');
    assert.strictEqual(startState.servingBoxName, 'bottom-left', 'Team A on left: Right court is bottom-left');
    assert.strictEqual(startState.playerLocations['A_P1'], 'RIGHT');
    assert.strictEqual(startState.playerLocations['A_P2'], 'LEFT');
    assert.strictEqual(startState.playerLocations['B_P1'], 'RIGHT');
    assert.strictEqual(startState.playerLocations['B_P2'], 'LEFT');

    // A wins rally on serve:
    const nextState = applyPointToCourtState(startState, { pointTo: 'teamA', seq: 1 }, baseConfig);
    assert.strictEqual(nextState.scoreA, 1, 'A is 1');
    assert.strictEqual(nextState.scoreB, 0, 'B is 0');
    assert.strictEqual(nextState.servingTeam, 'teamA', 'Same team keeps serving');

    // A's players swap
    assert.strictEqual(nextState.playerLocations['A_P1'], 'LEFT', 'Alice (P1) swapped to LEFT');
    assert.strictEqual(nextState.playerLocations['A_P2'], 'RIGHT', 'Aaron (P2) swapped to RIGHT');

    // B is unchanged
    assert.strictEqual(nextState.playerLocations['B_P1'], 'RIGHT', 'Bob (P1) unchanged in RIGHT');
    assert.strictEqual(nextState.playerLocations['B_P2'], 'LEFT', 'Betty (P2) unchanged in LEFT');

    // Server serves from Left court (score 1 is odd), same server (A_P1)
    assert.strictEqual(nextState.serviceCourt, 'LEFT', 'Score 1 is odd -> Left court');
    assert.strictEqual(nextState.servingPlayer?.id, 'A_P1', 'The SAME server serves from new court');
    assert.strictEqual(nextState.servingBoxName, 'top-left', 'Team A on left: Left court is top-left');
  });

  it('Acceptance Test 2: A serves and B wins the rally: B is 1, nobody swaps, B serves, and the server is the B player standing in the Left court (score 1 is odd).', () => {
    // Start at 0-0, A serving
    const startState = getInitialCourtState(baseConfig);
    assert.strictEqual(startState.scoreA, 0);
    assert.strictEqual(startState.scoreB, 0);

    // B wins the rally (receiving team wins):
    const nextState = applyPointToCourtState(startState, { pointTo: 'teamB', seq: 1 }, baseConfig);
    assert.strictEqual(nextState.scoreA, 0);
    assert.strictEqual(nextState.scoreB, 1, 'B is 1');
    assert.strictEqual(nextState.servingTeam, 'teamB', 'B gains serve');

    // NOBODY swaps
    assert.strictEqual(nextState.playerLocations['A_P1'], 'RIGHT', 'A_P1 stays RIGHT');
    assert.strictEqual(nextState.playerLocations['A_P2'], 'LEFT', 'A_P2 stays LEFT');
    assert.strictEqual(nextState.playerLocations['B_P1'], 'RIGHT', 'B_P1 stays RIGHT');
    assert.strictEqual(nextState.playerLocations['B_P2'], 'LEFT', 'B_P2 stays LEFT');

    // Server is the B player standing in the Left court (score 1 is odd) -> Betty (P2)
    assert.strictEqual(nextState.serviceCourt, 'LEFT', 'B score 1 is odd -> Left court');
    assert.strictEqual(nextState.servingPlayer?.id, 'B_P2', 'Server is the B player in Left court');
    assert.strictEqual(nextState.servingBoxName, 'bottom-right', 'Team B on right: Left court is bottom-right');
  });

  it('Acceptance Test 3: Borivali 13 (odd) serving, Thane 10. The ball is on the Borivali player in the LEFT court (Kundan, top-left if he is in the Left court), and the receiver is the Thane player diagonally opposite (bottom-right).', () => {
    const borivaliConfig = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      teamA: { id: 'team-borivali', name: 'Borivali Blasters' },
      teamB: { id: 'team-thane', name: 'Thane Titans' },
      lineup: {
        teamA: [
          { id: 'p_kundan', name: 'Kundan', startCourt: 'RIGHT' },
          { id: 'p_partnerA', name: 'Partner A', startCourt: 'LEFT' }
        ],
        teamB: [
          { id: 'p_thane1', name: 'Thane P1', startCourt: 'RIGHT' },
          { id: 'p_thane2', name: 'Thane P2', startCourt: 'LEFT' }
        ]
      },
      scores: { teamA: 13, teamB: 10 },
      startingServingTeam: 'teamA'
    };

    // Borivali has 13 points, let's say 7 points scored on own serve (odd -> swapped) so Kundan is in LEFT court
    // Or Kundan has swapped into the LEFT court
    const state = getInitialCourtState({
      ...borivaliConfig,
      servePoints: { teamA: 7, teamB: 4 }, // 7 is odd -> Kundan (started RIGHT) is currently in LEFT court
      playerLocations: {
        'p_kundan': 'LEFT',
        'p_partnerA': 'RIGHT',
        'p_thane1': 'RIGHT',
        'p_thane2': 'LEFT'
      }
    });

    assert.strictEqual(state.scores.teamA, 13);
    assert.strictEqual(state.scores.teamB, 10);
    assert.strictEqual(state.servingTeam, 'teamA');

    // Score parity: 13 is odd -> service court is LEFT
    assert.strictEqual(state.serviceCourt, 'LEFT');

    // Kundan is standing in the LEFT court
    assert.strictEqual(state.playerLocations['p_kundan'], 'LEFT');

    // Borivali is on the left half of the screen facing net (facing right):
    // Left court is top-left!
    assert.strictEqual(state.servingBoxName, 'top-left');

    // Serving player must be Kundan
    assert.strictEqual(state.servingPlayer?.id, 'p_kundan');
    assert.strictEqual(state.servingPlayer?.name, 'Kundan');

    // Check receiver: opposing player standing diagonally opposite
    // Cross-court diagonal from top-left is bottom-right!
    assert.strictEqual(state.receiverCourt, 'LEFT'); // Opponent's Left court
    assert.strictEqual(state.targetBoxName, 'bottom-right');
    assert.strictEqual(state.receivingPlayer?.id, 'p_thane2');

    // Ball and SERVE badge must be on Kundan (top-left)
    const kundanMarker = state.players.find(p => p.id === 'p_kundan');
    const partnerAMarker = state.players.find(p => p.id === 'p_partnerA');
    const thane2Marker = state.players.find(p => p.id === 'p_thane2');

    assert.strictEqual(kundanMarker.isServer, true, 'SERVE badge must be on Kundan');
    assert.strictEqual(kundanMarker.boxName, 'top-left', 'Kundan is at top-left');
    assert.strictEqual(partnerAMarker.isServer, false, 'Partner A does NOT have server badge');
    assert.strictEqual(partnerAMarker.boxName, 'bottom-left', 'Partner A is in bottom-left');

    // Ball coords must be at top-left (y = 115)
    assert.strictEqual(state.ballCoords.y, 115, 'Ball is in top-left with Kundan');
    assert.strictEqual(state.serverCoords.y, 115);
    assert.strictEqual(state.receiverCoords.y, 285, 'Receiver is at bottom-right (y = 285)');
  });

  it('Acceptance Test 4: Undo and refresh restore the exact same positions and server.', () => {
    // Generate an arbitrary rally history with serving wins, turnover, receiving wins
    const history = [
      { sequence_number: 1, point_to: 'team_a' }, // 1-0: A serves & scores -> A swaps, A serves from LEFT
      { sequence_number: 2, point_to: 'team_b' }, // 1-1: Turnover -> NO swap, B serves from LEFT
      { sequence_number: 3, point_to: 'team_b' }, // 1-2: B serves & scores -> B swaps, B serves from RIGHT
      { sequence_number: 4, point_to: 'team_a' }, // 2-2: Turnover -> NO swap, A serves from RIGHT
      { sequence_number: 5, point_to: 'team_a' }, // 3-2: A serves & scores -> A swaps, A serves from LEFT
    ];

    const stateAt5 = computeCourtStateFromHistory(baseConfig, history);
    assert.strictEqual(stateAt5.scoreA, 3);
    assert.strictEqual(stateAt5.scoreB, 2);
    assert.strictEqual(stateAt5.servingTeam, 'teamA');
    assert.strictEqual(stateAt5.serviceCourt, 'LEFT', '3 is odd -> Left court');

    // Simulate page refresh / duplicate socket call: recompute from history
    const stateRefreshed = computeCourtStateFromHistory(baseConfig, history);
    assert.deepStrictEqual(stateRefreshed.playerLocations, stateAt5.playerLocations, 'Refresh produces identical player locations');
    assert.strictEqual(stateRefreshed.servingPlayer?.id, stateAt5.servingPlayer?.id, 'Refresh produces identical server');
    assert.strictEqual(stateRefreshed.receivingPlayer?.id, stateAt5.receivingPlayer?.id, 'Refresh produces identical receiver');
    assert.strictEqual(stateRefreshed.servingBoxName, stateAt5.servingBoxName);
    assert.strictEqual(stateRefreshed.targetBoxName, stateAt5.targetBoxName);

    // Simulate Undo by removing the 5th point
    const stateAt4 = computeCourtStateFromHistory(baseConfig, history.slice(0, 4));
    assert.strictEqual(stateAt4.scoreA, 2);
    assert.strictEqual(stateAt4.scoreB, 2);
    assert.strictEqual(stateAt4.servingTeam, 'teamA');
    assert.strictEqual(stateAt4.serviceCourt, 'RIGHT', '2 is even -> Right court');

    // Replay step-by-step from stateAt4 by applying 5th point
    const steppedState = applyPointToCourtState(stateAt4, history[4], baseConfig);
    assert.deepStrictEqual(steppedState.playerLocations, stateAt5.playerLocations, 'Undo then re-applying gives exact same state');
    assert.strictEqual(steppedState.servingPlayer?.id, stateAt5.servingPlayer?.id);
    assert.strictEqual(steppedState.serviceCourt, stateAt5.serviceCourt);
  });

  it('Acceptance Test 5: Singles behaviour is unchanged.', () => {
    const singlesConfig = {
      sport: 'pickleball',
      format: 'SINGLES',
      scoringMode: 'RALLY',
      teamA: { id: 'teamA', name: 'Alice' },
      teamB: { id: 'teamB', name: 'Bob' },
      lineup: {
        teamA: [{ id: 'A1', name: 'Alice', startCourt: 'RIGHT' }],
        teamB: [{ id: 'B1', name: 'Bob', startCourt: 'RIGHT' }]
      },
      startingServingTeam: 'teamA'
    };

    // Initial 0-0
    const s0 = getInitialCourtState(singlesConfig);
    assert.strictEqual(s0.scoreA, 0);
    assert.strictEqual(s0.scoreB, 0);
    assert.strictEqual(s0.servingTeam, 'teamA');
    assert.strictEqual(s0.serviceCourt, 'RIGHT', '0 is even -> Right court');
    assert.strictEqual(s0.playerLocations['A1'], 'RIGHT');
    assert.strictEqual(s0.playerLocations['B1'], 'RIGHT');

    // A scores -> 1-0: Alice moves to LEFT court (1 is odd)
    const s1 = applyPointToCourtState(s0, { pointTo: 'teamA', seq: 1 }, singlesConfig);
    assert.strictEqual(s1.scoreA, 1);
    assert.strictEqual(s1.scoreB, 0);
    assert.strictEqual(s1.serviceCourt, 'LEFT');
    assert.strictEqual(s1.playerLocations['A1'], 'LEFT');
    assert.strictEqual(s1.playerLocations['B1'], 'RIGHT');

    // B wins rally -> 1-1: Bob serves from LEFT court (1 is odd)
    const s2 = applyPointToCourtState(s1, { pointTo: 'teamB', seq: 2 }, singlesConfig);
    assert.strictEqual(s2.scoreA, 1);
    assert.strictEqual(s2.scoreB, 1);
    assert.strictEqual(s2.servingTeam, 'teamB');
    assert.strictEqual(s2.serviceCourt, 'LEFT');
    assert.strictEqual(s2.playerLocations['B1'], 'LEFT');
    assert.strictEqual(s2.playerLocations['A1'], 'LEFT');
  });

  it('Acceptance Test 6: Replaying from history when config.scores is passed (like courtUtils.js in production) never doubles scores or corrupts parity.', () => {
    // 5 point sequence:
    // Pt 1: A scores on serve -> 1-0, A swaps, A serves from LEFT (odd)
    // Pt 2: B scores as receiver -> 1-1, NO swap, B serves from LEFT (odd)
    // Pt 3: B scores on serve -> 1-2, B swaps, B serves from RIGHT (even)
    // Pt 4: A scores as receiver -> 2-2, NO swap, A serves from RIGHT (even)
    // Pt 5: A scores on serve -> 3-2, A swaps, A serves from LEFT (odd)
    const history = [
      { sequence_number: 1, point_to: 'team_a' },
      { sequence_number: 2, point_to: 'team_b' },
      { sequence_number: 3, point_to: 'team_b' },
      { sequence_number: 4, point_to: 'team_a' },
      { sequence_number: 5, point_to: 'team_a' }
    ];

    // In production, courtUtils passes current score in config: scores = { teamA: 3, teamB: 2 }
    const configWithScores = {
      ...baseConfig,
      scores: { teamA: 3, teamB: 2 },
      servePoints: { teamA: 2, teamB: 1 }
    };

    const state = computeCourtStateFromHistory(configWithScores, history);
    assert.strictEqual(state.scores.teamA, 3, 'Score A must NOT double to 6!');
    assert.strictEqual(state.scores.teamB, 2, 'Score B must NOT double to 4!');
    assert.strictEqual(state.servePoints.teamA, 2, 'Team A scored 2 points while serving');
    assert.strictEqual(state.servePoints.teamB, 1, 'Team B scored 1 point while serving');

    // Score parity of Team A at 3: 3 is odd -> service court is LEFT!
    assert.strictEqual(state.serviceCourt, 'LEFT', 'Parity for 3 is odd -> LEFT service court');
    assert.strictEqual(state.servingBoxName, 'top-left');

    // Team A serve points is 2 (even -> original sides):
    // A_P1 started RIGHT -> in RIGHT court (bottom-left)
    // A_P2 started LEFT -> in LEFT court (top-left)
    assert.strictEqual(state.playerLocations['A_P1'], 'RIGHT');
    assert.strictEqual(state.playerLocations['A_P2'], 'LEFT');

    // Server must be Aaron (A_P2) who is standing in the LEFT court!
    assert.strictEqual(state.servingPlayer?.id, 'A_P2', 'Server is the player standing in LEFT court');
    const a2Marker = state.players.find(p => p.id === 'A_P2');
    assert.strictEqual(a2Marker.isServer, true, 'A_P2 has SERVE badge');
    assert.strictEqual(a2Marker.boxName, 'top-left');

    const a1Marker = state.players.find(p => p.id === 'A_P1');
    assert.strictEqual(a1Marker.isServer, false, 'A_P1 does NOT have serve badge');
  });

  it('Acceptance Test 7: Borivali Blasters 13 serving, Thane 10 - full rally scoring handover and swap verification.', () => {
    // Construct match reaching 13-10:
    // Borivali scored 7 points on serve, 6 points as receiver.
    // Thane scored 4 points on serve, 6 points as receiver.
    // Borivali servePoints = 7 (odd -> Borivali swapped).
    // Kundan started RIGHT -> now in LEFT court (top-left).
    // Thane servePoints = 4 (even -> Thane original sides).
    // Thane P1 in RIGHT (top-right), Thane P2 in LEFT (bottom-right).
    const borivaliConfig = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      teamA: { id: 'team-borivali', name: 'Borivali Blasters' },
      teamB: { id: 'team-thane', name: 'Thane Titans' },
      lineup: {
        teamA: [
          { id: 'p_kundan', name: 'Kundan', startCourt: 'RIGHT' },
          { id: 'p_partnerA', name: 'Partner A', startCourt: 'LEFT' }
        ],
        teamB: [
          { id: 'p_thane1', name: 'Thane P1', startCourt: 'RIGHT' },
          { id: 'p_thane2', name: 'Thane P2', startCourt: 'LEFT' }
        ]
      },
      scores: { teamA: 13, teamB: 10 },
      servePoints: { teamA: 7, teamB: 4 },
      startingServingTeam: 'teamA'
    };

    const s13 = getInitialCourtState(borivaliConfig);
    assert.strictEqual(s13.serviceCourt, 'LEFT');
    assert.strictEqual(s13.servingPlayer?.id, 'p_kundan');
    assert.strictEqual(s13.playerLocations['p_kundan'], 'LEFT');
    assert.strictEqual(s13.servingBoxName, 'top-left');

    // Case 1: Borivali wins rally -> score 14-10:
    // ONLY Borivali swaps! Same server (Kundan) now serves from RIGHT court (14 is even).
    const s14 = applyPointToCourtState(s13, { pointTo: 'teamA', seq: 24 }, borivaliConfig);
    assert.strictEqual(s14.scoreA, 14);
    assert.strictEqual(s14.scoreB, 10);
    assert.strictEqual(s14.servingTeam, 'teamA');
    assert.strictEqual(s14.playerLocations['p_kundan'], 'RIGHT', 'Kundan swapped to RIGHT');
    assert.strictEqual(s14.playerLocations['p_partnerA'], 'LEFT', 'Partner A swapped to LEFT');
    assert.strictEqual(s14.playerLocations['p_thane1'], 'RIGHT', 'Thane did NOT swap');
    assert.strictEqual(s14.playerLocations['p_thane2'], 'LEFT', 'Thane did NOT swap');
    assert.strictEqual(s14.serviceCourt, 'RIGHT', '14 is even -> Right court');
    assert.strictEqual(s14.servingPlayer?.id, 'p_kundan', 'The SAME server keeps serving');
    assert.strictEqual(s14.servingBoxName, 'bottom-left');

    // Case 2: From 13-10, receiving team (Thane) wins rally -> score 13-11:
    // NO player on either team swaps! Everyone stays where they are!
    const sTurnover = applyPointToCourtState(s13, { pointTo: 'teamB', seq: 24 }, borivaliConfig);
    assert.strictEqual(sTurnover.scoreA, 13);
    assert.strictEqual(sTurnover.scoreB, 11);
    assert.strictEqual(sTurnover.servingTeam, 'teamB', 'Thane becomes serving team');
    assert.strictEqual(sTurnover.playerLocations['p_kundan'], 'LEFT', 'Kundan stays in LEFT');
    assert.strictEqual(sTurnover.playerLocations['p_partnerA'], 'RIGHT', 'Partner A stays in RIGHT');
    assert.strictEqual(sTurnover.playerLocations['p_thane1'], 'RIGHT', 'Thane P1 stays in RIGHT');
    assert.strictEqual(sTurnover.playerLocations['p_thane2'], 'LEFT', 'Thane P2 stays in LEFT');

    // Thane score is 11 (odd -> LEFT court):
    assert.strictEqual(sTurnover.serviceCourt, 'LEFT');
    // Server is the player currently standing in the LEFT court -> Thane P2:
    assert.strictEqual(sTurnover.servingPlayer?.id, 'p_thane2', 'Server is Thane P2 in Left court');
    assert.strictEqual(sTurnover.servingBoxName, 'bottom-right', 'Thane on right: Left court is bottom-right');
    // Receiver is opposing player standing diagonally opposite in matching Left court -> Kundan:
    assert.strictEqual(sTurnover.receivingPlayer?.id, 'p_kundan', 'Receiver is Kundan in Left court');
    assert.strictEqual(sTurnover.targetBoxName, 'top-left', 'Diagonal cross-court from bottom-right is top-left');
  });

  it('Acceptance Test 8: Exact User Scenario - Kundan vs Mumbai (2-0 -> 2-1 -> 2-2 -> 3-2 with Undo & Refresh)', () => {
    const kundanMumbaiConfig = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      rotationRule: 'BADMINTON',
      teamA: { id: 'teamA', name: 'Kundan Warriors' },
      teamB: { id: 'teamB', name: 'Mumbai Warriors' },
      lineup: {
        teamA: [
          { id: 'K_P1', name: 'Kuldeep (P1)', startCourt: 'RIGHT' },
          { id: 'K_P2', name: 'Mohammed (P2)', startCourt: 'LEFT' }
        ],
        teamB: [
          { id: 'M_P1', name: 'Hardik (P1)', startCourt: 'RIGHT' },
          { id: 'M_P2', name: 'Ravindra (P2)', startCourt: 'LEFT' }
        ]
      },
      startingServingTeam: 'teamA'
    };

    // Step 0: Kundan serves from 0-0 to 2-0 (2 points won while serving):
    let state = getInitialCourtState(kundanMumbaiConfig);
    // Point 1: Kundan scores (1-0) -> Kundan swaps (P1 Left, P2 Right), Mumbai unchanged
    state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }, kundanMumbaiConfig);
    assert.strictEqual(state.scoreA, 1);
    assert.strictEqual(state.playerLocations['K_P1'], 'LEFT');
    assert.strictEqual(state.playerLocations['K_P2'], 'RIGHT');
    assert.strictEqual(state.playerLocations['M_P1'], 'RIGHT');
    assert.strictEqual(state.playerLocations['M_P2'], 'LEFT');

    // Point 2: Kundan scores (2-0) -> Kundan swaps back (P1 Right, P2 Left), Mumbai unchanged
    state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 }, kundanMumbaiConfig);
    assert.strictEqual(state.scoreA, 2);
    assert.strictEqual(state.scoreB, 0);
    assert.strictEqual(state.servingTeam, 'teamA');
    assert.strictEqual(state.playerLocations['K_P1'], 'RIGHT');
    assert.strictEqual(state.playerLocations['K_P2'], 'LEFT');
    assert.strictEqual(state.playerLocations['M_P1'], 'RIGHT');
    assert.strictEqual(state.playerLocations['M_P2'], 'LEFT');

    // 1. Kundan serves at 2-0 (Kundan P1 Right, P2 Left). Mumbai wins the rally:
    // score 2-1, no swaps, Mumbai serves from Left box with the Mumbai player standing in the Left court as server.
    const stateAt2_1 = applyPointToCourtState(state, { pointTo: 'teamB', seq: 3 }, kundanMumbaiConfig);
    assert.strictEqual(stateAt2_1.scoreA, 2);
    assert.strictEqual(stateAt2_1.scoreB, 1);
    assert.strictEqual(stateAt2_1.servingTeam, 'teamB', 'Mumbai becomes serving team');
    // NO SWAPS on either team:
    assert.strictEqual(stateAt2_1.playerLocations['K_P1'], 'RIGHT', 'Kundan P1 stays Right');
    assert.strictEqual(stateAt2_1.playerLocations['K_P2'], 'LEFT', 'Kundan P2 stays Left');
    assert.strictEqual(stateAt2_1.playerLocations['M_P1'], 'RIGHT', 'Mumbai P1 stays Right');
    assert.strictEqual(stateAt2_1.playerLocations['M_P2'], 'LEFT', 'Mumbai P2 stays Left');
    // Mumbai serves from Left box (1 is odd -> Left court):
    assert.strictEqual(stateAt2_1.serviceCourt, 'LEFT');
    assert.strictEqual(stateAt2_1.servingBoxName, 'bottom-right', 'Mumbai on right side: Left court is bottom-right box');
    // Server is Mumbai player standing in Left court (M_P2):
    assert.strictEqual(stateAt2_1.servingPlayer?.id, 'M_P2', 'Mumbai server is player in Left box');

    // 2. Mumbai (now serving at 1) wins the next rally:
    // score 2-2, only Mumbai swaps (P1 Left, P2 Right), Mumbai serves from Right box, Kundan unchanged.
    const stateAt2_2 = applyPointToCourtState(stateAt2_1, { pointTo: 'teamB', seq: 4 }, kundanMumbaiConfig);
    assert.strictEqual(stateAt2_2.scoreA, 2);
    assert.strictEqual(stateAt2_2.scoreB, 2);
    assert.strictEqual(stateAt2_2.servingTeam, 'teamB');
    // ONLY Mumbai swaps:
    assert.strictEqual(stateAt2_2.playerLocations['M_P1'], 'LEFT', 'Mumbai P1 swapped to Left');
    assert.strictEqual(stateAt2_2.playerLocations['M_P2'], 'RIGHT', 'Mumbai P2 swapped to Right');
    // Kundan unchanged:
    assert.strictEqual(stateAt2_2.playerLocations['K_P1'], 'RIGHT', 'Kundan P1 unchanged');
    assert.strictEqual(stateAt2_2.playerLocations['K_P2'], 'LEFT', 'Kundan P2 unchanged');
    // Mumbai serves from Right box (2 is even -> Right court):
    assert.strictEqual(stateAt2_2.serviceCourt, 'RIGHT');
    assert.strictEqual(stateAt2_2.servingBoxName, 'top-right', 'Mumbai on right side: Right court is top-right box');
    assert.strictEqual(stateAt2_2.servingPlayer?.id, 'M_P2', 'Same player (M_P2) keeps serving from Right court');

    // 3. Kundan wins as receiver at 3-2:
    // no swaps, Kundan serves from Left box (3 is odd), and the server is the Kundan player standing in the Left court.
    const stateAt3_2 = applyPointToCourtState(stateAt2_2, { pointTo: 'teamA', seq: 5 }, kundanMumbaiConfig);
    assert.strictEqual(stateAt3_2.scoreA, 3);
    assert.strictEqual(stateAt3_2.scoreB, 2);
    assert.strictEqual(stateAt3_2.servingTeam, 'teamA');
    // NO SWAPS:
    assert.strictEqual(stateAt3_2.playerLocations['K_P1'], 'RIGHT', 'Kundan P1 stays Right');
    assert.strictEqual(stateAt3_2.playerLocations['K_P2'], 'LEFT', 'Kundan P2 stays Left');
    assert.strictEqual(stateAt3_2.playerLocations['M_P1'], 'LEFT', 'Mumbai P1 stays Left');
    assert.strictEqual(stateAt3_2.playerLocations['M_P2'], 'RIGHT', 'Mumbai P2 stays Right');
    // Kundan serves from Left box (3 is odd):
    assert.strictEqual(stateAt3_2.serviceCourt, 'LEFT');
    assert.strictEqual(stateAt3_2.servingBoxName, 'top-left', 'Kundan on left side: Left court is top-left box');
    assert.strictEqual(stateAt3_2.servingPlayer?.id, 'K_P2', 'Server is Kundan player standing in Left court (K_P2)');

    // 4. Undo and refresh restore the exact same positions and server:
    const historyLogs = [
      { pointTo: 'teamA', seq: 1 },
      { pointTo: 'teamA', seq: 2 },
      { pointTo: 'teamB', seq: 3 },
      { pointTo: 'teamB', seq: 4 },
      { pointTo: 'teamA', seq: 5 }
    ];
    // Replay from history (simulating page refresh / reconnect):
    const stateReplayed = computeCourtStateFromHistory(kundanMumbaiConfig, historyLogs);
    assert.deepStrictEqual(stateReplayed.playerLocations, stateAt3_2.playerLocations);
    assert.strictEqual(stateReplayed.servingPlayer?.id, stateAt3_2.servingPlayer?.id);
    assert.strictEqual(stateReplayed.servingBoxName, stateAt3_2.servingBoxName);

    // Undo from 3-2 back to 2-2:
    const stateUndone = computeCourtStateFromHistory(kundanMumbaiConfig, historyLogs.slice(0, 4));
    assert.deepStrictEqual(stateUndone.playerLocations, stateAt2_2.playerLocations);
    assert.strictEqual(stateUndone.servingPlayer?.id, stateAt2_2.servingPlayer?.id);
    assert.strictEqual(stateUndone.servingBoxName, stateAt2_2.servingBoxName);
    assert.strictEqual(stateUndone.scoreA, 2);
    assert.strictEqual(stateUndone.scoreB, 2);

    // 5. Singles behaviour is unchanged:
    const singlesConfig = {
      ...kundanMumbaiConfig,
      format: 'SINGLES',
      lineup: {
        teamA: [{ id: 'K_Solo', name: 'Kuldeep (Solo)' }],
        teamB: [{ id: 'M_Solo', name: 'Hardik (Solo)' }]
      }
    };
    let sSingles = getInitialCourtState(singlesConfig);
    assert.strictEqual(sSingles.servingPlayer?.id, 'K_Solo');
    sSingles = applyPointToCourtState(sSingles, { pointTo: 'teamA', seq: 1 }, singlesConfig);
    assert.strictEqual(sSingles.serviceCourt, 'LEFT', 'Score 1 is odd -> Left court');
    sSingles = applyPointToCourtState(sSingles, { pointTo: 'teamB', seq: 2 }, singlesConfig);
    assert.strictEqual(sSingles.servingTeam, 'teamB');
    assert.strictEqual(sSingles.serviceCourt, 'LEFT', 'Score 1 is odd -> Left court');
    assert.strictEqual(sSingles.servingPlayer?.id, 'M_Solo');
  });

});

