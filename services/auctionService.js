const db = require('../config/database');
const { randomUUID: uuidv4 } = require('crypto');
const { getIO, broadcastAuctionEvent } = require('./socketService');

/**
 * Helper to resolve tournament internal ID & public UUID
 */
const resolveTournament = async (tournamentIdOrUuid) => {
  const rows = await db.query(
    `SELECT t.id, t.uuid, t.name, t.created_by, t.sport_id, t.has_auction
     FROM tournaments t
     WHERE t.uuid = ? OR t.id = ?`,
    [tournamentIdOrUuid, isNaN(tournamentIdOrUuid) ? -1 : parseInt(tournamentIdOrUuid, 10)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
};

/**
 * Helper to resolve auction record by auction UUID or internal ID
 */
const resolveAuction = async (auctionIdOrUuid) => {
  const rows = await db.query(
    `SELECT ta.*, t.uuid as tournament_uuid, t.name as tournament_name, t.created_by as tournament_creator
     FROM tournament_auctions ta
     JOIN tournaments t ON ta.tournament_id = t.id
     WHERE ta.uuid = ? OR ta.id = ?`,
    [auctionIdOrUuid, isNaN(auctionIdOrUuid) ? -1 : parseInt(auctionIdOrUuid, 10)]
  );
  return rows && rows.length > 0 ? rows[0] : null;
};

/**
 * Helper to check admin/creator authorization for auction operations
 */
const checkAuctionAuthorization = (user, auctionOrTournament) => {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  const creatorId = auctionOrTournament.created_by || auctionOrTournament.tournament_creator;
  return user.id === creatorId;
};

/**
 * Helper to calculate lowest eligible base price for an auction
 */
const getLowestEligibleBasePrice = async (auctionId, conn = db) => {
  // Query lowest base price among categories that currently have AVAILABLE or UNSOLD players
  const rows = await conn.query(
    `SELECT MIN(ap.base_price) as lowest_price
     FROM auction_players ap
     WHERE ap.auction_id = ? AND ap.status IN ('AVAILABLE', 'UNSOLD')`,
    [auctionId]
  );
  const lowest = rows && rows[0]?.lowest_price;
  if (lowest !== null && lowest !== undefined && parseFloat(lowest) > 0) {
    return parseFloat(lowest);
  }

  // Fallback: lowest base price among active categories
  const catRows = await conn.query(
    `SELECT MIN(ac.base_price) as lowest_price
     FROM auction_categories ac
     WHERE ac.auction_id = ? AND ac.is_active = 1`,
    [auctionId]
  );
  const catLowest = catRows && catRows[0]?.lowest_price;
  if (catLowest !== null && catLowest !== undefined && parseFloat(catLowest) > 0) {
    return parseFloat(catLowest);
  }

  return 100000.00; // Default fallback: ₹1 Lakh
};

/**
 * Helper to calculate tiered bid increment based on price range
 */
const calculateBidIncrement = (currentBid, auction, category) => {
  if (auction.bid_increment_type === 'FIXED') {
    return parseFloat(auction.default_bid_increment) || 50000.00;
  }
  if (auction.bid_increment_type === 'CATEGORY' && category?.bid_increment) {
    return parseFloat(category.bid_increment);
  }

  // Tiered IPL/BBL standard increments
  const bid = parseFloat(currentBid) || 0;
  if (bid < 1000000) {
    return 20000.00; // Under ₹10L -> ₹20k
  } else if (bid < 5000000) {
    return 50000.00; // ₹10L - ₹50L -> ₹50k
  } else if (bid < 10000000) {
    return 100000.00; // ₹50L - ₹1Cr -> ₹1 Lakh
  } else {
    return 250000.00; // Above ₹1Cr -> ₹2.5 Lakh
  }
};

/**
 * Helper to recalculate a team's budget reserves dynamically
 */
const recalculateTeamBudgets = (team, lowestBasePrice) => {
  const totalBudget = parseFloat(team.total_budget);
  const amountSpent = parseFloat(team.amount_spent);
  const remainingBalance = Math.max(0, totalBudget - amountSpent);
  const minSquadSize = parseInt(team.min_squad_size, 10) || 11;
  const playersPurchased = parseInt(team.players_purchased, 10) || 0;

  const remainingPlayersRequired = Math.max(0, minSquadSize - playersPurchased);
  const reservedBudget = remainingPlayersRequired * lowestBasePrice;
  const availableBiddingBudget = Math.max(0, remainingBalance - reservedBudget);

  return {
    totalBudget,
    amountSpent,
    remainingBalance,
    minSquadSize,
    playersPurchased,
    remainingPlayersRequired,
    reservedBudget,
    availableBiddingBudget
  };
};

// -----------------------------------------------------------------------------
// CORE AUCTION SERVICE METHODS
// -----------------------------------------------------------------------------

/**
 * 1. Get or check tournament auction details
 */
const getTournamentAuction = async (idOrUuid) => {
  let tournament = await resolveTournament(idOrUuid);
  let auction = null;

  if (!tournament) {
    auction = await resolveAuction(idOrUuid);
    if (auction) {
      const tourRows = await db.query('SELECT * FROM tournaments WHERE id = ?', [auction.tournament_id]);
      tournament = tourRows && tourRows[0] ? tourRows[0] : null;
    }
  }

  if (!tournament && !auction) {
    throw { statusCode: 404, message: 'Tournament or Auction not found.' };
  }

  if (!auction) {
    const auctions = await db.query(
      `SELECT ta.*, u.full_name as creator_name
       FROM tournament_auctions ta
       LEFT JOIN users u ON ta.created_by = u.id
       WHERE ta.tournament_id = ?`,
      [tournament.id]
    );

    if (!auctions || auctions.length === 0) {
      return {
        hasAuction: false,
        tournament: {
          id: tournament.uuid,
          name: tournament.name
        }
      };
    }

    auction = auctions[0];
  }
  const lowestBasePrice = await getLowestEligibleBasePrice(auction.id);

  // Fetch Categories
  const categories = await db.query(
    `SELECT ac.*, 
            (SELECT COUNT(*) FROM auction_players ap WHERE ap.category_id = ac.id) as player_count
     FROM auction_categories ac
     WHERE ac.auction_id = ?
     ORDER BY ac.display_order ASC, ac.base_price DESC`,
    [auction.id]
  );

  // Fetch Teams
  const teams = await db.query(
    `SELECT at.*, t.name as team_name, t.logo_url as team_logo, t.uuid as team_public_id,
            u.full_name as representative_name, u.email as representative_email
     FROM auction_teams at
     JOIN teams t ON at.team_id = t.id
     LEFT JOIN users u ON at.representative_user_id = u.id
     WHERE at.auction_id = ?
     ORDER BY at.players_purchased DESC, t.name ASC`,
    [auction.id]
  );

  // Recalculate reserves for all teams
  const enrichedTeams = teams.map((team) => {
    const calc = recalculateTeamBudgets(team, lowestBasePrice);
    return {
      id: team.id,
      teamId: team.team_id,
      teamPublicId: team.team_public_id,
      teamName: team.team_name,
      teamLogo: team.team_logo,
      representativeUserId: team.representative_user_id,
      representativeName: team.representative_name,
      representativeEmail: team.representative_email,
      totalBudget: calc.totalBudget,
      amountSpent: calc.amountSpent,
      remainingBalance: calc.remainingBalance,
      reservedBudget: calc.reservedBudget,
      availableBiddingBudget: calc.availableBiddingBudget,
      minSquadSize: calc.minSquadSize,
      maxSquadSize: team.max_squad_size,
      playersPurchased: calc.playersPurchased,
      remainingPlayersRequired: calc.remainingPlayersRequired,
      status: team.status
    };
  });

  // Fetch Counts
  const counts = await db.query(
    `SELECT 
      COUNT(*) as total_players,
      SUM(CASE WHEN status = 'SOLD' THEN 1 ELSE 0 END) as sold_players,
      SUM(CASE WHEN status = 'UNSOLD' THEN 1 ELSE 0 END) as unsold_players,
      SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) as available_players,
      SUM(CASE WHEN status = 'IN_AUCTION' THEN 1 ELSE 0 END) as in_auction_players
     FROM auction_players
     WHERE auction_id = ?`,
    [auction.id]
  );
  const countRow = counts && counts[0] ? counts[0] : {};

  // Current Player on Block (if any)
  let currentPlayer = null;
  if (auction.current_player_id) {
    const currentRows = await db.query(
      `SELECT ap.*, ac.name as category_name, ac.bid_increment as category_increment,
              at.id as highest_bidder_auction_team_id, t.name as highest_bidder_team_name, t.logo_url as highest_bidder_team_logo
       FROM auction_players ap
       LEFT JOIN auction_categories ac ON ap.category_id = ac.id
       LEFT JOIN auction_teams at ON at.id = ?
       LEFT JOIN teams t ON at.team_id = t.id
       WHERE ap.id = ?`,
      [auction.current_bidder_team_id, auction.current_player_id]
    );
    if (currentRows && currentRows.length > 0) {
      const cp = currentRows[0];
      const nextIncrement = calculateBidIncrement(auction.current_bid, auction, cp);
      currentPlayer = {
        id: cp.id,
        playerName: cp.player_name,
        profilePhoto: cp.profile_photo,
        registrationId: cp.player_registration_id,
        role: cp.role,
        battingStyle: cp.batting_style,
        bowlingStyle: cp.bowling_style,
        previousTeam: cp.previous_team,
        categoryId: cp.category_id,
        categoryName: cp.category_name,
        basePrice: parseFloat(cp.base_price),
        currentBid: parseFloat(auction.current_bid),
        nextMinimumBid: parseFloat(auction.current_bid) + (auction.current_bidder_team_id ? nextIncrement : 0),
        nextIncrement,
        highestBidder: auction.current_bidder_team_id ? {
          auctionTeamId: cp.highest_bidder_auction_team_id,
          teamName: cp.highest_bidder_team_name,
          teamLogo: cp.highest_bidder_team_logo
        } : null,
        timerEndAt: auction.timer_end_at,
        lotNumber: cp.lot_number
      };
    }
  }

  return {
    hasAuction: true,
    auction: {
      id: auction.uuid,
      internalId: auction.id,
      tournamentId: tournament.uuid,
      tournamentName: tournament.name,
      name: auction.name,
      status: auction.status,
      currency: auction.currency,
      currencySymbol: auction.currency_symbol,
      defaultWalletAmount: parseFloat(auction.default_wallet_amount),
      minSquadSize: auction.min_squad_size,
      maxSquadSize: auction.max_squad_size,
      bidIncrementType: auction.bid_increment_type,
      defaultBidIncrement: parseFloat(auction.default_bid_increment),
      bidTimerSeconds: auction.bid_timer_seconds,
      timerExtensionSeconds: auction.timer_extension_seconds,
      biddingMode: auction.bidding_mode,
      startDateTime: auction.start_date_time,
      rules: auction.rules,
      creatorName: auction.creator_name,
      lowestEligibleBasePrice: lowestBasePrice,
      stats: {
        totalPlayers: parseInt(countRow.total_players || 0, 10),
        soldPlayers: parseInt(countRow.sold_players || 0, 10),
        unsoldPlayers: parseInt(countRow.unsold_players || 0, 10),
        availablePlayers: parseInt(countRow.available_players || 0, 10),
        inAuctionPlayers: parseInt(countRow.in_auction_players || 0, 10)
      },
      categories,
      teams: enrichedTeams,
      currentPlayer
    }
  };
};

/**
 * 2. Create or Update Auction Configuration
 */
const configureAuction = async ({ tournamentIdOrUuid, config, userId, userRole }) => {
  const tournament = await resolveTournament(tournamentIdOrUuid);
  if (!tournament) {
    throw { statusCode: 404, message: 'Tournament not found.' };
  }

  if (userRole !== 'ADMIN' && tournament.created_by !== userId) {
    throw { statusCode: 403, message: 'Unauthorized: Only tournament creator or admin can configure auction.' };
  }

  const {
    name = `${tournament.name} Auction 2026`,
    currency = 'INR',
    currencySymbol = '₹',
    defaultWalletAmount = 10000000.00,
    minSquadSize = 11,
    maxSquadSize = 15,
    bidIncrementType = 'TIERED',
    defaultBidIncrement = 50000.00,
    bidTimerSeconds = 30,
    timerExtensionSeconds = 15,
    biddingMode = 'TEAM_REP_AND_OPERATOR',
    startDateTime = null,
    rules = null,
    categories = []
  } = config;

  return await db.transaction(async (conn) => {
    // Check if auction already exists
    const [existing] = await conn.query(
      `SELECT id, uuid, status FROM tournament_auctions WHERE tournament_id = ? FOR UPDATE`,
      [tournament.id]
    );

    let auctionId = null;
    let auctionUuid = null;

    if (existing && existing.length > 0) {
      auctionId = existing[0].id;
      auctionUuid = existing[0].uuid;

      // Update configuration
      await conn.query(
        `UPDATE tournament_auctions
         SET name = ?, currency = ?, currency_symbol = ?, default_wallet_amount = ?,
             min_squad_size = ?, max_squad_size = ?, bid_increment_type = ?,
             default_bid_increment = ?, bid_timer_seconds = ?, timer_extension_seconds = ?,
             bidding_mode = ?, start_date_time = ?, rules = ?
         WHERE id = ?`,
        [
          name, currency, currencySymbol, defaultWalletAmount,
          minSquadSize, maxSquadSize, bidIncrementType,
          defaultBidIncrement, bidTimerSeconds, timerExtensionSeconds,
          biddingMode, startDateTime, rules,
          auctionId
        ]
      );
    } else {
      auctionUuid = uuidv4();
      const [ins] = await conn.query(
        `INSERT INTO tournament_auctions
          (uuid, tournament_id, name, status, currency, currency_symbol, default_wallet_amount,
           min_squad_size, max_squad_size, bid_increment_type, default_bid_increment,
           bid_timer_seconds, timer_extension_seconds, bidding_mode, start_date_time, rules, created_by)
         VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          auctionUuid, tournament.id, name, currency, currencySymbol, defaultWalletAmount,
          minSquadSize, maxSquadSize, bidIncrementType, defaultBidIncrement,
          bidTimerSeconds, timerExtensionSeconds, biddingMode, startDateTime, rules, userId
        ]
      );
      auctionId = ins.insertId;

      // Update tournament flag
      await conn.query(`UPDATE tournaments SET has_auction = 1 WHERE id = ?`, [tournament.id]);

      // Seed default player categories if none provided
      const defaultCategories = categories.length > 0 ? categories : [
        { name: 'A+', description: 'Elite Marquee International Players', basePrice: 1000000.00, bidIncrement: 100000.00, displayOrder: 1 },
        { name: 'A', description: 'Premier State/First-Class Players', basePrice: 500000.00, bidIncrement: 50000.00, displayOrder: 2 },
        { name: 'B', description: 'Experienced Senior Club Players', basePrice: 200000.00, bidIncrement: 25000.00, displayOrder: 3 },
        { name: 'C', description: 'Emerging & Development Players', basePrice: 100000.00, bidIncrement: 20000.00, displayOrder: 4 }
      ];

      for (const cat of defaultCategories) {
        await conn.query(
          `INSERT INTO auction_categories (auction_id, name, description, base_price, bid_increment, display_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [auctionId, cat.name, cat.description || null, cat.basePrice || 100000.00, cat.bidIncrement || 50000.00, cat.displayOrder || 0]
        );
      }
    }

    // Record audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id, details)
       VALUES (?, 'AUCTION_CONFIGURED', ?, ?)`,
      [auctionId, userId, JSON.stringify({ name, defaultWalletAmount, minSquadSize, bidIncrementType })]
    );

    return {
      success: true,
      message: 'Auction configuration saved successfully.',
      auctionId: auctionUuid
    };
  });
};

/**
 * 3. Add or register teams into auction with custom wallet budgets
 */
const registerTeamsForAuction = async ({ auctionIdOrUuid, teamsData, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized to manage auction teams.' };
  }

  if (auction.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Cannot add teams to a completed auction.' };
  }

  const lowestBasePrice = await getLowestEligibleBasePrice(auction.id);

  return await db.transaction(async (conn) => {
    let addedCount = 0;
    for (const t of teamsData) {
      const teamId = t.teamId;
      const budget = parseFloat(t.totalBudget || t.budget || auction.default_wallet_amount);
      const repUserId = t.representativeUserId || null;
      const minSquad = parseInt(t.minSquadSize || auction.min_squad_size, 10) || 11;
      const maxSquad = parseInt(t.maxSquadSize || auction.max_squad_size, 10) || 15;

      const [existing] = await conn.query(
        `SELECT id FROM auction_teams WHERE auction_id = ? AND team_id = ?`,
        [auction.id, teamId]
      );

      if (existing && existing.length > 0) {
        // Update budget and settings
        await conn.query(
          `UPDATE auction_teams
           SET total_budget = ?, remaining_balance = total_budget - amount_spent,
               representative_user_id = COALESCE(?, representative_user_id),
               min_squad_size = ?, max_squad_size = ?
           WHERE id = ?`,
          [budget, repUserId, minSquad, maxSquad, existing[0].id]
        );
      } else {
        const initialReserve = minSquad * lowestBasePrice;
        const initialAvailable = Math.max(0, budget - initialReserve);

        await conn.query(
          `INSERT INTO auction_teams 
            (auction_id, team_id, representative_user_id, total_budget, amount_spent,
             remaining_balance, reserved_budget, available_bidding_budget, min_squad_size, max_squad_size)
           VALUES (?, ?, ?, ?, 0.00, ?, ?, ?, ?, ?)`,
          [
            auction.id, teamId, repUserId, budget,
            budget, initialReserve, initialAvailable, minSquad, maxSquad
          ]
        );
        addedCount++;
      }
    }

    // Record audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id, details)
       VALUES (?, 'TEAMS_REGISTERED', ?, ?)`,
      [auction.id, userId, JSON.stringify({ count: teamsData.length })]
    );

    return {
      success: true,
      message: `Successfully configured ${teamsData.length} team(s) for the auction.`,
      addedCount
    };
  });
};

/**
 * 4. Register players into auction pool
 */
const registerPlayersForAuction = async ({ auctionIdOrUuid, playersData, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized to manage auction players.' };
  }

  if (auction.status === 'COMPLETED') {
    throw { statusCode: 400, message: 'Cannot add players to a completed auction.' };
  }

  return await db.transaction(async (conn) => {
    // Get highest current lot number
    const [lotRows] = await conn.query(
      `SELECT COALESCE(MAX(lot_number), 0) as max_lot FROM auction_players WHERE auction_id = ?`,
      [auction.id]
    );
    let nextLot = (lotRows && lotRows[0]?.max_lot ? parseInt(lotRows[0].max_lot, 10) : 0) + 1;

    let added = 0;
    for (const p of playersData) {
      const name = p.name || p.playerName;
      if (!name) continue;

      let categoryId = p.categoryId || null;
      let basePrice = parseFloat(p.basePrice) || 0;

      // If categoryId provided but basePrice is 0, fetch category default base price
      if (categoryId && basePrice <= 0) {
        const [cat] = await conn.query('SELECT base_price FROM auction_categories WHERE id = ?', [categoryId]);
        if (cat && cat[0]) basePrice = parseFloat(cat[0].base_price);
      }

      if (basePrice <= 0) {
        basePrice = 100000.00; // Default base price ₹1 Lakh
      }

      await conn.query(
        `INSERT INTO auction_players
          (auction_id, user_id, player_name, profile_photo, player_registration_id,
           role, batting_style, bowling_style, previous_team, category_id, base_price, lot_number, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE')`,
        [
          auction.id,
          p.userId || null,
          name,
          p.profilePhoto || null,
          p.registrationId || null,
          p.role || 'ALL_ROUNDER',
          p.battingStyle || 'Right-hand bat',
          p.bowlingStyle || 'Right-arm medium',
          p.previousTeam || null,
          categoryId,
          basePrice,
          p.lotNumber || nextLot++,
        ]
      );
      added++;
    }

    // Record audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id, details)
       VALUES (?, 'PLAYERS_REGISTERED', ?, ?)`,
      [auction.id, userId, JSON.stringify({ count: added })]
    );

    return {
      success: true,
      message: `Successfully registered ${added} player(s) into the auction pool.`,
      added
    };
  });
};

/**
 * 5. Update Player details / Category / Base Price
 */
const updateAuctionPlayer = async ({ auctionIdOrUuid, playerId, playerData, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  const playerRows = await db.query(
    `SELECT * FROM auction_players WHERE id = ? AND auction_id = ?`,
    [playerId, auction.id]
  );
  if (!playerRows || playerRows.length === 0) {
    throw { statusCode: 404, message: 'Player not found in this auction.' };
  }

  const p = playerRows[0];
  if (p.status === 'SOLD') {
    throw { statusCode: 400, message: 'Cannot edit a player who has already been sold.' };
  }

  const name = playerData.playerName || p.player_name;
  const role = playerData.role || p.role;
  const battingStyle = playerData.battingStyle || p.batting_style;
  const bowlingStyle = playerData.bowlingStyle || p.bowling_style;
  const categoryId = playerData.categoryId !== undefined ? playerData.categoryId : p.category_id;
  const basePrice = parseFloat(playerData.basePrice || p.base_price);
  const status = playerData.status || p.status;
  const lotNumber = playerData.lotNumber !== undefined ? playerData.lotNumber : p.lot_number;

  await db.query(
    `UPDATE auction_players
     SET player_name = ?, role = ?, batting_style = ?, bowling_style = ?,
         category_id = ?, base_price = ?, status = ?, lot_number = ?
     WHERE id = ?`,
    [name, role, battingStyle, bowlingStyle, categoryId, basePrice, status, lotNumber, playerId]
  );

  return { success: true, message: 'Player updated successfully.' };
};

/**
 * 5b. Get Auction Players (filterable by status)
 */
const getAuctionPlayers = async ({ auctionIdOrUuid, status, categoryId }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  let sql = `
    SELECT ap.*, ac.name as category_name, ac.base_price as category_base_price,
           t.name as winning_team_name, t.logo_url as winning_team_logo
    FROM auction_players ap
    LEFT JOIN auction_categories ac ON ap.category_id = ac.id
    LEFT JOIN auction_teams at ON ap.winning_auction_team_id = at.id
    LEFT JOIN teams t ON at.team_id = t.id
    WHERE ap.auction_id = ?
  `;
  const params = [auction.id];

  if (status && status !== 'ALL') {
    sql += ` AND ap.status = ?`;
    params.push(status);
  }
  if (categoryId) {
    sql += ` AND ap.category_id = ?`;
    params.push(categoryId);
  }

  sql += ` ORDER BY ap.lot_number ASC, ap.id ASC`;

  const rows = await db.query(sql, params);
  return rows.map((p) => ({
    id: p.id,
    playerName: p.player_name,
    profilePhoto: p.profile_photo,
    registrationId: p.player_registration_id,
    role: p.role,
    battingStyle: p.batting_style,
    bowlingStyle: p.bowling_style,
    previousTeam: p.previous_team,
    categoryId: p.category_id,
    categoryName: p.category_name,
    basePrice: parseFloat(p.base_price),
    status: p.status,
    lotNumber: p.lot_number,
    soldPrice: p.sold_price ? parseFloat(p.sold_price) : null,
    winningTeam: p.winning_team_name ? {
      name: p.winning_team_name,
      logo: p.winning_team_logo
    } : null
  }));
};

/**
 * 5c. Delete Auction Player (only if not sold)
 */
const deleteAuctionPlayer = async ({ auctionIdOrUuid, playerId, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  const rows = await db.query(
    `SELECT * FROM auction_players WHERE id = ? AND auction_id = ?`,
    [playerId, auction.id]
  );
  if (!rows || rows.length === 0) {
    throw { statusCode: 404, message: 'Player not found.' };
  }

  if (rows[0].status === 'SOLD') {
    throw { statusCode: 400, message: 'Cannot delete a sold player.' };
  }

  await db.query(`DELETE FROM auction_players WHERE id = ?`, [playerId]);
  return { success: true, message: 'Player removed from auction pool.' };
};

/**
 * 6. Start Live Auction
 */
const startAuction = async ({ auctionIdOrUuid, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized to start auction.' };
  }

  // Validate teams count
  const teamCountRows = await db.query(
    `SELECT COUNT(*) as c FROM auction_teams WHERE auction_id = ?`,
    [auction.id]
  );
  if ((teamCountRows[0]?.c || 0) < 2) {
    throw { statusCode: 400, message: 'At least 2 participating teams are required to start an auction.' };
  }

  // Validate players count
  const playerCountRows = await db.query(
    `SELECT COUNT(*) as c FROM auction_players WHERE auction_id = ? AND status IN ('AVAILABLE', 'UNSOLD')`,
    [auction.id]
  );
  if ((playerCountRows[0]?.c || 0) === 0) {
    throw { statusCode: 400, message: 'No available players found in the auction pool.' };
  }

  await db.query(`UPDATE tournament_auctions SET status = 'LIVE' WHERE id = ?`, [auction.id]);

  await db.query(
    `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id)
     VALUES (?, 'AUCTION_STARTED', ?)`,
    [auction.id, userId]
  );

  const io = getIO();
  if (io) {
    io.to(`auction:${auction.uuid}`).emit('auction:statusChanged', { status: 'LIVE' });
  }

  return { success: true, message: 'Auction is now LIVE!' };
};

/**
 * 7. Pause or Resume Live Auction
 */
const setAuctionStatus = async ({ auctionIdOrUuid, status, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  if (!['LIVE', 'PAUSED'].includes(status)) {
    throw { statusCode: 400, message: 'Invalid status transition.' };
  }

  await db.query(`UPDATE tournament_auctions SET status = ? WHERE id = ?`, [status, auction.id]);

  await db.query(
    `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id)
     VALUES (?, ?, ?)`,
    [auction.id, status === 'PAUSED' ? 'AUCTION_PAUSED' : 'AUCTION_RESUMED', userId]
  );

  const io = getIO();
  if (io) {
    io.to(`auction:${auction.uuid}`).emit('auction:statusChanged', { status });
  }

  return { success: true, message: `Auction status set to ${status}.` };
};

/**
 * 8. Bring Player onto the Auction Block
 */
const selectPlayerForBidding = async ({ auctionIdOrUuid, playerId, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  if (auction.status !== 'LIVE' && auction.status !== 'PAUSED') {
    throw { statusCode: 400, message: 'Auction must be LIVE to select a player.' };
  }

  return await db.transaction(async (conn) => {
    // If another player was IN_AUCTION without bids, reset to AVAILABLE
    if (auction.current_player_id && auction.current_player_id !== playerId) {
      await conn.query(
        `UPDATE auction_players 
         SET status = 'AVAILABLE' 
         WHERE id = ? AND status = 'IN_AUCTION'`,
        [auction.current_player_id]
      );
    }

    const [playerRows] = await conn.query(
      `SELECT ap.*, ac.name as category_name, ac.bid_increment as category_increment
       FROM auction_players ap
       LEFT JOIN auction_categories ac ON ap.category_id = ac.id
       WHERE ap.id = ? AND ap.auction_id = ? FOR UPDATE`,
      [playerId, auction.id]
    );

    if (!playerRows || playerRows.length === 0) {
      throw { statusCode: 404, message: 'Player not found in auction.' };
    }

    const player = playerRows[0];
    if (player.status === 'SOLD') {
      throw { statusCode: 400, message: 'This player has already been sold and is no longer available.' };
    }

    // Set player to IN_AUCTION
    await conn.query(`UPDATE auction_players SET status = 'IN_AUCTION' WHERE id = ?`, [playerId]);

    // Calculate timer deadline
    const timerSeconds = auction.bid_timer_seconds || 30;
    const timerEndAt = new Date(Date.now() + timerSeconds * 1000);

    const basePrice = parseFloat(player.base_price);
    const nextIncrement = calculateBidIncrement(basePrice, auction, player);

    // Update auction table
    await conn.query(
      `UPDATE tournament_auctions
       SET current_player_id = ?, current_bid = ?, current_bidder_team_id = NULL,
           timer_end_at = ?
       WHERE id = ?`,
      [playerId, basePrice, timerEndAt, auction.id]
    );

    // Audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, player_id, amount, acting_user_id)
       VALUES (?, 'PLAYER_PUT_ON_BLOCK', ?, ?, ?)`,
      [auction.id, playerId, basePrice, userId]
    );

    const payload = {
      player: {
        id: player.id,
        playerName: player.player_name,
        profilePhoto: player.profile_photo,
        registrationId: player.player_registration_id,
        role: player.role,
        battingStyle: player.batting_style,
        bowlingStyle: player.bowling_style,
        previousTeam: player.previous_team,
        categoryId: player.category_id,
        categoryName: player.category_name,
        basePrice,
        lotNumber: player.lot_number
      },
      currentBid: basePrice,
      highestBidder: null,
      nextMinimumBid: basePrice,
      nextIncrement,
      timerEndAt,
      timerSeconds
    };

    const io = getIO();
    if (io) {
      io.to(`auction:${auction.uuid}`).emit('auction:playerOnBlock', payload);
    }

    return { success: true, ...payload };
  });
};

