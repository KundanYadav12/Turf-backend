const crypto = require('crypto');
const db = require('../config/database');
const { getIO } = require('./socketService');

/**
 * WhatsApp-Style Real-Time Chat System Service
 */

// Helper to safely get Socket.IO instance
function getSocketIO() {
  try {
    return getIO();
  } catch (err) {
    return null;
  }
}

// Helper to check if user has global platform ADMIN role
async function isUserSuperAdmin(userId) {
  try {
    const roles = await db.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id = r.id WHERE ur.user_id = ?`,
      [Number(userId)]
    );
    return Array.isArray(roles) && roles.some(r => r.name === 'ADMIN' || r.name === 'SUPER_ADMIN');
  } catch (e) {
    return false;
  }
}

/**
 * Format conversation record for user view
 */
async function formatConversationForUser(conv, userId, userMap = null) {
  // If DIRECT, resolve the other user's info as title & image
  let title = conv.title;
  let imageUrl = conv.image_url;
  let otherUser = null;

  if (conv.type === 'DIRECT' && conv.direct_user_pair) {
    const ids = conv.direct_user_pair.split(':').map(Number);
    const otherId = ids[0] === Number(userId) ? ids[1] : ids[0];

    if (otherId && !isNaN(otherId)) {
      if (userMap && userMap.has(otherId)) {
        otherUser = userMap.get(otherId);
      } else {
        try {
          const users = await db.query(
            `SELECT id, full_name, username, profile_photo, status FROM users WHERE id = ?`,
            [otherId]
          );
          if (users && users.length > 0) {
            otherUser = users[0];
          }
        } catch (e) {
          console.warn('[formatConversationForUser] Failed to fetch other user:', otherId, e.message);
        }
      }

      if (otherUser) {
        title = otherUser.full_name || otherUser.username || `User #${otherId}`;
        imageUrl = otherUser.profile_photo || null;
      }
    }
  }

  return {
    id: conv.id,
    uuid: conv.uuid,
    type: conv.type,
    title: title || (conv.type === 'DIRECT' ? 'Direct Message' : 'Group Chat'),
    imageUrl: imageUrl || null,
    teamId: conv.team_id || null,
    tournamentId: conv.tournament_id || null,
    messagingPermission: conv.messaging_permission || 'EVERYONE',
    lastMessageId: conv.last_message_id || null,
    lastMessagePreview: conv.last_message_preview || null,
    lastMessageAt: conv.last_message_at || null,
    unreadCount: conv.user_unread_count || 0,
    role: conv.user_role || 'MEMBER',
    isExternal: Boolean(conv.user_is_external),
    isMuted: Boolean(conv.user_is_muted),
    otherUser,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at
  };
}

/**
 * 1. Synchronize or create a Team Group Conversation
 */
