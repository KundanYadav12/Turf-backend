const express = require('express');
const router = express.Router();
const upload = require('../middleware/multerMiddleware');
const { authenticateUser } = require('../middleware/authMiddleware');
const chatController = require('../controllers/chatController');

// All chat routes require authentication
router.use(authenticateUser);

// User conversations & unread count
router.get('/conversations', chatController.getConversations);
router.get('/unread-count', chatController.getTotalUnread);

// Direct 1-on-1 chat initialization/retrieval
router.post('/direct', chatController.getOrCreateDirectChat);

// Search users for new 1-on-1 chats
router.get('/users/search', chatController.searchUsers);

// Push token registration (for mobile push notifications)
router.post('/push-token', chatController.registerPushToken);

// Group chat shortcuts by team and tournament
router.get('/team/:teamId', chatController.getTeamChat);
router.get('/tournament/:tournamentId', chatController.getTournamentChat);

// Conversation details, settings, and participants
router.get('/conversations/:id', chatController.getConversationDetails);
router.patch('/conversations/:id/settings', chatController.updateGroupSettings);
router.post('/conversations/:id/members', chatController.addMember);
router.delete('/conversations/:id/members/:targetUserId', chatController.removeMember);
router.patch('/conversations/:id/members/:targetUserId/role', chatController.updateMemberRole);

// Conversation messages & read receipts
router.get('/conversations/:id/messages', chatController.getMessages);
router.post('/conversations/:id/messages', upload.array('attachments', 10), chatController.sendMessage);
router.post('/conversations/:id/read', chatController.markAsRead);

// Message actions (edit & delete)
router.patch('/messages/:messageId', chatController.editMessage);
router.delete('/messages/:messageId', chatController.deleteMessage);

module.exports = router;