/**
 * 9. Place Bid (Atomic with strict budget & reserve protection!)
 */
const placeBid = async ({ auctionIdOrUuid, auctionTeamId, bidAmount, customIncrement = null, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (auction.status !== 'LIVE') {
    throw { statusCode: 400, message: 'Bidding is currently closed.' };
  }

  if (!auction.current_player_id) {
    throw { statusCode: 400, message: 'No player is currently on the auction block.' };
  }

  return await db.transaction(async (conn) => {
    // 1. Lock auction record
    const [auctions] = await conn.query(
      `SELECT * FROM tournament_auctions WHERE id = ? FOR UPDATE`,
      [auction.id]
    );
    const currAuction = auctions[0];

    // 2. Lock active player record
    const [players] = await conn.query(
      `SELECT ap.*, ac.name as category_name, ac.bid_increment as category_increment
       FROM auction_players ap
       LEFT JOIN auction_categories ac ON ap.category_id = ac.id
       WHERE ap.id = ? FOR UPDATE`,
      [currAuction.current_player_id]
    );
    const player = players[0];

    if (!player || player.status !== 'IN_AUCTION') {
      throw { statusCode: 400, message: 'Current player is not open for bidding.' };
    }

    // 3. Lock bidding team record
    const [teams] = await conn.query(
      `SELECT at.*, t.name as team_name, t.logo_url as team_logo
       FROM auction_teams at
       JOIN teams t ON at.team_id = t.id
       WHERE at.id = ? AND at.auction_id = ? FOR UPDATE`,
      [auctionTeamId, auction.id]
    );

    if (!teams || teams.length === 0) {
      throw { statusCode: 404, message: 'Bidding team not found in this auction.' };
    }
    const team = teams[0];

    if (team.status !== 'ACTIVE') {
      throw { statusCode: 403, message: 'This team is disqualified or inactive.' };
    }

    // 4. Authorization check: Operator or Team Representative
    const isOperator = userRole === 'ADMIN' || auction.tournament_creator === userId;
    const isTeamRep = team.representative_user_id === userId;

    if (!isOperator && !isTeamRep) {
      throw { statusCode: 403, message: 'You are not authorized to bid for this team.' };
    }

    // 5. Prevent bidding against oneself
    if (currAuction.current_bidder_team_id === team.id) {
      throw { statusCode: 400, message: `${team.team_name} already holds the highest bid.` };
    }

    // 6. Check squad limits
    const maxSquad = team.max_squad_size ? parseInt(team.max_squad_size, 10) : 15;
    if (team.players_purchased >= maxSquad) {
      throw { statusCode: 400, message: `Team has reached its maximum squad limit of ${maxSquad} players.` };
    }

    // 7. Calculate and validate bid amount
    const currBid = parseFloat(currAuction.current_bid) || 0;
    const basePrice = parseFloat(player.base_price);
    const calculatedIncrement = calculateBidIncrement(currBid, currAuction, player);
    const increment = customIncrement ? parseFloat(customIncrement) : calculatedIncrement;

    let targetBid = parseFloat(bidAmount);
    if (!targetBid || isNaN(targetBid)) {
      // Automatic next bid calculation
      if (!currAuction.current_bidder_team_id) {
        // First bid starts at base price
        targetBid = basePrice;
      } else {
        targetBid = currBid + increment;
      }
    }

    // Validate that bid is above current bid (or meets base price on first bid)
    if (!currAuction.current_bidder_team_id) {
      if (targetBid < basePrice) {
        throw { statusCode: 400, message: `First bid must be at least the base price of ₹${basePrice.toLocaleString('en-IN')}.` };
      }
    } else {
      if (targetBid <= currBid) {
        throw { statusCode: 400, message: `Bid must be higher than current bid of ₹${currBid.toLocaleString('en-IN')}.` };
      }
    }

    // 8. CRITICAL MANDATORY BUDGET RESERVE VALIDATION!
    const lowestBasePrice = await getLowestEligibleBasePrice(auction.id, conn);
    const minSquad = parseInt(team.min_squad_size, 10) || 11;
    const purchased = parseInt(team.players_purchased, 10) || 0;
    const remainingBalance = parseFloat(team.remaining_balance);

    // If winning this player, they fill 1 compulsory squad slot!
    // Remaining compulsory slots left to fill AFTER this purchase:
    const remainingAfterThis = Math.max(0, minSquad - (purchased + 1));
    const mandatoryReserveAfterThis = remainingAfterThis * lowestBasePrice;
    const maxAllowableBid = remainingBalance - mandatoryReserveAfterThis;

    if (targetBid > maxAllowableBid) {
      throw {
        statusCode: 400,
        message: `Bid rejected. You must reserve at least ₹${mandatoryReserveAfterThis.toLocaleString('en-IN')} to complete your compulsory squad of ${minSquad} players. Maximum bid allowed: ₹${Math.max(0, maxAllowableBid).toLocaleString('en-IN')}.`
      };
    }

    // 9. Record bid in auction_bids
    await conn.query(
      `INSERT INTO auction_bids 
        (auction_id, player_id, auction_team_id, bid_amount, previous_bid_amount, placed_by_user_id, bid_status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTED')`,
      [auction.id, player.id, team.id, targetBid, currBid, userId]
    );

    // 10. Update timer with extension
    const extensionSecs = currAuction.timer_extension_seconds || 15;
    const timerEndAt = new Date(Date.now() + extensionSecs * 1000);

    // 11. Update auction state
    await conn.query(
      `UPDATE tournament_auctions
       SET current_bid = ?, current_bidder_team_id = ?, timer_end_at = ?
       WHERE id = ?`,
      [targetBid, team.id, timerEndAt, auction.id]
    );

    const nextIncrement = calculateBidIncrement(targetBid, currAuction, player);

    const broadcastPayload = {
      playerId: player.id,
      bidAmount: targetBid,
      previousBid: currBid,
      team: {
        auctionTeamId: team.id,
        teamId: team.team_id,
        teamName: team.team_name,
        teamLogo: team.team_logo
      },
      nextMinimumBid: targetBid + nextIncrement,
      nextIncrement,
      timerEndAt,
      timerSeconds: extensionSecs
    };

    const io = getIO();
    if (io) {
      io.to(`auction:${auction.uuid}`).emit('auction:bidPlaced', broadcastPayload);
    }

    return {
      success: true,
      message: `Bid of ₹${targetBid.toLocaleString('en-IN')} accepted for ${team.team_name}`,
      ...broadcastPayload
    };
  });
};

/**
 * 10. Finalize Player Sale (Atomic SOLD Transaction)
 */
const markPlayerSold = async ({ auctionIdOrUuid, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized: Only operator or admin can finalize player sale.' };
  }

  return await db.transaction(async (conn) => {
    // Lock auction record
    const [auctions] = await conn.query(
      `SELECT * FROM tournament_auctions WHERE id = ? FOR UPDATE`,
      [auction.id]
    );
    const currAuction = auctions[0];

    if (!currAuction.current_player_id) {
      throw { statusCode: 400, message: 'No active player to mark as sold.' };
    }

    if (!currAuction.current_bidder_team_id) {
      throw { statusCode: 400, message: 'Cannot mark SOLD without any bids. Use Mark UNSOLD instead.' };
    }

    const playerId = currAuction.current_player_id;
    const winningTeamId = currAuction.current_bidder_team_id;
    const salePrice = parseFloat(currAuction.current_bid);

    // Lock player record
    const [players] = await conn.query(
      `SELECT * FROM auction_players WHERE id = ? FOR UPDATE`,
      [playerId]
    );
    const player = players[0];

    if (!player || player.status === 'SOLD') {
      throw { statusCode: 400, message: 'This player has already been sold.' };
    }

    // Lock winning team record
    const [teams] = await conn.query(
      `SELECT at.*, t.name as team_name, t.logo_url as team_logo
       FROM auction_teams at
       JOIN teams t ON at.team_id = t.id
       WHERE at.id = ? FOR UPDATE`,
      [winningTeamId]
    );
    const team = teams[0];

    // Deduct amount from team wallet accounting
    const newSpent = parseFloat(team.amount_spent) + salePrice;
    const newBalance = Math.max(0, parseFloat(team.total_budget) - newSpent);
    const newPurchased = parseInt(team.players_purchased, 10) + 1;

    // Recalculate reserve & available budget for team
    const lowestBasePrice = await getLowestEligibleBasePrice(auction.id, conn);
    const remainingReq = Math.max(0, (parseInt(team.min_squad_size, 10) || 11) - newPurchased);
    const newReserve = remainingReq * lowestBasePrice;
    const newAvailable = Math.max(0, newBalance - newReserve);

    // Update auction_teams
    await conn.query(
      `UPDATE auction_teams
       SET amount_spent = ?, remaining_balance = ?, players_purchased = ?,
           reserved_budget = ?, available_bidding_budget = ?
       WHERE id = ?`,
      [newSpent, newBalance, newPurchased, newReserve, newAvailable, team.id]
    );

    // Update player record
    await conn.query(
      `UPDATE auction_players
       SET status = 'SOLD', winning_auction_team_id = ?, sold_price = ?
       WHERE id = ?`,
      [team.id, salePrice, playerId]
    );

    // Add to auction_squads
    await conn.query(
      `INSERT INTO auction_squads (auction_id, auction_team_id, player_id, purchase_price)
       VALUES (?, ?, ?, ?)`,
      [auction.id, team.id, playerId, salePrice]
    );

    // Update winning bid in auction_bids
    await conn.query(
      `UPDATE auction_bids
       SET bid_status = 'WINNING'
       WHERE auction_id = ? AND player_id = ? AND auction_team_id = ?
       ORDER BY id DESC LIMIT 1`,
      [auction.id, playerId, team.id]
    );

    // Reset auction current state
    await conn.query(
      `UPDATE tournament_auctions
       SET current_player_id = NULL, current_bid = 0.00, current_bidder_team_id = NULL, timer_end_at = NULL
       WHERE id = ?`,
      [auction.id]
    );

    // Audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, player_id, team_id, amount, acting_user_id)
       VALUES (?, 'PLAYER_SOLD', ?, ?, ?, ?)`,
      [auction.id, playerId, team.id, salePrice, userId]
    );

    const saleResult = {
      playerId,
      playerName: player.player_name,
      winningTeam: {
        auctionTeamId: team.id,
        teamId: team.team_id,
        teamName: team.team_name,
        teamLogo: team.team_logo,
        totalBudget: parseFloat(team.total_budget),
        amountSpent: newSpent,
        remainingBalance: newBalance,
        reservedBudget: newReserve,
        availableBiddingBudget: newAvailable,
        playersPurchased: newPurchased,
        minSquadSize: team.min_squad_size
      },
      salePrice
    };

    const io = getIO();
    if (io) {
      io.to(`auction:${auction.uuid}`).emit('auction:playerSold', saleResult);
    }

    return {
      success: true,
      message: `${player.player_name} SOLD to ${team.team_name} for ₹${salePrice.toLocaleString('en-IN')}!`,
      saleResult
    };
  });
};

/**
 * 11. Finalize Player Unsold
 */
const markPlayerUnsold = async ({ auctionIdOrUuid, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  return await db.transaction(async (conn) => {
    const [auctions] = await conn.query(
      `SELECT * FROM tournament_auctions WHERE id = ? FOR UPDATE`,
      [auction.id]
    );
    const currAuction = auctions[0];

    if (!currAuction.current_player_id) {
      throw { statusCode: 400, message: 'No active player to mark as unsold.' };
    }

    const playerId = currAuction.current_player_id;

    // Update player status to UNSOLD
    await conn.query(
      `UPDATE auction_players 
       SET status = 'UNSOLD', winning_auction_team_id = NULL, sold_price = NULL 
       WHERE id = ?`,
      [playerId]
    );

    // Reset auction current state
    await conn.query(
      `UPDATE tournament_auctions
       SET current_player_id = NULL, current_bid = 0.00, current_bidder_team_id = NULL, timer_end_at = NULL
       WHERE id = ?`,
      [auction.id]
    );

    // Audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, player_id, acting_user_id)
       VALUES (?, 'PLAYER_UNSOLD', ?, ?)`,
      [auction.id, playerId, userId]
    );

    const [playerRows] = await conn.query('SELECT player_name FROM auction_players WHERE id = ?', [playerId]);
    const playerName = playerRows[0]?.player_name || 'Player';

    const io = getIO();
    if (io) {
      io.to(`auction:${auction.uuid}`).emit('auction:playerUnsold', { playerId, playerName });
    }

    return {
      success: true,
      message: `${playerName} marked as UNSOLD.`,
      playerId
    };
  });
};