async function syncTeamGroup(teamId) {
  if (!teamId) return null;

  // Resolve team
  const teams = await db.query(
    `SELECT id, uuid, name, logo_url, captain_id, owner_id FROM teams WHERE id = ? OR uuid = ? LIMIT 1`,
    [teamId, String(teamId)]
  );
  if (!teams || teams.length === 0) return null;
  const team = teams[0];

  // Check if conversation already exists
  let convs = await db.query(
    `SELECT * FROM chat_conversations WHERE team_id = ? LIMIT 1`,
    [team.id]
  );
  let conversationId;

  if (!convs || convs.length === 0) {
    const uuid = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO chat_conversations (uuid, type, title, image_url, team_id, created_by, messaging_permission)
       VALUES (?, 'TEAM', ?, ?, ?, ?, 'EVERYONE')`,
      [uuid, team.name, team.logo_url || null, team.id, team.owner_id || team.captain_id || null]
    );
    conversationId = result.insertId;
  } else {
    conversationId = convs[0].id;
    // Update team title and image if changed
    await db.query(
      `UPDATE chat_conversations SET title = ?, image_url = COALESCE(?, image_url) WHERE id = ?`,
      [team.name, team.logo_url, conversationId]
    );
  }

  // Active roster members
  const members = await db.query(
    `SELECT tm.user_id, tm.is_captain, tm.role 
     FROM team_members tm 
     WHERE tm.team_id = ? AND tm.deleted_at IS NULL AND tm.user_id IS NOT NULL`,
    [team.id]
  );

  const activeUserMap = new Map();
  // Owner is always OWNER
  if (team.owner_id) {
    activeUserMap.set(Number(team.owner_id), 'OWNER');
  }
  // Captain is ADMIN
  if (team.captain_id) {
    if (!activeUserMap.has(Number(team.captain_id))) {
      activeUserMap.set(Number(team.captain_id), 'ADMIN');
    }
  }
  // Add roster members
  for (const m of members) {
    const uId = Number(m.user_id);
    if (!activeUserMap.has(uId)) {
      activeUserMap.set(uId, m.is_captain ? 'ADMIN' : 'MEMBER');
    }
  }

  // Fetch current participants who are roster players (is_external = 0)
  const currentParticipants = await db.query(
    `SELECT id, user_id, role, left_at FROM chat_participants WHERE conversation_id = ? AND is_external = 0`,
    [conversationId]
  );
  const currentPartMap = new Map(currentParticipants.map(p => [Number(p.user_id), p]));

  // Update or insert active roster players
  for (const [uId, role] of activeUserMap.entries()) {
    if (currentPartMap.has(uId)) {
      const part = currentPartMap.get(uId);
      if (part.left_at !== null || (part.role !== 'OWNER' && part.role !== role)) {
        await db.query(
          `UPDATE chat_participants SET left_at = NULL, role = ? WHERE id = ?`,
          [part.role === 'OWNER' ? 'OWNER' : role, part.id]
        );
      }
    } else {
      await db.query(
        `INSERT INTO chat_participants (conversation_id, user_id, role, is_external) 
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE left_at = NULL, role = VALUES(role)`,
        [conversationId, uId, role]
      );
    }
  }

  // Soft-remove members no longer on team roster
  for (const [uId, part] of currentPartMap.entries()) {
    if (!activeUserMap.has(uId) && part.left_at === null) {
      await db.query(
        `UPDATE chat_participants SET left_at = NOW() WHERE id = ?`,
        [part.id]
      );
    }
  }

  return getConversationById(conversationId);
}

/**
 * 2. Synchronize or create a Tournament Group Conversation
 */
async function syncTournamentGroup(tournamentId) {
  if (!tournamentId) return null;

  const tournaments = await db.query(
    `SELECT id, uuid, name, banner_url, created_by FROM tournaments WHERE id = ? OR uuid = ? LIMIT 1`,
    [tournamentId, String(tournamentId)]
  );
  if (!tournaments || tournaments.length === 0) return null;
  const tour = tournaments[0];

  let convs = await db.query(
    `SELECT * FROM chat_conversations WHERE tournament_id = ? LIMIT 1`,
    [tour.id]
  );
  let conversationId;

  if (!convs || convs.length === 0) {
    const uuid = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO chat_conversations (uuid, type, title, image_url, tournament_id, created_by, messaging_permission)
       VALUES (?, 'TOURNAMENT', ?, ?, ?, ?, 'EVERYONE')`,
      [uuid, tour.name, tour.banner_url || null, tour.id, tour.created_by]
    );
    conversationId = result.insertId;
  } else {
    conversationId = convs[0].id;
    await db.query(
      `UPDATE chat_conversations SET title = ?, image_url = COALESCE(?, image_url) WHERE id = ?`,
      [tour.name, tour.banner_url, conversationId]
    );
  }

  // Active users in tournament: organizer + team owners/captains/players
  const activeUserMap = new Map();
  if (tour.created_by) {
    activeUserMap.set(Number(tour.created_by), 'OWNER');
  }

  // Get participating teams
  const registeredTeams = await db.query(
    `SELECT tt.team_id, tt.player_1_id, tt.player_2_id, t.owner_id, t.captain_id
     FROM tournament_teams tt
     LEFT JOIN teams t ON tt.team_id = t.id
     WHERE tt.tournament_id = ? AND (tt.registration_status IS NULL OR tt.registration_status IN ('APPROVED', 'PAID', 'REGISTERED', 'CONFIRMED'))`,
    [tour.id]
  );

  const teamIds = [];
  for (const rt of registeredTeams) {
    if (rt.owner_id) activeUserMap.set(Number(rt.owner_id), 'MEMBER');
    if (rt.captain_id) activeUserMap.set(Number(rt.captain_id), 'MEMBER');
    if (rt.player_1_id) activeUserMap.set(Number(rt.player_1_id), 'MEMBER');
    if (rt.player_2_id) activeUserMap.set(Number(rt.player_2_id), 'MEMBER');
    if (rt.team_id) teamIds.push(rt.team_id);
  }

  // Add players from team_members for those registered teams
  if (teamIds.length > 0) {
    const placeholders = teamIds.map(() => '?').join(',');
    const rosterPlayers = await db.query(
      `SELECT user_id FROM team_members WHERE team_id IN (${placeholders}) AND deleted_at IS NULL AND user_id IS NOT NULL`,
      teamIds
    );
    for (const rp of rosterPlayers) {
      const uId = Number(rp.user_id);
      if (!activeUserMap.has(uId)) {
        activeUserMap.set(uId, 'MEMBER');
      }
    }
  }

  // Fetch current participants
  const currentParticipants = await db.query(
    `SELECT id, user_id, role, left_at FROM chat_participants WHERE conversation_id = ? AND is_external = 0`,
    [conversationId]
  );
  const currentPartMap = new Map(currentParticipants.map(p => [Number(p.user_id), p]));

  // Sync users
  for (const [uId, role] of activeUserMap.entries()) {
    if (currentPartMap.has(uId)) {
      const part = currentPartMap.get(uId);
      if (part.left_at !== null) {
        await db.query(
          `UPDATE chat_participants SET left_at = NULL WHERE id = ?`,
          [part.id]
        );
      }
    } else {
      await db.query(
        `INSERT INTO chat_participants (conversation_id, user_id, role, is_external) 
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE left_at = NULL`,
        [conversationId, uId, role]
      );
    }
  }

  // Mark left if no longer registered in tournament (except organizer)
  for (const [uId, part] of currentPartMap.entries()) {
    if (!activeUserMap.has(uId) && part.left_at === null && part.role !== 'OWNER') {
      await db.query(
        `UPDATE chat_participants SET left_at = NOW() WHERE id = ?`,
        [part.id]
      );
    }
  }

  return getConversationById(conversationId);
}

