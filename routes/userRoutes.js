const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { authenticateUser, optionalAuthenticateUser } = require('../middleware/authMiddleware');
const upload = require('../middleware/multerMiddleware');

// 1. Check Username Availability & Suggestions (Public / Authenticated)
router.get('/check-username', optionalAuthenticateUser, userController.checkUsername);

// 2. Search Registered Users / Players (Public / Authenticated)
router.get('/search', optionalAuthenticateUser, userController.searchUsers);

// 3. Upload & Compress Profile Photo (Protected: Self)
router.post('/profile-photo', authenticateUser, upload.single('photo'), userController.uploadProfilePhoto);

// 4. Remove Profile Photo (Protected: Self)
router.delete('/profile-photo', authenticateUser, userController.removeProfilePhoto);

// 5. Update Profile Details (Protected: Self)
router.put('/profile', authenticateUser, userController.updateProfile);

// 6. Notifications Hub (Protected: Self)
router.get('/notifications', authenticateUser, userController.getNotifications);
router.put('/notifications/:id/read', authenticateUser, userController.markNotificationRead);
// 7. Account Self-Deletion & Status (Protected: Self)
const accountDeletionController = require('../controllers/accountDeletionController');
router.post('/me/delete-request', authenticateUser, accountDeletionController.requestSelfDeletion);
router.get('/me/deletion-status', authenticateUser, accountDeletionController.getSelfDeletionStatus);

module.exports = router;