/**
 * 12. Re-auction an Unsold Player
 */
const reauctionPlayer = async ({ auctionIdOrUuid, playerId, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  const players = await db.query(
    `SELECT * FROM auction_players WHERE id = ? AND auction_id = ?`,
    [playerId, auction.id]
  );
  if (!players || players.length === 0) {
    throw { statusCode: 404, message: 'Player not found.' };
  }

  const player = players[0];
  if (player.status !== 'UNSOLD' && player.status !== 'AVAILABLE') {
    throw { statusCode: 400, message: 'Only unsold or available players can be re-auctioned.' };
  }

  await db.query(`UPDATE auction_players SET status = 'AVAILABLE' WHERE id = ?`, [playerId]);

  await db.query(
    `INSERT INTO auction_audit_logs (auction_id, action_type, player_id, acting_user_id)
     VALUES (?, 'PLAYER_REAUCTIONED', ?, ?)`,
    [auction.id, playerId, userId]
  );

  return { success: true, message: `${player.player_name} is now available for re-auction.` };
};

/**
 * 13. Complete Auction (Validates completion rules & compulsory squad requirements)
 */
const completeAuction = async ({ auctionIdOrUuid, force = false, exceptionReason = null, userId, userRole }) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  if (!checkAuctionAuthorization({ id: userId, role: userRole }, auction)) {
    throw { statusCode: 403, message: 'Unauthorized.' };
  }

  return await db.transaction(async (conn) => {
    // 1. Validate no player is currently in auction
    const [inAuction] = await conn.query(
      `SELECT id, player_name FROM auction_players WHERE auction_id = ? AND status = 'IN_AUCTION'`,
      [auction.id]
    );
    if (inAuction && inAuction.length > 0) {
      throw {
        statusCode: 400,
        message: `Cannot complete auction while ${inAuction[0].player_name} is still actively on the block. Conclude the sale first.`
      };
    }

    // 2. Validate all teams satisfy compulsory squad size
    const teams = await conn.query(
      `SELECT at.*, t.name as team_name
       FROM auction_teams at
       JOIN teams t ON at.team_id = t.id
       WHERE at.auction_id = ?`,
      [auction.id]
    );

    const nonCompliantTeams = [];
    for (const t of teams) {
      const minSquad = parseInt(t.min_squad_size, 10) || 11;
      const bought = parseInt(t.players_purchased, 10) || 0;
      if (bought < minSquad) {
        nonCompliantTeams.push({
          teamName: t.team_name,
          purchased: bought,
          required: minSquad,
          missing: minSquad - bought
        });
      }
    }

    if (nonCompliantTeams.length > 0 && !force) {
      throw {
        statusCode: 400,
        message: 'Cannot mark auction complete. The following teams have not satisfied their compulsory squad size:',
        nonCompliantTeams
      };
    }

    // Update auction status to COMPLETED
    await conn.query(
      `UPDATE tournament_auctions
       SET status = 'COMPLETED', current_player_id = NULL, current_bid = 0.00,
           current_bidder_team_id = NULL, timer_end_at = NULL
       WHERE id = ?`,
      [auction.id]
    );

    // Audit log
    await conn.query(
      `INSERT INTO auction_audit_logs (auction_id, action_type, acting_user_id, details)
       VALUES (?, 'AUCTION_COMPLETED', ?, ?)`,
      [auction.id, userId, JSON.stringify({ force, exceptionReason, nonCompliantTeams })]
    );

    const io = getIO();
    if (io) {
      io.to(`auction:${auction.uuid}`).emit('auction:statusChanged', { status: 'COMPLETED' });
    }

    return {
      success: true,
      message: 'Auction successfully completed!',
      nonCompliantTeams
    };
  });
};