/**
 * 3. Get or Create Direct 1-to-1 Conversation
 */
async function getOrCreateDirectConversation(user1Id, user2Id) {
  const u1 = Number(user1Id);
  const u2 = Number(user2Id);
  if (!u1 || !u2 || isNaN(u1) || isNaN(u2) || u1 === u2) {
    const err = new Error(u1 === u2 ? 'You cannot start a direct conversation with yourself.' : 'Invalid target user for direct conversation.');
    err.statusCode = 400;
    throw err;
  }

  // Verify target user exists
  const targetUserRows = await db.query(
    'SELECT id, full_name, username, profile_photo, status FROM users WHERE id = ?',
    [u2]
  );
  if (!targetUserRows || targetUserRows.length === 0) {
    const err = new Error('The selected user could not be found.');
    err.statusCode = 404;
    throw err;
  }

  const [minId, maxId] = [Math.min(u1, u2), Math.max(u1, u2)];
  const pairKey = `${minId}:${maxId}`;

  // Check if exists
  let convs = await db.query(
    `SELECT * FROM chat_conversations WHERE direct_user_pair = ? LIMIT 1`,
    [pairKey]
  );

  let conversationId;
  if (!convs || convs.length === 0) {
    const uuid = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO chat_conversations (uuid, type, direct_user_pair, created_by, messaging_permission)
       VALUES (?, 'DIRECT', ?, ?, 'EVERYONE')`,
      [uuid, pairKey, u1]
    );
    conversationId = result.insertId;

    // Add both participants idempotently
    await db.query(
      `INSERT INTO chat_participants (conversation_id, user_id, role, is_external) 
       VALUES (?, ?, 'MEMBER', 0), (?, ?, 'MEMBER', 0)
       ON DUPLICATE KEY UPDATE left_at = NULL`,
      [conversationId, u1, conversationId, u2]
    );
  } else {
    conversationId = convs[0].id;
    // Ensure both participants are present and active
    await db.query(
      `INSERT INTO chat_participants (conversation_id, user_id, role, is_external) 
       VALUES (?, ?, 'MEMBER', 0), (?, ?, 'MEMBER', 0)
       ON DUPLICATE KEY UPDATE left_at = NULL`,
      [conversationId, u1, conversationId, u2]
    );
  }

  const conv = await getConversationById(conversationId);
  const otherUser = targetUserRows[0];
  const userMap = new Map([[u2, otherUser]]);
  return formatConversationForUser(conv, u1, userMap);
}

/**
 * Get Conversation Entity by ID or UUID
 */
async function getConversationById(idOrUuid) {
  const isNum = /^\d+$/.test(String(idOrUuid).trim());
  const rows = isNum
    ? await db.query(`SELECT * FROM chat_conversations WHERE id = ? LIMIT 1`, [Number(idOrUuid)])
    : await db.query(`SELECT * FROM chat_conversations WHERE uuid = ? LIMIT 1`, [String(idOrUuid)]);
  return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * 4. Get all conversations for a user with unread counts and latest messages
 */
async function getUserConversations(userId) {
  const uId = Number(userId);
  if (!uId || isNaN(uId)) return [];

  const rows = await db.query(
    `SELECT c.*, 
            cp.role as user_role, 
            cp.is_external as user_is_external, 
            cp.is_muted as user_is_muted, 
            cp.unread_count as user_unread_count,
            cp.joined_at as user_joined_at
     FROM chat_participants cp
     JOIN chat_conversations c ON cp.conversation_id = c.id
     WHERE cp.user_id = ? AND cp.left_at IS NULL
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    [uId]
  );

  if (!rows || rows.length === 0) return [];

  // Batch resolve otherUser for all DIRECT conversations in a single fast query
  const directOtherIds = new Set();
  for (const conv of rows) {
    if (conv.type === 'DIRECT' && conv.direct_user_pair) {
      const ids = conv.direct_user_pair.split(':').map(Number);
      const otherId = ids[0] === uId ? ids[1] : ids[0];
      if (otherId && !isNaN(otherId)) {
        directOtherIds.add(otherId);
      }
    }
  }

  const userMap = new Map();
  if (directOtherIds.size > 0) {
    const idList = Array.from(directOtherIds);
    const placeholders = idList.map(() => '?').join(',');
    try {
      const users = await db.query(
        `SELECT id, full_name, username, profile_photo, status FROM users WHERE id IN (${placeholders})`,
        idList
      );
      if (users && users.length > 0) {
        users.forEach(u => userMap.set(Number(u.id), u));
      }
    } catch (e) {
      console.warn('[getUserConversations] Failed to batch load other users:', e.message);
    }
  }

  const formatted = [];
  for (const conv of rows) {
    try {
      formatted.push(await formatConversationForUser(conv, uId, userMap));
    } catch (convErr) {
      console.warn('[getUserConversations] Error formatting item:', conv.id, convErr.message);
    }
  }
  return formatted;
}

