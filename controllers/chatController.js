const chatService = require('../services/chatService');
const brandingService = require('../services/brandingService');

// GET /api/chat/conversations
async function getConversations(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const conversations = await chatService.getUserConversations(userId);
    res.json({ success: true, data: { items: conversations } });
  } catch (error) {
    console.warn('[chatController.getConversations] Fallback returning empty list:', error.message);
    res.json({ success: true, data: { items: [] } });
  }
}

// GET /api/chat/unread-count
async function getTotalUnread(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const totalUnread = await chatService.getTotalUnreadCount(userId);
    res.json({ success: true, data: { totalUnread } });
  } catch (error) {
    console.warn('[chatController.getTotalUnread] Fallback returning 0 unread:', error.message);
    res.json({ success: true, data: { totalUnread: 0 } });
  }
}

// GET /api/chat/conversations/:id
async function getConversationDetails(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const conversation = await chatService.getConversationDetails(id, userId);
    res.json({ success: true, data: conversation });
  } catch (error) {
    next(error);
  }
}

// GET /api/chat/conversations/:id/messages
async function getMessages(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { cursor, limit } = req.query;
    const result = await chatService.getConversationMessages(id, userId, { cursor, limit });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
}

// POST /api/chat/conversations/:id/messages
async function sendMessage(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { content, messageType = 'TEXT', replyToMessageId } = req.body;

    // Attachments uploaded via multer
    const attachments = [];
    if (req.files && Array.isArray(req.files) && req.files.length > 0) {
      const branding = await brandingService.getBranding();
      if (branding.showChatImageUpload === false) {
        return res.status(403).json({
          success: false,
          message: 'Image uploads in chat are currently disabled by the Super Administrator.',
          code: 'CHAT_ATTACHMENTS_DISABLED'
        });
      }
      for (const f of req.files) {
        attachments.push({
          fileUrl: `/uploads/${f.filename}`,
          fileName: f.originalname,
          fileType: f.mimetype,
          fileSize: f.size
        });
      }
    }

    const effectiveType = attachments.length > 0 ? 'IMAGE' : (messageType || 'TEXT');

    const message = await chatService.sendMessage(id, userId, {
      content: content || '',
      messageType: effectiveType,
      replyToMessageId: replyToMessageId ? Number(replyToMessageId) : null,
      attachments
    });

    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (error.code === 'ADMINS_ONLY_RESTRICTION') {
      return res.status(403).json({
        success: false,
        message: 'Only group admins can send messages in this group.',
        code: 'ADMINS_ONLY_RESTRICTION'
      });
    }
    next(error);
  }
}

// POST /api/chat/conversations/:id/read
async function markAsRead(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { messageId } = req.body;
    await chatService.markConversationAsRead(id, userId, messageId);
    res.json({ success: true, message: 'Marked as read' });
  } catch (error) {
    next(error);
  }
}

// POST /api/chat/direct
async function getOrCreateDirectChat(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    const targetUserId = req.body?.targetUserId || req.body?.userId || req.body?.target_id || req.body?.id;
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'targetUserId is required' });
    }
    const conversation = await chatService.getOrCreateDirectConversation(userId, targetUserId);
    res.json({ success: true, data: conversation });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
}

// GET /api/chat/team/:teamId
async function getTeamChat(req, res, next) {
  try {
    const { teamId } = req.params;
    const conversation = await chatService.syncTeamGroup(teamId);
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Team or chat not found' });
    }
    res.json({ success: true, data: conversation });
  } catch (error) {
    next(error);
  }
}

// GET /api/chat/tournament/:tournamentId
async function getTournamentChat(req, res, next) {
  try {
    const { tournamentId } = req.params;
    const conversation = await chatService.syncTournamentGroup(tournamentId);
    if (!conversation) {
      return res.status(404).json({ success: false, message: 'Tournament or chat not found' });
    }
    res.json({ success: true, data: conversation });
  } catch (error) {
    next(error);
  }
}

// PATCH /api/chat/conversations/:id/settings
async function updateGroupSettings(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { messagingPermission, title, imageUrl } = req.body;
    const updated = await chatService.updateGroupSettings(id, userId, {
      messagingPermission,
      title,
      imageUrl
    });
    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
}

// POST /api/chat/conversations/:id/members
async function addMember(req, res, next) {
  try {
    const userId = req.user.id;
    const { id } = req.params;
    const { targetUserId } = req.body;
    const result = await chatService.addExternalMember(id, userId, targetUserId);
    res.json({ success: true, message: result.message });
  } catch (error) {
    next(error);
  }
}

// DELETE /api/chat/conversations/:id/members/:targetUserId
async function removeMember(req, res, next) {
  try {
    const userId = req.user.id;
    const { id, targetUserId } = req.params;
    await chatService.removeMember(id, userId, targetUserId);
    res.json({ success: true, message: 'Member removed from chat' });
  } catch (error) {
    next(error);
  }
}

// PATCH /api/chat/conversations/:id/members/:targetUserId/role
async function updateMemberRole(req, res, next) {
  try {
    const userId = req.user.id;
    const { id, targetUserId } = req.params;
    const { role } = req.body;
    await chatService.updateMemberRole(id, userId, targetUserId, role);
    res.json({ success: true, message: 'Member role updated' });
  } catch (error) {
    next(error);
  }
}

// DELETE /api/chat/messages/:messageId
async function deleteMessage(req, res, next) {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    await chatService.deleteMessage(messageId, userId);
    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    next(error);
  }
}

// PATCH /api/chat/messages/:messageId
async function editMessage(req, res, next) {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ success: false, message: 'Message content cannot be empty' });
    }
    await chatService.editMessage(messageId, userId, content);
    res.json({ success: true, message: 'Message edited' });
  } catch (error) {
    next(error);
  }
}

// GET /api/chat/users/search
async function searchUsers(req, res, next) {
  try {
    const userId = req.user.id;
    const { q } = req.query;
    const users = await chatService.searchUsers(q, userId);
    res.json({ success: true, data: { items: users } });
  } catch (error) {
    next(error);
  }
}

// POST /api/chat/push-token
async function registerPushToken(req, res, next) {
  try {
    const userId = req.user.id;
    const { pushToken, platform, deviceId } = req.body;
    await chatService.registerPushToken(userId, { pushToken, platform, deviceId });
    res.json({ success: true, message: 'Push token registered successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getConversations,
  getTotalUnread,
  getConversationDetails,
  getMessages,
  sendMessage,
  markAsRead,
  getOrCreateDirectChat,
  getTeamChat,
  getTournamentChat,
  updateGroupSettings,
  addMember,
  removeMember,
  updateMemberRole,
  deleteMessage,
  editMessage,
  searchUsers,
  registerPushToken
};