/**
 * 14. Get Detailed Post-Auction Reports
 */
const getAuctionReports = async (auctionIdOrUuid) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  // Summary Metrics
  const summaryRows = await db.query(
    `SELECT 
      COUNT(*) as total_registered,
      SUM(CASE WHEN status = 'SOLD' THEN 1 ELSE 0 END) as total_sold,
      SUM(CASE WHEN status = 'UNSOLD' THEN 1 ELSE 0 END) as total_unsold,
      SUM(CASE WHEN status = 'AVAILABLE' THEN 1 ELSE 0 END) as total_available,
      COALESCE(MAX(sold_price), 0) as highest_sale,
      COALESCE(AVG(CASE WHEN status = 'SOLD' THEN sold_price END), 0) as average_sale,
      COALESCE(SUM(sold_price), 0) as total_spent
     FROM auction_players
     WHERE auction_id = ?`,
    [auction.id]
  );
  const summary = summaryRows && summaryRows[0] ? summaryRows[0] : {};

  // Highest sale player details
  const topPlayerRows = await db.query(
    `SELECT ap.player_name, ap.sold_price, t.name as winning_team_name, t.logo_url as winning_team_logo
     FROM auction_players ap
     JOIN auction_teams at ON ap.winning_auction_team_id = at.id
     JOIN teams t ON at.team_id = t.id
     WHERE ap.auction_id = ? AND ap.status = 'SOLD'
     ORDER BY ap.sold_price DESC LIMIT 1`,
    [auction.id]
  );
  const topPlayer = topPlayerRows && topPlayerRows[0] ? topPlayerRows[0] : null;

  // Team-wise reports & squads
  const teams = await db.query(
    `SELECT at.*, t.name as team_name, t.logo_url as team_logo
     FROM auction_teams at
     JOIN teams t ON at.team_id = t.id
     WHERE at.auction_id = ?
     ORDER BY at.amount_spent DESC, t.name ASC`,
    [auction.id]
  );

  const teamReports = [];
  for (const t of teams) {
    const squadPlayers = await db.query(
      `SELECT ap.id, ap.player_name, ap.role, ap.batting_style, ap.bowling_style,
              ap.sold_price, ac.name as category_name
       FROM auction_players ap
       LEFT JOIN auction_categories ac ON ap.category_id = ac.id
       WHERE ap.winning_auction_team_id = ?
       ORDER BY ap.sold_price DESC`,
      [t.id]
    );

    teamReports.push({
      id: t.id,
      teamId: t.team_id,
      teamName: t.team_name,
      teamLogo: t.team_logo,
      totalBudget: parseFloat(t.total_budget),
      amountSpent: parseFloat(t.amount_spent),
      remainingBalance: parseFloat(t.remaining_balance),
      minSquadSize: t.min_squad_size,
      maxSquadSize: t.max_squad_size,
      playersPurchased: parseInt(t.players_purchased, 10),
      isSquadComplete: parseInt(t.players_purchased, 10) >= parseInt(t.min_squad_size, 10),
      squad: squadPlayers.map((p) => ({
        id: p.id,
        name: p.player_name,
        role: p.role,
        battingStyle: p.batting_style,
        bowlingStyle: p.bowling_style,
        category: p.category_name,
        purchasePrice: parseFloat(p.sold_price)
      }))
    });
  }

  // Player-wise list
  const players = await db.query(
    `SELECT ap.*, ac.name as category_name, t.name as winning_team_name, t.logo_url as winning_team_logo
     FROM auction_players ap
     LEFT JOIN auction_categories ac ON ap.category_id = ac.id
     LEFT JOIN auction_teams at ON ap.winning_auction_team_id = at.id
     LEFT JOIN teams t ON at.team_id = t.id
     WHERE ap.auction_id = ?
     ORDER BY ap.sold_price DESC, ap.lot_number ASC`,
    [auction.id]
  );

  return {
    summary: {
      totalRegistered: parseInt(summary.total_registered || 0, 10),
      totalSold: parseInt(summary.total_sold || 0, 10),
      totalUnsold: parseInt(summary.total_unsold || 0, 10),
      totalAvailable: parseInt(summary.total_available || 0, 10),
      highestSale: parseFloat(summary.highest_sale || 0),
      highestSalePlayer: topPlayer ? {
        name: topPlayer.player_name,
        price: parseFloat(topPlayer.sold_price),
        team: topPlayer.winning_team_name,
        teamLogo: topPlayer.winning_team_logo
      } : null,
      averageSale: parseFloat(summary.average_sale || 0),
      totalSpent: parseFloat(summary.total_spent || 0)
    },
    teams: teamReports,
    players: players.map((p) => ({
      id: p.id,
      name: p.player_name,
      role: p.role,
      category: p.category_name,
      basePrice: parseFloat(p.base_price),
      soldPrice: p.sold_price ? parseFloat(p.sold_price) : null,
      status: p.status,
      winningTeam: p.winning_team_name ? {
        name: p.winning_team_name,
        logo: p.winning_team_logo
      } : null
    }))
  };
};