/**
 * 5. Get Detailed Conversation with Participants
 */
async function getConversationDetails(conversationId, userId) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const uId = Number(userId);
  // Check user participation
  const parts = await db.query(
    `SELECT cp.*, u.full_name, u.username, u.profile_photo, u.status as user_status
     FROM chat_participants cp
     JOIN users u ON cp.user_id = u.id
     WHERE cp.conversation_id = ? AND cp.left_at IS NULL
     ORDER BY 
       CASE cp.role WHEN 'OWNER' THEN 1 WHEN 'ADMIN' THEN 2 ELSE 3 END,
       u.full_name ASC`,
    [conv.id]
  );

  const currentUserPart = parts.find(p => Number(p.user_id) === uId);
  if (!currentUserPart) {
    const err = new Error('You are not a participant in this conversation');
    err.status = 403;
    throw err;
  }

  const formattedConv = await formatConversationForUser({
    ...conv,
    user_role: currentUserPart.role,
    user_is_external: currentUserPart.is_external,
    user_is_muted: currentUserPart.is_muted,
    user_unread_count: currentUserPart.unread_count
  }, uId);

  return {
    ...formattedConv,
    participants: parts.map(p => ({
      userId: p.user_id,
      fullName: p.full_name,
      username: p.username,
      profilePhoto: p.profile_photo,
      role: p.role,
      isExternal: Boolean(p.is_external),
      joinedAt: p.joined_at
    }))
  };
}

/**
 * 6. Get Paginated Conversation Messages (WhatsApp style: latest 30, cursor pagination)
 */
