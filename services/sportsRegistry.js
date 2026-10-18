/**
 * Sports Registry & Multi-Sport Rules Engine
 * Configures rules, match formats, standings formulas, and award algorithms
 * for all supported sports (Cricket, Football, Badminton, Pickleball, Tennis,
 * Table Tennis, Volleyball, Basketball, and extensible custom sports).
 */

const SPORTS_REGISTRY = {
  cricket: {
    slug: 'cricket',
    name: 'Cricket',
    icon: 'trophy',
    category: 'TEAM',
    scoringUnit: 'RUNS',
    hasOvers: true,
    hasInnings: true,
    defaultFormats: ['T10', 'T20', 'ONE_DAY', 'BOX_CRICKET', 'CUSTOM'],
    standingsFormula: {
      winPoints: 2,
      tiePoints: 1,
      noResultPoints: 1,
      lossPoints: 0,
      tieBreakers: ['POINTS', 'WINS', 'NET_RUN_RATE', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'ORANGE_CAP', name: 'Most Runs (Orange Cap)', type: 'PLAYER', stat: 'runs' },
      { key: 'PURPLE_CAP', name: 'Most Wickets (Purple Cap)', type: 'PLAYER', stat: 'wickets' },
      { key: 'MOST_SIXES', name: 'Maximum Sixes Award', type: 'PLAYER', stat: 'sixes' },
      { key: 'BEST_ECONOMY', name: 'Best Bowling Economy', type: 'PLAYER', stat: 'economy' },
      { key: 'CRICKET_MVP', name: 'Most Valuable Player (MVP)', type: 'PLAYER', stat: 'mvpScore' },
      { key: 'FAIR_PLAY', name: 'Fair Play Trophy', type: 'TEAM', stat: 'fairPlayPoints' }
    ]
  },

  football: {
    slug: 'football',
    name: 'Football',
    icon: 'activity',
    category: 'TEAM',
    scoringUnit: 'GOALS',
    hasPeriods: true,
    defaultPeriods: 2,
    defaultPeriodDurationMinutes: 45,
    extraTimeDurationMinutes: 15,
    allowDraw: true,
    supportsKnockoutShootout: true,
    standingsFormula: {
      winPoints: 3,
      drawPoints: 1,
      lossPoints: 0,
      tieBreakers: ['POINTS', 'GOAL_DIFFERENCE', 'GOALS_FOR', 'HEAD_TO_HEAD', 'WINS']
    },
    awards: [
      { key: 'GOLDEN_BOOT', name: 'Top Scorer (Golden Boot)', type: 'PLAYER', stat: 'goals' },
      { key: 'PLAYMAKER', name: 'Most Assists (Playmaker Award)', type: 'PLAYER', stat: 'assists' },
      { key: 'GOLDEN_GLOVE', name: 'Best Goalkeeper (Golden Glove)', type: 'PLAYER', stat: 'cleanSheets' },
      { key: 'PLAYER_OF_TOURNAMENT', name: 'Player of the Tournament', type: 'PLAYER', stat: 'mvpScore' },
      { key: 'FAIR_PLAY', name: 'Fair Play Trophy', type: 'TEAM', stat: 'fairPlayPoints' }
    ]
  },

  badminton: {
    slug: 'badminton',
    name: 'Badminton',
    icon: 'zap',
    category: 'RACKET',
    scoringUnit: 'POINTS',
    hasGames: true,
    defaultGamesToWin: 2, // Best of 3
    defaultTargetScore: 21,
    winByTwo: true,
    maxScoreCap: 30,
    singlesAndDoubles: true,
    standingsFormula: {
      winPoints: 2,
      lossPoints: 0,
      tieBreakers: ['MATCH_WINS', 'GAME_DIFFERENCE', 'POINT_DIFFERENCE', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'MOST_MATCH_WINS', name: 'Most Match Wins', type: 'PLAYER', stat: 'wins' },
      { key: 'TOURNAMENT_MVP', name: 'Tournament MVP', type: 'PLAYER', stat: 'mvpScore' },
      { key: 'BEST_PAIR', name: 'Best Doubles Pair', type: 'TEAM', stat: 'wins' }
    ]
  },

  pickleball: {
    slug: 'pickleball',
    name: 'Pickleball',
    icon: 'zap',
    category: 'RACKET',
    scoringUnit: 'POINTS',
    hasGames: true,
    defaultGamesToWin: 1,
    defaultTargetScore: 15,
    winByTwo: true,
    maxScoreCap: 21,
    singlesAndDoubles: true,
    standingsFormula: {
      winPoints: 2,
      lossPoints: 0,
      tieBreakers: ['MATCH_WINS', 'POINT_DIFFERENCE', 'POINTS_FOR', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'MOST_MATCH_WINS', name: 'Most Match Wins', type: 'PLAYER', stat: 'wins' },
      { key: 'TOURNAMENT_MVP', name: 'Pickleball Master MVP', type: 'PLAYER', stat: 'mvpScore' }
    ]
  },

  tennis: {
    slug: 'tennis',
    name: 'Tennis',
    icon: 'circle',
    category: 'RACKET',
    scoringUnit: 'GAMES_SETS',
    hasSets: true,
    defaultSetsToWin: 2, // Best of 3 sets
    gamesPerSet: 6,
    tiebreakPoints: 7,
    superTiebreakPoints: 10,
    singlesAndDoubles: true,
    standingsFormula: {
      winPoints: 2,
      lossPoints: 0,
      tieBreakers: ['MATCH_WINS', 'SET_DIFFERENCE', 'GAME_DIFFERENCE', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'TOURNAMENT_CHAMPION', name: 'Tennis Champion', type: 'PLAYER', stat: 'wins' },
      { key: 'MOST_ACES', name: 'Aces Leader', type: 'PLAYER', stat: 'aces' }
    ]
  },

  'table-tennis': {
    slug: 'table-tennis',
    name: 'Table Tennis',
    icon: 'disc',
    category: 'RACKET',
    scoringUnit: 'POINTS',
    hasGames: true,
    defaultGamesToWin: 3, // Best of 5
    defaultTargetScore: 11,
    serviceChangeEvery: 2,
    winByTwo: true,
    singlesAndDoubles: true,
    standingsFormula: {
      winPoints: 2,
      lossPoints: 0,
      tieBreakers: ['MATCH_WINS', 'GAME_DIFFERENCE', 'POINT_DIFFERENCE', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'TOURNAMENT_MVP', name: 'Table Tennis Master', type: 'PLAYER', stat: 'wins' }
    ]
  },

  volleyball: {
    slug: 'volleyball',
    name: 'Volleyball',
    icon: 'target',
    category: 'TEAM',
    scoringUnit: 'SETS',
    hasSets: true,
    defaultSetsToWin: 3, // Best of 5
    regularSetPoints: 25,
    decidingSetPoints: 15,
    winByTwo: true,
    standingsFormula: {
      // FIVB 3-point system: 3 pts for 3-0/3-1 win, 2 pts for 3-2 win, 1 pt for 2-3 loss
      winPoints: 3,
      lossPoints: 0,
      tieBreakers: ['POINTS', 'MATCH_WINS', 'SET_RATIO', 'POINT_RATIO', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'BEST_SPIKER', name: 'Best Spiker', type: 'PLAYER', stat: 'spikes' },
      { key: 'BEST_BLOCKER', name: 'Best Blocker', type: 'PLAYER', stat: 'blocks' },
      { key: 'TOURNAMENT_MVP', name: 'Volleyball MVP', type: 'PLAYER', stat: 'mvpScore' }
    ]
  },

  basketball: {
    slug: 'basketball',
    name: 'Basketball',
    icon: 'dribbble',
    category: 'TEAM',
    scoringUnit: 'POINTS',
    hasPeriods: true,
    defaultPeriods: 4, // 4 Quarters
    defaultPeriodDurationMinutes: 10,
    allowDraw: false,
    overtimeDurationMinutes: 5,
    standingsFormula: {
      winPoints: 2,
      lossPoints: 1, // 1 point for played loss in standard basketball leagues
      tieBreakers: ['POINTS', 'POINT_DIFFERENCE', 'POINTS_FOR', 'HEAD_TO_HEAD']
    },
    awards: [
      { key: 'SCORING_CHAMPION', name: 'Scoring Champion', type: 'PLAYER', stat: 'points' },
      { key: 'ASSISTS_LEADER', name: 'Assists Leader', type: 'PLAYER', stat: 'assists' },
      { key: 'REBOUND_KING', name: 'Rebounds Leader', type: 'PLAYER', stat: 'rebounds' },
      { key: 'TOURNAMENT_MVP', name: 'Finals MVP', type: 'PLAYER', stat: 'mvpScore' }
    ]
  }
};

/**
 * Returns sport rules definition.
 */
function getSportConfig(sportSlug) {
  if (!sportSlug) return SPORTS_REGISTRY.cricket;
  const key = String(sportSlug).toLowerCase().trim();
  return SPORTS_REGISTRY[key] || {
    slug: key,
    name: sportSlug.charAt(0).toUpperCase() + sportSlug.slice(1),
    icon: 'activity',
    category: 'GENERAL',
    scoringUnit: 'POINTS',
    standingsFormula: {
      winPoints: 2,
      drawPoints: 1,
      lossPoints: 0,
      tieBreakers: ['POINTS', 'WINS', 'POINT_DIFFERENCE', 'POINTS_FOR']
    },
    awards: [
      { key: 'TOURNAMENT_MVP', name: 'Tournament MVP', type: 'PLAYER', stat: 'mvpScore' },
      { key: 'FAIR_PLAY', name: 'Fair Play Trophy', type: 'TEAM', stat: 'fairPlayPoints' }
    ]
  };
}

/**
 * Returns all configured sports.
 */
function getAllRegisteredSports() {
  return Object.values(SPORTS_REGISTRY);
}

module.exports = {
  SPORTS_REGISTRY,
  getSportConfig,
  getAllRegisteredSports
};