/**
 * 15. Get Auction Audit Logs
 */
const getAuctionAuditLogs = async (auctionIdOrUuid) => {
  const auction = await resolveAuction(auctionIdOrUuid);
  if (!auction) throw { statusCode: 404, message: 'Auction not found.' };

  const logs = await db.query(
    `SELECT aal.*, u.full_name as actor_name, ap.player_name, t.name as team_name
     FROM auction_audit_logs aal
     LEFT JOIN users u ON aal.acting_user_id = u.id
     LEFT JOIN auction_players ap ON aal.player_id = ap.id
     LEFT JOIN auction_teams at ON aal.team_id = at.id
     LEFT JOIN teams t ON at.team_id = t.id
     WHERE aal.auction_id = ?
     ORDER BY aal.id DESC LIMIT 100`,
    [auction.id]
  );

  return logs.map((l) => ({
    id: l.id,
    action: l.action_type,
    playerName: l.player_name,
    teamName: l.team_name,
    amount: l.amount ? parseFloat(l.amount) : null,
    actorName: l.actor_name,
    timestamp: l.created_at,
    details: typeof l.details === 'string' ? JSON.parse(l.details) : l.details
  }));
};

module.exports = {
  getTournamentAuction,
  configureAuction,
  registerTeamsForAuction,
  registerPlayersForAuction,
  updateAuctionPlayer,
  startAuction,
  setAuctionStatus,
  selectPlayerForBidding,
  placeBid,
  markPlayerSold,
  markPlayerUnsold,
  reauctionPlayer,
  completeAuction,
  getAuctionReports,
  getAuctionAuditLogs,
  getAuctionPlayers,
  deleteAuctionPlayer,
  recalculateTeamBudgets,
  getLowestEligibleBasePrice,
  calculateBidIncrement
};