async function getConversationMessages(conversationId, userId, { cursor = null, limit = 40 } = {}) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const uId = Number(userId);
  // Check participant
  const parts = await db.query(
    `SELECT joined_at, left_at FROM chat_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conv.id, uId]
  );
  if (!parts || parts.length === 0) {
    const err = new Error('Access denied. Not a participant in this chat.');
    err.status = 403;
    throw err;
  }

  const userJoinedAt = parts[0].joined_at;

  let querySql = `
    SELECT m.*, 
           u.full_name as sender_name, 
           u.username as sender_username, 
           u.profile_photo as sender_photo,
           rm.content as reply_content,
           rm.message_type as reply_type,
           ru.full_name as reply_sender_name
    FROM chat_messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN chat_messages rm ON m.reply_to_message_id = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.conversation_id = ? 
  `;
  const queryParams = [conv.id];

  if (cursor) {
    querySql += ` AND m.id < ? `;
    queryParams.push(Number(cursor));
  }

  querySql += ` ORDER BY m.id DESC LIMIT ?`;
  queryParams.push(Math.min(Number(limit) || 40, 100));

  const messages = await db.query(querySql, queryParams);

  // Fetch attachments for these messages
  if (messages.length > 0) {
    const msgIds = messages.map(m => m.id);
    const placeholders = msgIds.map(() => '?').join(',');
    const attachments = await db.query(
      `SELECT * FROM chat_message_attachments WHERE message_id IN (${placeholders})`,
      msgIds
    );

    const attachMap = new Map();
    for (const a of attachments) {
      if (!attachMap.has(a.message_id)) attachMap.set(a.message_id, []);
      attachMap.get(a.message_id).push({
        id: a.id,
        fileUrl: a.file_url,
        fileName: a.file_name,
        fileType: a.file_type,
        fileSize: a.file_size
      });
    }

    // Read receipts
    const receipts = await db.query(
      `SELECT message_id, user_id, read_at FROM chat_read_receipts WHERE message_id IN (${placeholders})`,
      msgIds
    );
    const receiptMap = new Map();
    for (const r of receipts) {
      if (!receiptMap.has(r.message_id)) receiptMap.set(r.message_id, []);
      receiptMap.get(r.message_id).push({ userId: r.user_id, readAt: r.read_at });
    }

    for (const msg of messages) {
      msg.attachments = attachMap.get(msg.id) || [];
      msg.readReceipts = receiptMap.get(msg.id) || [];
    }
  }

  // Reverse so chronological order (oldest to newest in the loaded batch)
  const items = messages.reverse().map(m => ({
    id: m.id,
    uuid: m.uuid,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    senderName: m.sender_name || 'System',
    senderUsername: m.sender_username,
    senderPhoto: m.sender_photo,
    messageType: m.message_type,
    content: m.is_deleted ? 'This message was deleted' : m.content,
    replyTo: m.reply_to_message_id ? {
      id: m.reply_to_message_id,
      content: m.reply_content,
      type: m.reply_type,
      senderName: m.reply_sender_name
    } : null,
    attachments: m.attachments || [],
    readReceipts: m.readReceipts || [],
    isEdited: Boolean(m.is_edited),
    isDeleted: Boolean(m.is_deleted),
    createdAt: m.created_at
  }));

  const nextCursor = messages.length > 0 ? messages[0].id : null;

  return {
    items,
    nextCursor
  };
}

/**
 * 7. Send a Message
 */
async function sendMessage(conversationId, senderId, { content, messageType = 'TEXT', replyToMessageId = null, attachments = [] }) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const sId = Number(senderId);
  const isSuper = await isUserSuperAdmin(sId);

  // Validate participation and permissions
  let parts = await db.query(
    `SELECT role, left_at FROM chat_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conv.id, sId]
  );

  if ((!parts || parts.length === 0 || parts[0].left_at !== null)) {
    if (isSuper) {
      // Super admin can participate in any group chat as ADMIN
      await db.query(
        `INSERT INTO chat_participants (conversation_id, user_id, role, is_external, left_at)
         VALUES (?, ?, 'ADMIN', 1, NULL)
         ON DUPLICATE KEY UPDATE left_at = NULL, role = 'ADMIN'`,
        [conv.id, sId]
      );
      parts = [{ role: 'ADMIN', left_at: null }];
    } else {
      const err = new Error('You are not an active participant in this chat');
      err.status = 403;
      throw err;
    }
  }

  const userRole = parts[0].role;
  const isAdminOrOwner = userRole === 'ADMIN' || userRole === 'OWNER' || isSuper;

  // Enforce ADMINS_ONLY messaging permission
  if (conv.messaging_permission === 'ADMINS_ONLY' && !isAdminOrOwner) {
    const err = new Error('Only group admins can send messages to this group');
    err.status = 403;
    err.code = 'ADMINS_ONLY_RESTRICTION';
    throw err;
  }

  const msgUuid = crypto.randomUUID();
  const res = await db.query(
    `INSERT INTO chat_messages (uuid, conversation_id, sender_id, message_type, content, reply_to_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [msgUuid, conv.id, sId, messageType, content || '', replyToMessageId || null]
  );
  const messageId = res.insertId;

  // Insert attachments
  const savedAttachments = [];
  if (Array.isArray(attachments) && attachments.length > 0) {
    for (const att of attachments) {
      const attRes = await db.query(
        `INSERT INTO chat_message_attachments (message_id, file_url, file_name, file_type, file_size)
         VALUES (?, ?, ?, ?, ?)`,
        [messageId, att.fileUrl, att.fileName || 'file', att.fileType || 'image/jpeg', att.fileSize || 0]
      );
      savedAttachments.push({
        id: attRes.insertId,
        fileUrl: att.fileUrl,
        fileName: att.fileName,
        fileType: att.fileType,
        fileSize: att.fileSize
      });
    }
  }

  // Update conversation last message preview
  let preview = content ? content.slice(0, 100) : '';
  if (messageType === 'IMAGE') {
    preview = '📷 Photo';
  } else if (messageType === 'SYSTEM') {
    preview = content;
  }

  await db.query(
    `UPDATE chat_conversations 
     SET last_message_id = ?, last_message_preview = ?, last_message_at = NOW() 
     WHERE id = ?`,
    [messageId, preview, conv.id]
  );

  // Increment unread count for other active participants
  await db.query(
    `UPDATE chat_participants 
     SET unread_count = unread_count + 1 
     WHERE conversation_id = ? AND user_id != ? AND left_at IS NULL`,
    [conv.id, sId]
  );

  // Fetch sender details
  const senders = await db.query(
    `SELECT id, full_name, username, profile_photo FROM users WHERE id = ?`,
    [sId]
  );
  const sender = senders[0] || {};

  // Fetch reply preview if any
  let replyObj = null;
  if (replyToMessageId) {
    const replies = await db.query(
      `SELECT m.id, m.content, m.message_type, u.full_name as sender_name 
       FROM chat_messages m 
       LEFT JOIN users u ON m.sender_id = u.id 
       WHERE m.id = ?`,
      [replyToMessageId]
    );
    if (replies.length > 0) {
      replyObj = {
        id: replies[0].id,
        content: replies[0].content,
        type: replies[0].message_type,
        senderName: replies[0].sender_name
      };
    }
  }

  const messagePayload = {
    id: messageId,
    uuid: msgUuid,
    conversationId: conv.id,
    conversationUuid: conv.uuid,
    senderId: sId,
    senderName: sender.full_name || 'Member',
    senderUsername: sender.username,
    senderPhoto: sender.profile_photo,
    messageType,
    content: content || '',
    replyTo: replyObj,
    attachments: savedAttachments,
    readReceipts: [],
    isEdited: false,
    isDeleted: false,
    createdAt: new Date().toISOString()
  };

  // Broadcast real-time Socket.IO events
  const io = getSocketIO();
  if (io) {
    // 1. To active conversation room (numeric and uuid)
    io.to(`chat:conversation:${conv.id}`).emit('chat:new_message', messagePayload);
    io.to(`chat:conversation:${conv.uuid}`).emit('chat:new_message', messagePayload);

    // 2. To every participant's personal room for conversation list update & unread badge
    const participants = await db.query(
      `SELECT user_id, unread_count FROM chat_participants WHERE conversation_id = ? AND left_at IS NULL`,
      [conv.id]
    );

    for (const p of participants) {
      io.to(`user:${p.user_id}`).emit('chat:conversation_updated', {
        conversationId: conv.id,
        conversationUuid: conv.uuid,
        lastMessagePreview: preview,
        lastMessageAt: messagePayload.createdAt,
        unreadCount: p.unread_count,
        latestMessage: messagePayload
      });
      // In-app notification for others
      if (Number(p.user_id) !== sId) {
        io.to(`user:${p.user_id}`).emit('chat:in_app_notification', {
          conversationId: conv.id,
          conversationTitle: conv.title || sender.full_name,
          senderName: sender.full_name,
          preview,
          messageType
        });
      }
    }
  }

  return messagePayload;
}

/**
 * 8. Mark Conversation as Read
 */
async function markConversationAsRead(conversationId, userId, messageId = null) {
  const conv = await getConversationById(conversationId);
  if (!conv) return { success: false };

  const uId = Number(userId);

  // Update participant unread count and last read
  await db.query(
    `UPDATE chat_participants 
     SET unread_count = 0, 
         last_read_message_id = COALESCE(?, last_read_message_id),
         last_read_at = NOW() 
     WHERE conversation_id = ? AND user_id = ?`,
    [messageId || conv.last_message_id, conv.id, uId]
  );

  // Record read receipt if messageId provided
  const targetMsgId = messageId || conv.last_message_id;
  if (targetMsgId) {
    await db.query(
      `INSERT INTO chat_read_receipts (message_id, user_id) 
       VALUES (?, ?) 
       ON DUPLICATE KEY UPDATE read_at = NOW()`,
      [targetMsgId, uId]
    );
  }

  // Socket broadcast read receipt
  const io = getSocketIO();
  if (io) {
    const payload = {
      conversationId: conv.id,
      userId: uId,
      messageId: targetMsgId,
      readAt: new Date().toISOString()
    };
    io.to(`chat:conversation:${conv.id}`).emit('chat:read_receipt', payload);
    io.to(`chat:conversation:${conv.uuid}`).emit('chat:read_receipt', payload);

    // Update user unread total badge
    const totalUnread = await getTotalUnreadCount(uId);
    io.to(`user:${uId}`).emit('chat:total_unread', { totalUnread });
  }

  return { success: true };
}

/**
 * 9. Update Group Settings (Messaging Permission, Title, Image)
 */
async function updateGroupSettings(conversationId, actorUserId, { messagingPermission, title, imageUrl }) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const aId = Number(actorUserId);
  const isSuper = await isUserSuperAdmin(aId);

  let parts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
    [conv.id, aId]
  );

  const isAdminOrOwner = (parts && parts.length > 0 && (parts[0].role === 'ADMIN' || parts[0].role === 'OWNER')) || isSuper;
  if (!isAdminOrOwner) {
    const err = new Error('Forbidden. Only group admins can change group settings.');
    err.status = 403;
    throw err;
  }

  const updates = [];
  const params = [];
  let systemMsg = null;

  if (messagingPermission && ['EVERYONE', 'ADMINS_ONLY'].includes(messagingPermission)) {
    updates.push('messaging_permission = ?');
    params.push(messagingPermission);
    const label = messagingPermission === 'ADMINS_ONLY' ? 'Only Admins Can Send Messages' : 'Everyone Can Send Messages';
    systemMsg = `Admin changed group settings: ${label}`;
  }

  if (title && title.trim().length > 0) {
    updates.push('title = ?');
    params.push(title.trim());
  }

  if (imageUrl !== undefined) {
    updates.push('image_url = ?');
    params.push(imageUrl);
  }

  if (updates.length > 0) {
    params.push(conv.id);
    await db.query(`UPDATE chat_conversations SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  // Send system message notification if messaging permission changed
  if (systemMsg) {
    await sendMessage(conv.id, aId, {
      content: systemMsg,
      messageType: 'SYSTEM'
    });
  }

  const updatedConv = await getConversationById(conv.id);
  const io = getSocketIO();
  if (io) {
    io.to(`chat:conversation:${conv.id}`).emit('chat:settings_updated', {
      conversationId: conv.id,
      messagingPermission: updatedConv.messaging_permission,
      title: updatedConv.title,
      imageUrl: updatedConv.image_url
    });
  }

  return updatedConv;
}

