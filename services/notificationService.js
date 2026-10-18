const db = require('../config/database');
const { getIO } = require('./socketService');

/**
 * Parses @mentions from text, resolves them to registered user IDs,
 * saves them in match_mentions, and notifies tagged users.
 */
async function processCommentaryMentions({
  matchId,
  matchPublicId = null,
  matchTitle = 'Live Match',
  authorId = null,
  authorName = 'Scorer',
  authorPhoto = null,
  commentaryText = ''
}) {
  if (!commentaryText || typeof commentaryText !== 'string') {
    return { mentions: [], notifiedCount: 0 };
  }

  // Find all @mentions (e.g. @rahul_sharma)
  const mentionMatches = commentaryText.match(/@([a-zA-Z0-9_]{3,30})/g);
  if (!mentionMatches || mentionMatches.length === 0) {
    return { mentions: [], notifiedCount: 0 };
  }

  // Extract unique normalized usernames
  const uniqueUsernames = Array.from(
    new Set(mentionMatches.map(m => m.slice(1).toLowerCase()))
  );

  if (uniqueUsernames.length === 0) {
    return { mentions: [], notifiedCount: 0 };
  }

  // Lookup users
  const placeholders = uniqueUsernames.map(() => '?').join(',');
  const users = await db.query(
    `SELECT id, username, full_name, profile_photo FROM users WHERE LOWER(username) IN (${placeholders})`,
    uniqueUsernames
  );

  const resolvedMentions = [];
  let notifiedCount = 0;

  for (const user of users) {
    // Avoid notifying the author if they tag themselves
    const isSelf = authorId && parseInt(authorId, 10) === parseInt(user.id, 10);

    // Record structured mention
    await db.query(
      `INSERT INTO match_mentions (match_id, author_id, mentioned_user_id, commentary_text) 
       VALUES (?, ?, ?, ?)`,
      [matchId, authorId || null, user.id, commentaryText]
    );

    resolvedMentions.push({
      userId: user.id,
      username: user.username,
      fullName: user.full_name
    });

    if (!isSelf) {
      // Create notification
      const notifTitle = 'You were mentioned in match commentary';
      const cleanSnippet = commentaryText.length > 90 ? `${commentaryText.slice(0, 90)}…` : commentaryText;
      const notifMessage = `${authorName} tagged you in ${matchTitle}: "${cleanSnippet}"`;
      const actionUrl = `/matches/${matchPublicId || matchId}`;
      const metadata = JSON.stringify({
        matchId,
        matchPublicId: matchPublicId || String(matchId),
        matchTitle,
        authorId,
        authorName,
        authorPhoto,
        commentaryText: cleanSnippet
      });

      const notifResult = await db.query(
        `INSERT INTO notifications (user_id, title, message, type, metadata, action_url)
         VALUES (?, ?, ?, 'COMMENTARY_TAG', ?, ?)`,
        [user.id, notifTitle, notifMessage, metadata, actionUrl]
      );

      notifiedCount++;

      // Real-time notification broadcast via Socket.IO
      try {
        const io = getIO();
        if (io) {
          const payload = {
            id: notifResult.insertId,
            userId: user.id,
            title: notifTitle,
            message: notifMessage,
            type: 'COMMENTARY_TAG',
            actionUrl,
            metadata: JSON.parse(metadata),
            createdAt: new Date().toISOString()
          };
          io.to(`user:${user.id}`).emit('notification:new', payload);
        }
      } catch (err) {
        console.warn('[Socket Notification error]:', err.message);
      }
    }
  }

  return {
    mentions: resolvedMentions,
    notifiedCount
  };
}

/**
 * Get paginated notifications for an authenticated user.
 */
async function getUserNotifications(userId, { limit = 20, offset = 0, unreadOnly = false } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  let sql = 'SELECT * FROM notifications WHERE user_id = ?';
  const params = [userId];

  if (unreadOnly) {
    sql += ' AND is_read = 0';
  }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(safeLimit, safeOffset);

  const rows = await db.query(sql, params);

  const unreadRows = await db.query(
    'SELECT COUNT(id) as count FROM notifications WHERE user_id = ? AND is_read = 0',
    [userId]
  );
  const unreadCount = unreadRows[0]?.count || 0;

  const items = rows.map(r => {
    let metadata = {};
    try {
      metadata = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
    } catch {
      metadata = {};
    }
    return {
      id: r.id,
      title: r.title,
      message: r.message,
      type: r.type,
      isRead: Boolean(r.is_read),
      actionUrl: r.action_url || `/matches/${metadata.matchPublicId || metadata.matchId || ''}`,
      metadata,
      createdAt: r.created_at
    };
  });

  return {
    items,
    notifications: items,
    unreadCount,
    limit: safeLimit,
    offset: safeOffset
  };
}

/**
 * Mark a single notification as read.
 */
async function markNotificationAsRead(notificationId, userId) {
  await db.query(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
    [notificationId, userId]
  );
  return { success: true };
}

/**
 * Mark all notifications as read for a user.
 */
async function markAllNotificationsAsRead(userId) {
  await db.query(
    'UPDATE notifications SET is_read = 1 WHERE user_id = ?',
    [userId]
  );
  return { success: true };
}

module.exports = {
  processCommentaryMentions,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead
};
