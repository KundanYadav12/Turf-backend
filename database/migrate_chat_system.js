const db = require('../config/database');

async function migrate() {
  console.log('--- Migrating WhatsApp-Style Chat System Tables ---');

  try {
    // 1. Table: chat_conversations
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(36) UNIQUE NOT NULL,
        type ENUM('DIRECT', 'TEAM', 'TOURNAMENT') NOT NULL,
        title VARCHAR(150) NULL,
        image_url VARCHAR(255) NULL,
        team_id INT NULL,
        tournament_id INT NULL,
        created_by INT NULL,
        messaging_permission ENUM('EVERYONE', 'ADMINS_ONLY') DEFAULT 'EVERYONE',
        direct_user_pair VARCHAR(50) NULL,
        last_message_id INT NULL,
        last_message_preview VARCHAR(255) NULL,
        last_message_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_chat_team (team_id),
        UNIQUE KEY uk_chat_tournament (tournament_id),
        UNIQUE KEY uk_chat_direct_pair (direct_user_pair),
        INDEX idx_chat_type (type),
        INDEX idx_chat_last_msg (last_message_at),
        INDEX idx_chat_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_conversations table');

    // 2. Table: chat_participants
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_participants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        conversation_id INT NOT NULL,
        user_id INT NOT NULL,
        role ENUM('MEMBER', 'ADMIN', 'OWNER') DEFAULT 'MEMBER',
        is_external TINYINT(1) DEFAULT 0,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        left_at DATETIME NULL,
        is_muted TINYINT(1) DEFAULT 0,
        last_read_message_id INT NULL,
        last_read_at DATETIME NULL,
        unread_count INT DEFAULT 0,
        UNIQUE KEY uk_chat_conv_user (conversation_id, user_id),
        INDEX idx_chat_part_user (user_id, left_at),
        INDEX idx_chat_part_conv (conversation_id, left_at),
        INDEX idx_chat_unread (user_id, unread_count)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_participants table');

    // 3. Table: chat_messages
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        uuid VARCHAR(36) UNIQUE NOT NULL,
        conversation_id INT NOT NULL,
        sender_id INT NOT NULL,
        message_type ENUM('TEXT', 'IMAGE', 'SYSTEM') DEFAULT 'TEXT',
        content TEXT NULL,
        reply_to_message_id INT NULL,
        is_edited TINYINT(1) DEFAULT 0,
        is_deleted TINYINT(1) DEFAULT 0,
        deleted_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chat_msg_conv_time (conversation_id, created_at),
        INDEX idx_chat_msg_sender (sender_id),
        INDEX idx_chat_msg_reply (reply_to_message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_messages table');

    // 4. Table: chat_message_attachments
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_message_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id INT NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        file_name VARCHAR(150) NULL,
        file_type VARCHAR(50) DEFAULT 'image/jpeg',
        file_size INT UNSIGNED NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chat_att_msg (message_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_message_attachments table');

    // 5. Table: chat_read_receipts
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_read_receipts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id INT NOT NULL,
        user_id INT NOT NULL,
        read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_receipt_msg_user (message_id, user_id),
        INDEX idx_receipt_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_read_receipts table');

    // 6. Table: chat_push_tokens
    await db.query(`
      CREATE TABLE IF NOT EXISTS chat_push_tokens (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        push_token VARCHAR(255) NOT NULL,
        platform VARCHAR(20) DEFAULT 'expo',
        device_id VARCHAR(100) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_device (user_id, device_id),
        INDEX idx_user_token (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    console.log('✓ Created chat_push_tokens table');

    console.log('--- Chat System Migration Completed Successfully ---');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

if (require.main === module) {
  migrate().then(() => {
    db.close();
    process.exit(0);
  }).catch((err) => {
    console.error(err);
    db.close();
    process.exit(1);
  });
}

module.exports = migrate;