/**
 * 10. Add External Member to Team Chat
 */
async function addExternalMember(conversationId, actorUserId, targetUserId) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const aId = Number(actorUserId);
  const tId = Number(targetUserId);

  const actorParts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
    [conv.id, aId]
  );
  if (!actorParts || actorParts.length === 0 || (actorParts[0].role !== 'ADMIN' && actorParts[0].role !== 'OWNER')) {
    const err = new Error('Forbidden. Only group admins can add external members.');
    err.status = 403;
    throw err;
  }

  // Check target user
  const users = await db.query(`SELECT id, full_name FROM users WHERE id = ?`, [tId]);
  if (!users || users.length === 0) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const targetUser = users[0];

  // Insert or update participant
  await db.query(
    `INSERT INTO chat_participants (conversation_id, user_id, role, is_external, left_at)
     VALUES (?, ?, 'MEMBER', 1, NULL)
     ON DUPLICATE KEY UPDATE left_at = NULL, is_external = 1`,
    [conv.id, tId]
  );

  // Send system message
  await sendMessage(conv.id, aId, {
    content: `${targetUser.full_name} was added to the chat`,
    messageType: 'SYSTEM'
  });

  return { success: true, message: `${targetUser.full_name} added successfully` };
}

/**
 * 11. Remove Member from Chat
 */
