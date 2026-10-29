import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculatePickleballDoublesPositions,
  PickleballAdapter,
  BadmintonAdapter,
  FallbackAdapter,
  getSportAdapter,
  getInitialCourtState,
  applyPointToCourtState,
  computeCourtStateFromHistory,
  getScreenBox,
  getDiagonalReceiverBox
} from '../frontend/src/components/court/courtRulesEngine.js';

describe('Court Rules Engine - Comprehensive Test Suite', () => {

  // ───────────────────────────────────────────────────────────────────────────
  // 1. PICKLEBALL SIDE-OUT DOUBLES REGRESSION TEST (Prompt Specification)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Pickleball Side-Out Doubles (Exact Rulebook & Prompt Scenarios)', () => {
    const config = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'SIDE_OUT',
      teamA: { id: 'teamA', name: 'Pickle Pros' },
      teamB: { id: 'teamB', name: 'Dink Masters' },
      lineup: {
        teamA: [{ id: 'A1', name: 'Alice' }, { id: 'A2', name: 'Aaron' }],
        teamB: [{ id: 'B1', name: 'Bob' }, { id: 'B2', name: 'Betty' }]
      },
      startingServingTeam: 'teamA'
    };

    it('Step 0: Initial Start at 0-0-2 from Right Court', () => {
      const state = getInitialCourtState(config);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serverNumber, 2, 'Initial server in PB Side-out doubles starts at Server #2');
      assert.strictEqual(state.serviceCourt, 'RIGHT', 'First serve is from the right court');
      assert.strictEqual(state.servingBoxName, 'bottom-left', 'Team on left facing right: Right court is bottom-left');
      assert.strictEqual(state.targetBoxName, 'top-right', 'Diagonal cross-court to Right team Right court');
      assert.strictEqual(state.callText, '0 - 0 - 2');
    });

    it('Step 1: B wins rally -> Immediate Side-Out to B, score 0-0, "0-0-1", no score for B, serve from right', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 });

      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0, 'No point awarded on side-out in side-out scoring');
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serverNumber, 1, 'New serving team starts with Server #1');
      assert.strictEqual(state.serviceCourt, 'RIGHT', 'B serves from right court');
      assert.strictEqual(state.servingBoxName, 'top-right', 'Team on right: Right court is top-right');
      assert.strictEqual(state.targetBoxName, 'bottom-left');
      assert.strictEqual(state.isSideOut, true, 'isSideOut flag must be true');
      assert.strictEqual(state.isPointScored, false, 'isPointScored must be false');
      assert.deepStrictEqual(state.movingPlayerIds, [], 'No player swap on side-out');
      assert.strictEqual(state.callText, '0 - 0 - 1');
    });

    it('Step 2: B wins rally -> B scores 1 point, B players switch, server serves from Left ("1-0-1")', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 }); // Side-out to B
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // B scores point on serve!

      assert.strictEqual(state.scoreB, 1, 'B scores 1 point');
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serverNumber, 1);
      assert.strictEqual(state.isPointScored, true);
      assert.strictEqual(state.scoringTeam, 'teamB');
      assert.strictEqual(state.movingPlayerIds.length, 2, 'B partners must switch courts');
      assert.strictEqual(state.callText, '1 - 0 - 1');
    });

    it('Step 3: B loses next rally -> Server #2 serves ("1-0-2"), no player switch', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 }); // Side-out to B
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // B point (1-0-1)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 3 }); // B loses rally

      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serverNumber, 2, 'Moves to Server #2');
      assert.strictEqual(state.isSideOut, false, 'Not a side out yet, just server change');
      assert.strictEqual(state.isServerChange, true);
      assert.strictEqual(state.isPointScored, false);
      assert.deepStrictEqual(state.movingPlayerIds, [], 'No players switch when losing rally');
      assert.strictEqual(state.callText, '1 - 0 - 2');
    });

    it('Step 4: Server #2 loses -> Side-out to A with A right-court player as Server #1', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 }); // Side-out to B
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // B point (1-0-1)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 3 }); // Server 2 (1-0-2)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 4 }); // Server 2 loses -> Side-out to A

      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serverNumber, 1, 'A becomes Server #1');
      assert.strictEqual(state.isSideOut, true);
      assert.strictEqual(state.isPointScored, false);
      assert.strictEqual(state.callText, '0 - 1 - 1');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. PICKLEBALL RALLY SCORING REGRESSION TEST (Prompt Specification)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Pickleball Rally Scoring (Exact Prompt Transitions)', () => {
    const config = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      teamA: { id: 'teamA', name: 'Team A' },
      teamB: { id: 'teamB', name: 'Team B' },
      lineup: {
        teamA: ['A1', 'A2'],
        teamB: ['B1', 'B2']
      },
      startingServingTeam: 'teamA'
    };

    it('Executes the exact 4-step sequence from prompt with odd/even player positions', () => {
      // 0. A serves from right at 0-0
      let state = getInitialCourtState(config);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT');
      assert.strictEqual(state.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['B2'], 'LEFT');

      // 1. B wins -> B scores 1 (odd) and gains serve. Receiving team NEVER swaps!
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 });
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serviceCourt, 'LEFT', 'Score 1 is odd -> serve from left');
      assert.strictEqual(state.playerLocations['B1'], 'RIGHT', 'B1 (started right) remains in RIGHT because B was receiving (no swap)');
      assert.strictEqual(state.playerLocations['B2'], 'LEFT', 'B2 (started left) remains in LEFT because B was receiving (no swap)');
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT', 'A1 unchanged at score 0');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT', 'A2 unchanged at score 0');
      assert.strictEqual(state.movingPlayerIds.length, 0, 'No players switch when service changes to receiving team');

      // 2. B wins again -> B 2 (even), B won while serving so B players swap! Serves from right
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 });
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serviceCourt, 'RIGHT', 'Score 2 is even -> serve from right');
      assert.strictEqual(state.playerLocations['B1'], 'LEFT', 'B1 moves to LEFT when B scores on own serve');
      assert.strictEqual(state.playerLocations['B2'], 'RIGHT', 'B2 moves to RIGHT when B scores on own serve');
      assert.strictEqual(state.movingPlayerIds.length, 2, 'B players switch when winning point on own serve');

      // 3. A wins -> A scores 1 (odd) and gains serve. A was receiving -> NO SWAP!
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 3 });
      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'LEFT', 'Score 1 is odd -> serve from left');
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT', 'A1 remains in RIGHT (receiving team does not swap)');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT', 'A2 remains in LEFT (receiving team does not swap)');
      assert.strictEqual(state.playerLocations['B1'], 'LEFT', 'B positions remain unchanged');
      assert.strictEqual(state.playerLocations['B2'], 'RIGHT', 'B positions remain unchanged');
      assert.strictEqual(state.movingPlayerIds.length, 0, 'No swap on service change');

      // 4. A wins again -> A 2 (even), A won while serving so A players swap! Serves from right
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 4 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT', 'Score 2 is even -> serve from right');
      assert.strictEqual(state.playerLocations['A1'], 'LEFT', 'A1 moves to LEFT when scoring on own serve');
      assert.strictEqual(state.playerLocations['A2'], 'RIGHT', 'A2 moves to RIGHT when scoring on own serve');
      assert.strictEqual(state.movingPlayerIds.length, 2, 'A players switch when scoring on own serve');
    });

    it('Executes the exact 7-step match example from user specification', () => {
      const matchConfig = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'RALLY',
        teamA: { id: 'teamA', name: 'Team A' },
        teamB: { id: 'teamB', name: 'Team B' },
        lineup: {
          teamA: [{ id: 'pA1', name: 'Alice' }, { id: 'pA2', name: 'Aaron' }],
          teamB: [{ id: 'pB1', name: 'Bob' }, { id: 'pB2', name: 'Betty' }]
        },
        startingServingTeam: 'teamA',
        targetScore: 15
      };

      // Step 0: Match starts (0 - 0)
      let state = getInitialCourtState(matchConfig);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.playerLocations['pA1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pA2'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pB2'], 'LEFT');

      // Step 1: Team A wins rally -> 1 - 0 (A was serving -> A players swap)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.playerLocations['pA1'], 'LEFT');
      assert.strictEqual(state.playerLocations['pA2'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pB1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pB2'], 'LEFT');

      // Step 2: Team A wins rally -> 2 - 0 (A was serving -> A players swap)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.playerLocations['pA1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pA2'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pB2'], 'LEFT');

      // Step 3: Team B wins rally -> 2 - 1 (B was receiving -> NO SWAP for either team)
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 3 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.playerLocations['pA1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pA2'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB1'], 'RIGHT', 'B was receiving: NO SWAP');
      assert.strictEqual(state.playerLocations['pB2'], 'LEFT', 'B was receiving: NO SWAP');

      // Step 4: Team B wins rally -> 2 - 2 (B was serving -> B players swap)
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 4 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.playerLocations['pA1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pA2'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB1'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB2'], 'RIGHT');

      // Step 5: Team A wins rally -> 3 - 2 (A was receiving -> NO SWAP)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 5 });
      assert.strictEqual(state.scoreA, 3);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.playerLocations['pA1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pA2'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB1'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB2'], 'RIGHT');

      // Step 6: Team A wins rally -> 4 - 2 (A was serving -> A players swap)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 6 });
      assert.strictEqual(state.scoreA, 4);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.playerLocations['pA1'], 'LEFT');
      assert.strictEqual(state.playerLocations['pA2'], 'RIGHT');
      assert.strictEqual(state.playerLocations['pB1'], 'LEFT');
      assert.strictEqual(state.playerLocations['pB2'], 'RIGHT');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. BADMINTON DOUBLES REGRESSION TEST (BWF Standard)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Badminton Doubles (BWF Rulebook & Parity)', () => {
    const config = {
      sport: 'badminton',
      format: 'DOUBLES',
      teamA: { id: 'teamA', name: 'Ace Smashers' },
      teamB: { id: 'teamB', name: 'Shuttle Masters' },
      lineup: {
        teamA: [{ id: 'pA1', name: 'Viktor' }, { id: 'pA2', name: 'Anders' }],
        teamB: [{ id: 'pB1', name: 'Kento' }, { id: 'pB2', name: 'Takuro' }]
      },
      startingServingTeam: 'teamA'
    };

    it('Starts at 0-0, server serves from RIGHT court, receiver at RIGHT court diagonal', () => {
      const state = getInitialCourtState(config);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      assert.strictEqual(state.targetBoxName, 'top-right');
      assert.strictEqual(state.servingPlayer.name, 'Viktor');
      assert.strictEqual(state.receivingPlayer.name, 'Kento');
    });

    it('Serving side wins point -> score 1-0, only serving side swaps, server serves from LEFT', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });

      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'LEFT', 'Score 1 is odd -> serve from left court');
      assert.strictEqual(state.servingBoxName, 'top-left');
      assert.strictEqual(state.targetBoxName, 'bottom-right');
      assert.strictEqual(state.movingPlayerIds.length, 2, 'Serving team partners swapped courts');
      assert.strictEqual(state.servingPlayer.name, 'Viktor', 'Same server Viktor serves from left');
      assert.strictEqual(state.receivingPlayer.name, 'Takuro', 'Diagonal receiver is now Takuro');
    });

    it('Receiving side wins rally -> score 1-1, gains serve, NO swap, server by parity', () => {
      let state = getInitialCourtState(config);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }); // A 1-0
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // B wins rally

      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.isSideOut, true);
      assert.strictEqual(state.serviceCourt, 'LEFT', 'B score is 1 (odd) -> serve from left court');
      assert.deepStrictEqual(state.movingPlayerIds, [], 'No player swap when receiving side wins rally');
      assert.strictEqual(state.servingBoxName, 'bottom-right');
      assert.strictEqual(state.targetBoxName, 'top-left');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. SINGLES VS DOUBLES
  // ───────────────────────────────────────────────────────────────────────────
  describe('Singles Format Handling', () => {
    it('Badminton Singles: exactly 1 player per side, switches boxes by score parity', () => {
      const config = {
        sport: 'badminton',
        format: 'SINGLES',
        teamA: { id: 'teamA', name: 'Player A' },
        teamB: { id: 'teamB', name: 'Player B' },
        lineup: { teamA: ['Lee'], teamB: ['Lin'] }
      };

      let state = getInitialCourtState(config);
      assert.strictEqual(state.players.length, 2);
      assert.strictEqual(state.serviceCourt, 'RIGHT');

      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.serviceCourt, 'LEFT');

      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.serviceCourt, 'RIGHT');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. HISTORY REPLAY, REVERSIBILITY & UNDO
  // ───────────────────────────────────────────────────────────────────────────
  describe('History Replay and Deterministic Undo', () => {
    it('Recomputing from history matches incremental stepping identically', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Team A' },
        teamB: { id: 'teamB', name: 'Team B' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
      };

      const history = [
        { sequence_number: 1, point_to: 'team_b' },
        { sequence_number: 2, point_to: 'team_b' },
        { sequence_number: 3, point_to: 'team_a' }
      ];

      const replayedState = computeCourtStateFromHistory(config, history);

      // Incremental simulation
      let steppedState = getInitialCourtState(config);
      steppedState = applyPointToCourtState(steppedState, { pointTo: 'teamB', seq: 1 });
      steppedState = applyPointToCourtState(steppedState, { pointTo: 'teamB', seq: 2 });
      steppedState = applyPointToCourtState(steppedState, { pointTo: 'teamA', seq: 3 });

      assert.strictEqual(replayedState.scoreA, steppedState.scoreA);
      assert.strictEqual(replayedState.scoreB, steppedState.scoreB);
      assert.strictEqual(replayedState.servingTeam, steppedState.servingTeam);
      assert.strictEqual(replayedState.serverNumber, steppedState.serverNumber);
      assert.strictEqual(replayedState.serviceCourt, steppedState.serviceCourt);
      assert.strictEqual(replayedState.servingBoxName, steppedState.servingBoxName);
      assert.strictEqual(replayedState.targetBoxName, steppedState.targetBoxName);
    });

    it('Undo cleanly rolls back to exact previous state', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Team A' },
        teamB: { id: 'teamB', name: 'Team B' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
      };

      const history = [
        { sequence_number: 1, point_to: 'team_b' },
        { sequence_number: 2, point_to: 'team_b' }
      ];

      const stateBeforePoint = computeCourtStateFromHistory(config, [history[0]]);
      const stateAfterPoint = computeCourtStateFromHistory(config, history);
      const stateAfterUndo = computeCourtStateFromHistory(config, history.slice(0, 1));

      assert.strictEqual(stateAfterUndo.scoreB, stateBeforePoint.scoreB);
      assert.strictEqual(stateAfterUndo.servingTeam, stateBeforePoint.servingTeam);
      assert.strictEqual(stateAfterUndo.serverNumber, stateBeforePoint.serverNumber);
      assert.strictEqual(stateAfterUndo.serviceCourt, stateBeforePoint.serviceCourt);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 6. GAME POINT & MATCH CONCLUSION
  // ───────────────────────────────────────────────────────────────────────────
  describe('Game Point & Match Completion Status', () => {
    it('Detects game point and match completion at target score with win by 2', () => {
      const config = {
        sport: 'pickleball',
        targetScore: 11,
        winByTwo: true,
        teamA: { id: 'teamA', name: 'A' },
        teamB: { id: 'teamB', name: 'B' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
      };

      const historyTo10 = [];
      // Give A 10 points on serve
      for (let i = 1; i <= 10; i++) {
        historyTo10.push({ sequence_number: i, point_to: 'team_a' });
      }

      const stateAt10 = computeCourtStateFromHistory(config, historyTo10);
      assert.strictEqual(stateAt10.scoreA, 10);
      assert.strictEqual(stateAt10.isGamePoint, true);
      assert.strictEqual(stateAt10.gameStatus, 'GAME_POINT');

      // 11th point -> MATCH WON!
      const historyTo11 = [...historyTo10, { sequence_number: 11, point_to: 'team_a' }];
      const stateAt11 = computeCourtStateFromHistory(config, historyTo11);
      assert.strictEqual(stateAt11.scoreA, 11);
      assert.strictEqual(stateAt11.gameStatus, 'COMPLETED');
      assert.strictEqual(stateAt11.isMatchWon, true);
      assert.strictEqual(stateAt11.winner, 'teamA');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 7. LINEUP TBA & SAFE FALLBACK
  // ───────────────────────────────────────────────────────────────────────────
  describe('Lineup TBA & Unset Roster Handling', () => {
    it('Displays team names and quiet Lineup TBA when lineup is empty, never invented names', () => {
      const config = {
        sport: 'pickleball',
        teamA: { id: 'teamA', name: 'Eagles' },
        teamB: { id: 'teamB', name: 'Falcons' },
        lineup: { teamA: [], teamB: [] }
      };

      const state = getInitialCourtState(config);
      assert.strictEqual(state.isLineupSetA, false);
      assert.strictEqual(state.isLineupSetB, false);

      const aPlayers = state.players.filter(p => p.team === 'teamA');
      assert.strictEqual(aPlayers.length, 2);
      assert.strictEqual(aPlayers[0].name, 'Eagles');
      assert.strictEqual(aPlayers[0].secondaryLabel, 'Lineup TBA');
      assert.strictEqual(aPlayers[0].isTBA, true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 8. FALLBACK SPORT ADAPTER
  // ───────────────────────────────────────────────────────────────────────────
  describe('Fallback Sport Adapter (Tennis/Squash)', () => {
    it('Fallback adapter safely runs without applying pickleball/badminton specific side-out rules', () => {
      const adapter = getSportAdapter('tennis');
      assert.strictEqual(adapter.sport, 'fallback');

      const config = {
        sport: 'tennis',
        teamA: { id: 'teamA', name: 'Alcaraz' },
        teamB: { id: 'teamB', name: 'Sinner' }
      };

      const state = getInitialCourtState(config);
      assert.strictEqual(state.serviceCourt, 'RIGHT');

      const next = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }, config);
      assert.strictEqual(next.scoreA, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. EVEN -> ODD AND ODD -> EVEN TRANSITIONS
  // ───────────────────────────────────────────────────────────────────────────
  describe('Even <-> Odd Parity Transitions', () => {
    it('Badminton: strictly toggles RIGHT (even) and LEFT (odd) service courts on consecutive points', () => {
      const config = {
        sport: 'badminton',
        format: 'DOUBLES',
        teamA: { id: 'teamA', name: 'Ace' },
        teamB: { id: 'teamB', name: 'Shuttle' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
      };

      let state = getInitialCourtState(config);
      assert.strictEqual(state.serviceCourt, 'RIGHT', '0 is even -> RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');

      // Point 1: 1 - 0 (Odd)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.serviceCourt, 'LEFT', '1 is odd -> LEFT');
      assert.strictEqual(state.servingBoxName, 'top-left');

      // Point 2: 2 - 0 (Even)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.serviceCourt, 'RIGHT', '2 is even -> RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');

      // Point 3: 3 - 0 (Odd)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 3 });
      assert.strictEqual(state.scoreA, 3);
      assert.strictEqual(state.serviceCourt, 'LEFT', '3 is odd -> LEFT');
      assert.strictEqual(state.servingBoxName, 'top-left');

      // Point 4: 4 - 0 (Even)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 4 });
      assert.strictEqual(state.scoreA, 4);
      assert.strictEqual(state.serviceCourt, 'RIGHT', '4 is even -> RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
    });

    it('Pickleball Side-Out: Same server switches courts continuously on consecutive points', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'A' },
        teamB: { id: 'teamB', name: 'B' },
        lineup: { teamA: ['Alice', 'Aaron'], teamB: ['Bob', 'Betty'] }
      };

      let state = getInitialCourtState(config);
      // Side-out to B
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 });
      assert.strictEqual(state.callText, '0 - 0 - 1');
      assert.strictEqual(state.serviceCourt, 'RIGHT');

      // B point 1 -> 1-0-1, server serves from LEFT
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 });
      assert.strictEqual(state.callText, '1 - 0 - 1');
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.servingPlayer.name, 'Bob');

      // B point 2 -> 2-0-1, server switches back to RIGHT
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 3 });
      assert.strictEqual(state.callText, '2 - 0 - 1');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.servingPlayer.name, 'Bob');

      // B point 3 -> 3-0-1, server switches back to LEFT
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 4 });
      assert.strictEqual(state.callText, '3 - 0 - 1');
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.servingPlayer.name, 'Bob');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. CHANGE OF ENDS (BWF & USAP)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Change of Ends (Switching Sides)', () => {
    it('Game 2 switches ends between teams (Team A right, Team B left)', () => {
      const config = {
        sport: 'badminton',
        format: 'DOUBLES',
        teamA: { id: 'teamA', name: 'Ace' },
        teamB: { id: 'teamB', name: 'Shuttle' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        switchEnds: true,
        currentGame: 2
      };

      const state = getInitialCourtState(config);
      assert.strictEqual(state.teamSides.teamA, 'RIGHT');
      assert.strictEqual(state.teamSides.teamB, 'LEFT');
      // If Team A serves from RIGHT court on right screen half, screen box is top-right!
      assert.strictEqual(state.servingBoxName, 'top-right');
      assert.strictEqual(state.targetBoxName, 'bottom-left');
    });

    it('Deciding game: automatically switches ends when leading team reaches interval threshold (11 pts in Badminton)', () => {
      const config = {
        sport: 'badminton',
        format: 'SINGLES',
        teamA: { id: 'teamA', name: 'Viktor' },
        teamB: { id: 'teamB', name: 'Lee' },
        switchEnds: true,
        currentGame: 3
      };

      let state = getInitialCourtState(config);
      assert.strictEqual(state.teamSides.teamA, 'LEFT');

      // Score up to 10 - 5
      for (let i = 1; i <= 10; i++) {
        state = applyPointToCourtState(state, { pointTo: 'teamA', seq: i });
      }
      assert.strictEqual(state.scoreA, 10);
      assert.strictEqual(state.teamSides.teamA, 'LEFT', 'Before 11, team A stays on LEFT');

      // 11th point reached -> interval switch ends!
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 11 });
      assert.strictEqual(state.scoreA, 11);
      assert.strictEqual(state.teamSides.teamA, 'RIGHT', 'At 11 in Game 3, team A switches to RIGHT');
      assert.strictEqual(state.teamSides.teamB, 'LEFT');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. MATCH RESTART & UNDO OF EACH TRANSITION
  // ───────────────────────────────────────────────────────────────────────────
  describe('Match Restart & Comprehensive Undo Verification', () => {
    const config = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'SIDE_OUT',
      teamA: { id: 'teamA', name: 'Team A' },
      teamB: { id: 'teamB', name: 'Team B' },
      lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
    };

    it('Cleanly restarts to initial 0-0-2 state with identical court locations', () => {
      const state1 = getInitialCourtState(config);
      const stepped = applyPointToCourtState(state1, { pointTo: 'teamB', seq: 1 });
      const restarted = getInitialCourtState(config);

      assert.strictEqual(restarted.scoreA, 0);
      assert.strictEqual(restarted.scoreB, 0);
      assert.strictEqual(restarted.serverNumber, 2);
      assert.strictEqual(restarted.callText, '0 - 0 - 2');
      assert.deepStrictEqual(restarted.playerLocations, state1.playerLocations);
    });

    it('Undo after side-out restores server 2 and previous serving team', () => {
      const h1 = { sequence_number: 1, point_to: 'team_b' }; // side out to B (0-0-1)
      const h2 = { sequence_number: 2, point_to: 'team_b' }; // B point (1-0-1)
      const h3 = { sequence_number: 3, point_to: 'team_a' }; // B loses -> Server 2 (1-0-2)
      const h4 = { sequence_number: 4, point_to: 'team_a' }; // Server 2 loses -> Side out to A (0-1-1)

      const stateAt4 = computeCourtStateFromHistory(config, [h1, h2, h3, h4]);
      assert.strictEqual(stateAt4.servingTeam, 'teamA');
      assert.strictEqual(stateAt4.serverNumber, 1);

      // Undo h4 -> back to B serving as Server #2
      const stateUndone = computeCourtStateFromHistory(config, [h1, h2, h3]);
      assert.strictEqual(stateUndone.servingTeam, 'teamB');
      assert.strictEqual(stateUndone.serverNumber, 2);
      assert.strictEqual(stateUndone.callText, '1 - 0 - 2');
    });

    it('Undo after partner switch restores exact previous court locations', () => {
      const h1 = { sequence_number: 1, point_to: 'team_b' }; // side out
      const h2 = { sequence_number: 2, point_to: 'team_b' }; // B point -> B partners switch

      const stateBeforeSwap = computeCourtStateFromHistory(config, [h1]);
      const stateAfterSwap = computeCourtStateFromHistory(config, [h1, h2]);

      assert.notDeepStrictEqual(stateBeforeSwap.playerLocations, stateAfterSwap.playerLocations);

      // Undo swap
      const stateAfterUndo = computeCourtStateFromHistory(config, [h1]);
      assert.deepStrictEqual(stateAfterUndo.playerLocations, stateBeforeSwap.playerLocations);
    });

    it('Undo from game-winning point reverts game status back to GAME_POINT / LIVE', () => {
      const testConfig = {
        sport: 'pickleball',
        targetScore: 11,
        winByTwo: true,
        teamA: { id: 'teamA', name: 'A' },
        teamB: { id: 'teamB', name: 'B' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] }
      };

      const history = [];
      for (let i = 1; i <= 10; i++) {
        history.push({ sequence_number: i, point_to: 'team_a' });
      }
      history.push({ sequence_number: 11, point_to: 'team_a' }); // 11th point -> MATCH WON

      const wonState = computeCourtStateFromHistory(testConfig, history);
      assert.strictEqual(wonState.isMatchWon, true);
      assert.strictEqual(wonState.gameStatus, 'COMPLETED');

      // Undo final winning shot
      const undoneState = computeCourtStateFromHistory(testConfig, history.slice(0, 10));
      assert.strictEqual(undoneState.isMatchWon, false);
      assert.strictEqual(undoneState.isGamePoint, true);
      assert.strictEqual(undoneState.gameStatus, 'GAME_POINT');
      assert.strictEqual(undoneState.scoreA, 10);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 13. SECTION 8 REQUIRED REGRESSION TESTS: ODD/EVEN RULES & PARTNER SWITCHING
  // ───────────────────────────────────────────────────────────────────────────
  describe('Pickleball Position Switching - Required Regression Tests (Section 8)', () => {
    const originalPositions = {
      pRight: 'RIGHT',
      pLeft: 'LEFT'
    };

    // Minimum Required Table:
    // Score 0 -> Right, Left
    // Score 1 -> Left, Right
    // Score 2 -> Right, Left
    // Score 3 -> Left, Right
    // Score 4 -> Right, Left
    // Score 5 -> Left, Right
    it('Table Test: Verifies odd/even court calculation for scores 0 through 5', () => {
      const table = [
        { score: 0, expectedRight: 'RIGHT', expectedLeft: 'LEFT' },
        { score: 1, expectedRight: 'LEFT',  expectedLeft: 'RIGHT' },
        { score: 2, expectedRight: 'RIGHT', expectedLeft: 'LEFT' },
        { score: 3, expectedRight: 'LEFT',  expectedLeft: 'RIGHT' },
        { score: 4, expectedRight: 'RIGHT', expectedLeft: 'LEFT' },
        { score: 5, expectedRight: 'LEFT',  expectedLeft: 'RIGHT' },
      ];

      for (const row of table) {
        const positions = calculatePickleballDoublesPositions(row.score, originalPositions);
        assert.strictEqual(
          positions.pRight,
          row.expectedRight,
          `At score ${row.score}, player who started right must be on ${row.expectedRight}`
        );
        assert.strictEqual(
          positions.pLeft,
          row.expectedLeft,
          `At score ${row.score}, player who started left must be on ${row.expectedLeft}`
        );
      }
    });

    it('1. Team A and Team B positions are calculated independently', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        scores: { teamA: 3, teamB: 4 } // A is odd (3), B is even (4)
      };

      const state = getInitialCourtState(config);
      // Team A (score 3 - odd): A1 (started right) is in LEFT, A2 (started left) is in RIGHT
      assert.strictEqual(state.playerLocations['A1'], 'LEFT');
      assert.strictEqual(state.playerLocations['A2'], 'RIGHT');

      // Team B (score 4 - even): B1 (started right) is in RIGHT, B2 (started left) is in LEFT
      assert.strictEqual(state.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['B2'], 'LEFT');
    });

    it('2. A serving-team point causes the correct position change when required', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        startingServingTeam: 'teamA'
      };

      let state = getInitialCourtState(config);
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT');

      // Serving team A scores point: score becomes 1
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.playerLocations['A1'], 'LEFT');
      assert.strictEqual(state.playerLocations['A2'], 'RIGHT');
      assert.deepStrictEqual(state.movingPlayerIds.sort(), ['A1', 'A2']);

      // Serving team A scores second point: score becomes 2 (even)
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 });
      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT');
      assert.deepStrictEqual(state.movingPlayerIds.sort(), ['A1', 'A2']);
    });

    it('3. A side-out does not blindly swap both teams', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        startingServingTeam: 'teamA'
      };

      let state = getInitialCourtState(config);
      // Team A starts on 0-0-2. Losing the rally causes immediate side-out to Team B.
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 1 });

      assert.strictEqual(state.isSideOut, true);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.deepStrictEqual(state.movingPlayerIds, [], 'Neither team swaps on side-out');
      assert.strictEqual(state.playerLocations['A1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['A2'], 'LEFT');
      assert.strictEqual(state.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['B2'], 'LEFT');
    });

    it('4. The receiving team positions remain correct after the other team scores', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        startingServingTeam: 'teamA'
      };

      let state = getInitialCourtState(config);
      // Team A scores 3 consecutive points: 1, 2, 3
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 2 });
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 3 });

      assert.strictEqual(state.scoreA, 3);
      assert.strictEqual(state.scoreB, 0);

      // Team B (receiving team) score is still 0 (even) -> B1 in RIGHT, B2 in LEFT
      assert.strictEqual(state.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(state.playerLocations['B2'], 'LEFT');
    });

    it('5. Player identities and names remain attached to the same players', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: {
          teamA: [{ id: 'pA_right', name: 'Alice Right' }, { id: 'pA_left', name: 'Aaron Left' }],
          teamB: [{ id: 'pB_right', name: 'Bob Right' }, { id: 'pB_left', name: 'Betty Left' }]
        },
        startingServingTeam: 'teamA'
      };

      let state = getInitialCourtState(config);
      // At score 0: Alice is in RIGHT court
      const alice0 = state.players.find(p => p.id === 'pA_right');
      assert.strictEqual(alice0.court, 'RIGHT');
      assert.strictEqual(alice0.name, 'Alice Right');

      // Team A scores 1: Alice moves to LEFT court
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      const alice1 = state.players.find(p => p.id === 'pA_right');
      assert.strictEqual(alice1.court, 'LEFT');
      assert.strictEqual(alice1.name, 'Alice Right', 'Name remains attached to Alice');
      assert.strictEqual(alice1.id, 'pA_right');
    });

    it('6. Singles matches do not swap partners', () => {
      const config = {
        sport: 'pickleball',
        format: 'SINGLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Solo A' },
        teamB: { id: 'teamB', name: 'Solo B' },
        lineup: { teamA: ['S1'], teamB: ['S2'] },
        startingServingTeam: 'teamA'
      };

      let state = getInitialCourtState(config);
      assert.strictEqual(state.players.length, 2, 'Singles has exactly 2 players total');
      assert.strictEqual(state.playerLocations['S1'], 'RIGHT');

      // S1 scores: court becomes LEFT (odd parity), no partner to swap
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });
      assert.strictEqual(state.playerLocations['S1'], 'LEFT');
      assert.deepStrictEqual(state.movingPlayerIds, ['S1']);
    });

    it('7. Undo and score corrections restore correct positions', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        startingServingTeam: 'teamA'
      };

      const history = [
        { sequence_number: 1, point_to: 'team_a' }, // score 1-0: A1 in LEFT, A2 in RIGHT
        { sequence_number: 2, point_to: 'team_a' }, // score 2-0: A1 in RIGHT, A2 in LEFT
      ];

      const state2 = computeCourtStateFromHistory(config, history);
      assert.strictEqual(state2.scoreA, 2);
      assert.strictEqual(state2.playerLocations['A1'], 'RIGHT');

      // Undo back to score 1
      const state1 = computeCourtStateFromHistory(config, history.slice(0, 1));
      assert.strictEqual(state1.scoreA, 1);
      assert.strictEqual(state1.playerLocations['A1'], 'LEFT');
      assert.strictEqual(state1.playerLocations['A2'], 'RIGHT');

      // Manual referee correction to 5-2
      const historyWithCorrection = [
        ...history,
        { sequence_number: 3, event_type: 'CORRECTION', team_a_score: 5, team_b_score: 2 }
      ];
      const correctedState = computeCourtStateFromHistory(config, historyWithCorrection);
      assert.strictEqual(correctedState.scoreA, 5);
      assert.strictEqual(correctedState.scoreB, 2);
      // Score 5 is odd -> A1 in LEFT, A2 in RIGHT
      assert.strictEqual(correctedState.playerLocations['A1'], 'LEFT');
      assert.strictEqual(correctedState.playerLocations['A2'], 'RIGHT');
      // Score 2 is even -> B1 in RIGHT, B2 in LEFT
      assert.strictEqual(correctedState.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(correctedState.playerLocations['B2'], 'LEFT');
    });

    it('8. Page refresh and Socket.IO reconnect preserve the correct court state', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Alpha' },
        teamB: { id: 'teamB', name: 'Beta' },
        lineup: { teamA: ['A1', 'A2'], teamB: ['B1', 'B2'] },
        scores: { teamA: 7, teamB: 8 }
      };

      // When a user refreshes or reconnects, state is derived from authoritative scores
      const reconnectedState = getInitialCourtState(config);
      assert.strictEqual(reconnectedState.scoreA, 7);
      assert.strictEqual(reconnectedState.scoreB, 8);
      // Score 7 (odd): A1 in LEFT, A2 in RIGHT
      assert.strictEqual(reconnectedState.playerLocations['A1'], 'LEFT');
      assert.strictEqual(reconnectedState.playerLocations['A2'], 'RIGHT');
      // Score 8 (even): B1 in RIGHT, B2 in LEFT
      assert.strictEqual(reconnectedState.playerLocations['B1'], 'RIGHT');
      assert.strictEqual(reconnectedState.playerLocations['B2'], 'LEFT');
    });

    it('9. Duplicate events do not cause repeated or incorrect swaps', () => {
      // Deterministic pure function guarantees idempotency
      const original = { p1: 'RIGHT', p2: 'LEFT' };
      const pos1 = calculatePickleballDoublesPositions(3, original);
      const pos2 = calculatePickleballDoublesPositions(3, original);
      assert.deepStrictEqual(pos1, pos2);
      assert.strictEqual(pos1.p1, 'LEFT');
      assert.strictEqual(pos1.p2, 'RIGHT');
    });

    it('10. Same authoritative state produces identical positions across Web, Mobile, and TV', () => {
      const teamScore = 11;
      const original = [{ id: 'A1', startCourt: 'RIGHT' }, { id: 'A2', startCourt: 'LEFT' }];
      const pos = calculatePickleballDoublesPositions(teamScore, original);

      // Score 11 is odd -> A1 must be on LEFT, A2 on RIGHT
      assert.strictEqual(pos.A1, 'LEFT');
      assert.strictEqual(pos.A2, 'RIGHT');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 9. THE SCORER SCREENSHOT CASE (A1 = 3, A4 = 2)
  // Badge, ball, highlighted service boxes, markers, and call text MUST ALL AGREE!
  // ───────────────────────────────────────────────────────────────────────────
  describe('The Scorer Screenshot Case (A1 = 3, A4 = 2)', () => {
    const screenshotConfig = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      teamA: { id: 'team-a1', name: 'A1' },
      teamB: { id: 'team-a4', name: 'A4' },
      lineup: {
        teamA: [
          { name: 'A1 Player 6', startCourt: 'RIGHT' },
          { name: 'A1 Player 12', startCourt: 'LEFT' }
        ],
        teamB: [
          { name: 'A4 Player 7', startCourt: 'RIGHT' },
          { name: 'A4 Player 1', startCourt: 'LEFT' }
        ]
      },
      scores: { teamA: 3, teamB: 2 },
      startingServingTeam: 'teamB'
    };

    it('Derives unified authoritative state where badges, ball, highlights, and players all agree', () => {
      const state = getInitialCourtState(screenshotConfig);

      assert.strictEqual(state.scoreA, 3);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamB');

      // Team B score is 2 (even) -> Service court is RIGHT
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      // Diagonal cross-court receiver court is also RIGHT
      assert.strictEqual(state.receiverCourt, 'RIGHT');

      // Court Geometry:
      // Team B on right side: RIGHT court is top-right!
      assert.strictEqual(state.servingBoxName, 'top-right', 'Server box must be top-right');
      // Team A on left side: Receiver in RIGHT court is bottom-left!
      assert.strictEqual(state.targetBoxName, 'bottom-left', 'Receiver box must be bottom-left');

      // Ball & Box coords: inside top-right box (the server's box)
      assert.strictEqual(state.serverCoords.x, 630);
      assert.strictEqual(state.serverCoords.y, 115);
      assert.strictEqual(state.ballCoords.y, 115);

      // Player Locations:
      // Team B score 2 (even) -> A4 Player 7 in RIGHT (top-right), A4 Player 1 in LEFT (bottom-right)
      assert.strictEqual(state.playerLocations['A4 Player 7'], 'RIGHT');
      assert.strictEqual(state.playerLocations['A4 Player 1'], 'LEFT');

      // Team A score 3 (odd) -> A1 Player 6 (started right) in LEFT (top-left), A1 Player 12 in RIGHT (bottom-left)
      assert.strictEqual(state.playerLocations['A1 Player 6'], 'LEFT');
      assert.strictEqual(state.playerLocations['A1 Player 12'], 'RIGHT');

      // Server & Receiver Identity:
      const pA4_7 = state.players.find(p => p.name === 'A4 Player 7');
      const pA4_1 = state.players.find(p => p.name === 'A4 Player 1');
      const pA1_6 = state.players.find(p => p.name === 'A1 Player 6');
      const pA1_12 = state.players.find(p => p.name === 'A1 Player 12');

      // 1. A4 Player 7 has SERVE badge in top-right box
      assert.strictEqual(pA4_7.boxName, 'top-right');
      assert.strictEqual(pA4_7.isServer, true, 'SERVE badge must be on A4 Player 7');
      assert.strictEqual(pA4_7.isReceiver, false);

      // 2. A4 Player 1 is non-serving partner in bottom-right box
      assert.strictEqual(pA4_1.boxName, 'bottom-right');
      assert.strictEqual(pA4_1.isServer, false);
      assert.strictEqual(pA4_1.isReceiver, false);

      // 3. A1 Player 12 has RECEIVE badge in diagonal bottom-left box
      assert.strictEqual(pA1_12.boxName, 'bottom-left');
      assert.strictEqual(pA1_12.isReceiver, true, 'RECEIVE badge must be on A1 Player 12');
      assert.strictEqual(pA1_12.isServer, false);

      // 4. A1 Player 6 is in top-left box
      assert.strictEqual(pA1_6.boxName, 'top-left');
      assert.strictEqual(pA1_6.isReceiver, false);
      assert.strictEqual(pA1_6.isServer, false);

      // All 5 components (servingBox, targetBox, ball, badges, markers) agree 100%!
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 10. FIRST-SERVE SELECTION & LINEUP PERMUTATIONS
  // ───────────────────────────────────────────────────────────────────────────
  describe('First-Serve Selection & Lineup Permutations', () => {
    it('Choose left-side team (Team A) -> its right-court player (bottom-left) serves first', () => {
      const state = getInitialCourtState({
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Left A' },
        teamB: { id: 'teamB', name: 'Right B' },
        lineup: {
          teamA: [{ name: 'Player A1' }, { name: 'Player A2' }],
          teamB: [{ name: 'Player B1' }, { name: 'Player B2' }]
        },
        startingServingTeam: 'teamA'
      });

      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      assert.strictEqual(state.targetBoxName, 'top-right');
      const server = state.players.find(p => p.isServer);
      assert.strictEqual(server.name, 'Player A1');
      assert.strictEqual(server.boxName, 'bottom-left');
    });

    it('Choose right-side team (Team B) -> its right-court player (top-right) serves first', () => {
      const state = getInitialCourtState({
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Left A' },
        teamB: { id: 'teamB', name: 'Right B' },
        lineup: {
          teamA: [{ name: 'Player A1' }, { name: 'Player A2' }],
          teamB: [{ name: 'Player B1' }, { name: 'Player B2' }]
        },
        startingServingTeam: 'teamB'
      });

      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.servingBoxName, 'top-right');
      assert.strictEqual(state.targetBoxName, 'bottom-left');
      const server = state.players.find(p => p.isServer);
      assert.strictEqual(server.name, 'Player B1');
      assert.strictEqual(server.boxName, 'top-right');
    });

    it('Switched lineup order: player who starts in right court is the first server', () => {
      const state = getInitialCourtState({
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Left A' },
        teamB: { id: 'teamB', name: 'Right B' },
        lineup: {
          teamA: [{ name: 'Player A2', startCourt: 'RIGHT' }, { name: 'Player A1', startCourt: 'LEFT' }],
          teamB: [{ name: 'Player B2', startCourt: 'RIGHT' }, { name: 'Player B1', startCourt: 'LEFT' }]
        },
        startingServingTeam: 'teamA'
      });

      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      const server = state.players.find(p => p.isServer);
      assert.strictEqual(server.name, 'Player A2', 'Player A2 started in Right court so A2 serves first');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 11. MULTIPLE UNDOS AND COMPLETE HISTORY REVERSIBILITY
  // ───────────────────────────────────────────────────────────────────────────
  describe('Multiple Undos, Reconnect & Idempotence', () => {
    it('Several sequential undos restore positions and scores exactly step by step', () => {
      const config = {
        sport: 'pickleball',
        format: 'DOUBLES',
        scoringMode: 'SIDE_OUT',
        teamA: { id: 'teamA', name: 'Team A' },
        teamB: { id: 'teamB', name: 'Team B' },
        lineup: {
          teamA: ['Alpha 1', 'Alpha 2'],
          teamB: ['Beta 1', 'Beta 2']
        },
        startingServingTeam: 'teamA'
      };

      const history = [
        { sequence_number: 1, point_to: 'team_a' }, // A 1-0-2 (A partners swap: Alpha 1 in LEFT, Alpha 2 in RIGHT)
        { sequence_number: 2, point_to: 'team_a' }, // A 2-0-2 (A partners swap: Alpha 1 in RIGHT, Alpha 2 in LEFT)
        { sequence_number: 3, point_to: 'team_b' }, // A loses rally: side-out to B (0-2-1)
        { sequence_number: 4, point_to: 'team_b' }, // B 1-2-1 (B partners swap)
        { sequence_number: 5, point_to: 'team_b' }, // B 2-2-1 (B partners swap)
      ];

      // At step 5: B score is 2, A score is 2
      const s5 = computeCourtStateFromHistory(config, history);
      assert.strictEqual(s5.scoreA, 2);
      assert.strictEqual(s5.scoreB, 2);
      assert.strictEqual(s5.servingTeam, 'teamB');

      // Undo 1: back to step 4 (B 1, A 2)
      const s4 = computeCourtStateFromHistory(config, history.slice(0, 4));
      assert.strictEqual(s4.scoreB, 1);
      assert.strictEqual(s4.scoreA, 2);

      // Undo 2: back to step 3 (B 0, A 2, side-out to B)
      const s3 = computeCourtStateFromHistory(config, history.slice(0, 3));
      assert.strictEqual(s3.scoreB, 0);
      assert.strictEqual(s3.scoreA, 2);
      assert.strictEqual(s3.serverNumber, 1);
      assert.strictEqual(s3.servingTeam, 'teamB');

      // Undo 3: back to step 2 (A 2, B 0, A serving)
      const s2 = computeCourtStateFromHistory(config, history.slice(0, 2));
      assert.strictEqual(s2.scoreA, 2);
      assert.strictEqual(s2.scoreB, 0);
      assert.strictEqual(s2.servingTeam, 'teamA');
      assert.strictEqual(s2.playerLocations['Alpha 1'], 'RIGHT');
      assert.strictEqual(s2.playerLocations['Alpha 2'], 'LEFT');

      // Undo 4: back to step 1 (A 1, B 0, A partners swapped)
      const s1 = computeCourtStateFromHistory(config, history.slice(0, 1));
      assert.strictEqual(s1.scoreA, 1);
      assert.strictEqual(s1.scoreB, 0);
      assert.strictEqual(s1.playerLocations['Alpha 1'], 'LEFT');
      assert.strictEqual(s1.playerLocations['Alpha 2'], 'RIGHT');

      // Undo 5: back to step 0 (initial 0-0-2 state)
      const s0 = computeCourtStateFromHistory(config, []);
      assert.strictEqual(s0.scoreA, 0);
      assert.strictEqual(s0.scoreB, 0);
      assert.strictEqual(s0.serverNumber, 2);
      assert.strictEqual(s0.servingTeam, 'teamA');
      assert.strictEqual(s0.playerLocations['Alpha 1'], 'RIGHT');
      assert.strictEqual(s0.playerLocations['Alpha 2'], 'LEFT');
    });

    it('Existing match with no first-serve data defaults safely without throwing', () => {
      const state = getInitialCourtState({
        sport: 'pickleball',
        format: 'DOUBLES',
        teamA: { id: 'teamA', name: 'Team A' },
        teamB: { id: 'teamB', name: 'Team B' }
      });

      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      assert.strictEqual(state.targetBoxName, 'top-right');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 17. PICKLEBALL BADMINTON-STYLE ROTATION (BWF Doubles Rotation Adaptation)
  // ───────────────────────────────────────────────────────────────────────────
  describe('Pickleball with Badminton Style Rotation (BWF Doubles Swaps)', () => {
    const badConfig = {
      sport: 'pickleball',
      format: 'DOUBLES',
      scoringMode: 'RALLY',
      rotationRule: 'BADMINTON',
      teamA: { id: 'teamA', name: 'Alpha' },
      teamB: { id: 'teamB', name: 'Bravo' },
      lineup: {
        teamA: [{ id: 'A1', name: 'Alice' }, { id: 'A2', name: 'Aaron' }],
        teamB: [{ id: 'B1', name: 'Bob' }, { id: 'B2', name: 'Betty' }]
      },
      startingServingTeam: 'teamA'
    };

    it('Step 0: Initial Start at 0-0 with 2-part call and no Server #2 concept', () => {
      const state = getInitialCourtState(badConfig);
      assert.strictEqual(state.scoreA, 0);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serverNumber, 1, 'Badminton rule has no Server 2');
      assert.strictEqual(state.serviceCourt, 'RIGHT', '0 is even -> serve from RIGHT court');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      assert.strictEqual(state.targetBoxName, 'top-right');
      assert.strictEqual(state.callText, '0 - 0', 'Call text should be 2-part in Badminton rule');
      assert.strictEqual(state.servingPlayer?.name, 'Alice');
      assert.strictEqual(state.receivingPlayer?.name, 'Bob');
      assert.strictEqual(state.playerLocations['Alice'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Aaron'], 'LEFT');
      assert.strictEqual(state.playerLocations['Bob'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Betty'], 'LEFT');
    });

    it('Step 1: Serving team A wins rally -> point to A (1-0), A partners swap, serve from LEFT court', () => {
      let state = getInitialCourtState(badConfig);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 });

      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 0);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.serverNumber, 1);
      assert.strictEqual(state.serviceCourt, 'LEFT', 'Score 1 is odd -> serve from LEFT court');
      assert.strictEqual(state.servingBoxName, 'top-left');
      assert.strictEqual(state.targetBoxName, 'bottom-right');
      assert.strictEqual(state.callText, '1 - 0');
      // Alice swapped from RIGHT to LEFT, Aaron from LEFT to RIGHT
      assert.strictEqual(state.playerLocations['Alice'], 'LEFT');
      assert.strictEqual(state.playerLocations['Aaron'], 'RIGHT');
      assert.strictEqual(state.servingPlayer?.name, 'Alice', 'Alice remains the server after winning rally');
      assert.strictEqual(state.receivingPlayer?.name, 'Betty');
      // Receiving team did NOT swap
      assert.strictEqual(state.playerLocations['Bob'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Betty'], 'LEFT');
    });

    it('Step 2: Receiving team B wins rally -> point to B (1-1), turnover with ZERO player swaps, server determined by score parity', () => {
      let state = getInitialCourtState(badConfig);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }); // 1-0 (Alice in LEFT, Aaron in RIGHT)
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // B wins rally -> 1-1

      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 1);
      assert.strictEqual(state.servingTeam, 'teamB', 'Serve transfers to Team B');
      assert.strictEqual(state.isSideOut, true, 'Turnover occurs');
      assert.strictEqual(state.callText, '1 - 1');

      // CRITICAL BADMINTON RULE: On turnover, ZERO player swaps occur on either side!
      assert.strictEqual(state.playerLocations['Alice'], 'LEFT');
      assert.strictEqual(state.playerLocations['Aaron'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Bob'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Betty'], 'LEFT');
      assert.deepStrictEqual(state.movingPlayerIds, [], 'Zero players swap on service turnover in Badminton rule');

      // Server selection: Team B score is 1 (odd) -> server must be in LEFT court
      // Betty is in LEFT court -> Betty is the server!
      assert.strictEqual(state.serviceCourt, 'LEFT');
      assert.strictEqual(state.servingBoxName, 'bottom-right', 'Right team facing left: Left court is bottom-right');
      assert.strictEqual(state.servingPlayer?.name, 'Betty', 'Betty is in LEFT court and serves for score 1');
      assert.strictEqual(state.receivingPlayer?.name, 'Alice', 'Alice is in diagonal LEFT (top-left) receiver box');
    });

    it('Step 3: Serving team B wins rally -> point to B (2-1), B partners swap, Betty serves from RIGHT (2 is even)', () => {
      let state = getInitialCourtState(badConfig);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }); // 1-0
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // 1-1 (Betty serves from LEFT)
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 3 }); // 1-2 (B wins point on serve)

      assert.strictEqual(state.scoreA, 1);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamB');
      assert.strictEqual(state.callText, '2 - 1', 'Serving team score (2) called first');

      // B partners swapped because they scored on own serve!
      assert.strictEqual(state.playerLocations['Betty'], 'RIGHT', 'Betty moves to RIGHT court');
      assert.strictEqual(state.playerLocations['Bob'], 'LEFT', 'Bob moves to LEFT court');
      // Team A partners did NOT swap
      assert.strictEqual(state.playerLocations['Alice'], 'LEFT');
      assert.strictEqual(state.playerLocations['Aaron'], 'RIGHT');

      // Team B score is 2 (even) -> serve from RIGHT court
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.servingBoxName, 'top-right', 'Right team: Right court is top-right');
      assert.strictEqual(state.servingPlayer?.name, 'Betty', 'Betty is the active server from RIGHT court');
      assert.strictEqual(state.receivingPlayer?.name, 'Aaron', 'Aaron is in bottom-left receiver court');
    });

    it('Step 4: Team A wins next rally -> 2-2, turnover to A with zero swaps, Aaron serves from RIGHT (2 is even)', () => {
      let state = getInitialCourtState(badConfig);
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 1 }); // 1-0
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 2 }); // 1-1
      state = applyPointToCourtState(state, { pointTo: 'teamB', seq: 3 }); // 1-2
      state = applyPointToCourtState(state, { pointTo: 'teamA', seq: 4 }); // 2-2 (A wins rally on turnover)

      assert.strictEqual(state.scoreA, 2);
      assert.strictEqual(state.scoreB, 2);
      assert.strictEqual(state.servingTeam, 'teamA');
      assert.strictEqual(state.callText, '2 - 2');

      // Zero swaps on turnover!
      assert.strictEqual(state.playerLocations['Alice'], 'LEFT');
      assert.strictEqual(state.playerLocations['Aaron'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Betty'], 'RIGHT');
      assert.strictEqual(state.playerLocations['Bob'], 'LEFT');

      // Team A score is 2 (even) -> server must be in RIGHT court
      // Aaron is in RIGHT court -> Aaron serves!
      assert.strictEqual(state.serviceCourt, 'RIGHT');
      assert.strictEqual(state.servingBoxName, 'bottom-left');
      assert.strictEqual(state.servingPlayer?.name, 'Aaron', 'Aaron serves for Team A because he is in RIGHT court for even score 2');
    });
  });

});