async function removeMember(conversationId, actorUserId, targetUserId) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  const aId = Number(actorUserId);
  const tId = Number(targetUserId);

  const actorParts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
    [conv.id, aId]
  );
  if (!actorParts || actorParts.length === 0 || (actorParts[0].role !== 'ADMIN' && actorParts[0].role !== 'OWNER')) {
    const err = new Error('Forbidden. Only group admins can remove members.');
    err.status = 403;
    throw err;
  }

  const targetParts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [conv.id, tId]
  );
  if (!targetParts || targetParts.length === 0) {
    const err = new Error('Target user is not a participant');
    err.status = 404;
    throw err;
  }

  if (targetParts[0].role === 'OWNER' && actorParts[0].role !== 'OWNER') {
    const err = new Error('Cannot remove group owner');
    err.status = 403;
    throw err;
  }

  await db.query(
    `UPDATE chat_participants SET left_at = NOW() WHERE conversation_id = ? AND user_id = ?`,
    [conv.id, tId]
  );

  const users = await db.query(`SELECT full_name FROM users WHERE id = ?`, [tId]);
  const tName = users.length > 0 ? users[0].full_name : 'Member';

  // System message
  await sendMessage(conv.id, aId, {
    content: `${tName} was removed from the chat`,
    messageType: 'SYSTEM'
  });

  return { success: true };
}

/**
 * 12. Promote / Demote Member Role
 */
async function updateMemberRole(conversationId, actorUserId, targetUserId, newRole) {
  const conv = await getConversationById(conversationId);
  if (!conv) {
    const err = new Error('Conversation not found');
    err.status = 404;
    throw err;
  }

  if (!['ADMIN', 'MEMBER'].includes(newRole)) {
    throw new Error('Invalid role specified');
  }

  const aId = Number(actorUserId);
  const tId = Number(targetUserId);

  const actorParts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL LIMIT 1`,
    [conv.id, aId]
  );
  if (!actorParts || actorParts.length === 0 || (actorParts[0].role !== 'ADMIN' && actorParts[0].role !== 'OWNER')) {
    const err = new Error('Forbidden. Only group admins can change roles.');
    err.status = 403;
    throw err;
  }

  await db.query(
    `UPDATE chat_participants SET role = ? WHERE conversation_id = ? AND user_id = ?`,
    [newRole, conv.id, tId]
  );

  const users = await db.query(`SELECT full_name FROM users WHERE id = ?`, [tId]);
  const tName = users.length > 0 ? users[0].full_name : 'Member';
  const roleLabel = newRole === 'ADMIN' ? 'Group Admin' : 'Member';

  await sendMessage(conv.id, aId, {
    content: `${tName} is now ${roleLabel === 'Group Admin' ? 'a Group Admin' : 'a Member'}`,
    messageType: 'SYSTEM'
  });

  return { success: true };
}

/**
 * 13. Delete Message
 */
async function deleteMessage(messageId, userId) {
  const mId = Number(messageId);
  const uId = Number(userId);

  const msgs = await db.query(`SELECT * FROM chat_messages WHERE id = ? LIMIT 1`, [mId]);
  if (!msgs || msgs.length === 0) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  const msg = msgs[0];

  // Allow if sender or group admin/owner
  const parts = await db.query(
    `SELECT role FROM chat_participants WHERE conversation_id = ? AND user_id = ? LIMIT 1`,
    [msg.conversation_id, uId]
  );
  const userRole = parts && parts.length > 0 ? parts[0].role : null;
  const isSender = Number(msg.sender_id) === uId;
  const isAdmin = userRole === 'ADMIN' || userRole === 'OWNER';

  if (!isSender && !isAdmin) {
    const err = new Error('Forbidden. Cannot delete this message.');
    err.status = 403;
    throw err;
  }

  await db.query(`UPDATE chat_messages SET is_deleted = 1, content = '' WHERE id = ?`, [mId]);

  const io = getSocketIO();
  if (io) {
    io.to(`chat:conversation:${msg.conversation_id}`).emit('chat:message_deleted', {
      messageId: mId,
      conversationId: msg.conversation_id
    });
  }

  return { success: true };
}

/**
 * 14. Edit Message
 */
async function editMessage(messageId, userId, newContent) {
  const mId = Number(messageId);
  const uId = Number(userId);

  const msgs = await db.query(`SELECT * FROM chat_messages WHERE id = ? LIMIT 1`, [mId]);
  if (!msgs || msgs.length === 0) {
    const err = new Error('Message not found');
    err.status = 404;
    throw err;
  }
  const msg = msgs[0];

  if (Number(msg.sender_id) !== uId) {
    const err = new Error('Forbidden. You can only edit your own messages.');
    err.status = 403;
    throw err;
  }

  await db.query(
    `UPDATE chat_messages SET content = ?, is_edited = 1 WHERE id = ?`,
    [newContent.trim(), mId]
  );

  const io = getSocketIO();
  if (io) {
    io.to(`chat:conversation:${msg.conversation_id}`).emit('chat:message_edited', {
      messageId: mId,
      conversationId: msg.conversation_id,
      content: newContent.trim(),
      isEdited: true
    });
  }

  return { success: true };
}

/**
 * 15. Search Users for Direct Chat
 */
async function searchUsers(query, currentUserId) {
  if (!query || query.trim().length === 0) return [];
  const term = `%${query.trim()}%`;
  const uId = Number(currentUserId);

  const rows = await db.query(
    `SELECT id, full_name, username, profile_photo, email, phone 
     FROM users 
     WHERE id != ? AND status = 'ACTIVE' AND deleted_at IS NULL
       AND (full_name LIKE ? OR username LIKE ? OR phone LIKE ? OR email LIKE ?)
     LIMIT 20`,
    [uId, term, term, term, term]
  );

  return rows.map(u => ({
    id: u.id,
    fullName: u.full_name,
    username: u.username,
    profilePhoto: u.profile_photo,
    phone: u.phone,
    email: u.email
  }));
}

/**
 * 16. Get Total Unread Count for User Badge
 */
async function getTotalUnreadCount(userId) {
  const uId = Number(userId);
  const rows = await db.query(
    `SELECT COALESCE(SUM(unread_count), 0) as total 
     FROM chat_participants 
     WHERE user_id = ? AND left_at IS NULL`,
    [uId]
  );
  return rows && rows.length > 0 ? Number(rows[0].total) : 0;
}

/**
 * 17. Register Push Token for Mobile Push Notifications
 */
async function registerPushToken(userId, { pushToken, platform = 'expo', deviceId = null }) {
  if (!userId || !pushToken) return { success: false };
  await db.query(
    `INSERT INTO chat_push_tokens (user_id, push_token, platform, device_id)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE push_token = VALUES(push_token), platform = VALUES(platform), updated_at = NOW()`,
    [Number(userId), pushToken, platform, deviceId || 'default']
  );
  return { success: true };
}

/**
 * 18. Backfill existing teams and tournaments into chat conversations
 */
async function backfillExistingGroups() {
  try {
    const teams = await db.query(`SELECT id FROM teams WHERE status = 'ACTIVE' LIMIT 200`);
    for (const t of teams) {
      await syncTeamGroup(t.id).catch(() => { });
    }

    const tournaments = await db.query(`SELECT id FROM tournaments WHERE status != 'CANCELLED' LIMIT 200`);
    for (const tr of tournaments) {
      await syncTournamentGroup(tr.id).catch(() => { });
    }
    console.log('✓ Chat System: Backfilled existing team & tournament groups.');
  } catch (err) {
    console.warn('Chat backfill error (non-fatal):', err.message);
  }
}

module.exports = {
  syncTeamGroup,
  syncTournamentGroup,
  getOrCreateDirectConversation,
  getConversationById,
  getUserConversations,
  getConversationDetails,
  getConversationMessages,
  sendMessage,
  markConversationAsRead,
  updateGroupSettings,
  addExternalMember,
  removeMember,
  updateMemberRole,
  deleteMessage,
  editMessage,
  searchUsers,
  getTotalUnreadCount,
  registerPushToken,
  backfillExistingGroups
};
