import { pool } from '../db.js';

class Chat {
  // Create or get existing chat between two users
  static async findOrCreate(user1_id, user2_id) {
    // First, try to find existing chat
    const findQuery = `
      SELECT * FROM chats 
      WHERE (user1_id = $1 AND user2_id = $2) 
         OR (user1_id = $2 AND user2_id = $1)
    `;
    const findResult = await pool.query(findQuery, [user1_id, user2_id]);

    if (findResult.rows.length > 0) {
      const existing = findResult.rows[0];

      // If chat was previously soft-deleted, reactivate it so it appears again
      // in recent chats when users continue the conversation.
      if (existing.is_active === false) {
        const reactivateQuery = `
          UPDATE chats
          SET is_active = TRUE
          WHERE chat_id = $1
          RETURNING *
        `;
        const reactivateResult = await pool.query(reactivateQuery, [existing.chat_id]);
        return reactivateResult.rows[0];
      }

      return existing;
    }

    // Create new chat if doesn't exist
    const createQuery = `
      INSERT INTO chats (user1_id, user2_id)
      VALUES ($1, $2)
      RETURNING *
    `;
    const createResult = await pool.query(createQuery, [user1_id, user2_id]);
    return createResult.rows[0];
  }

  // Get chat by ID
  static async findById(chat_id) {
    const query = 'SELECT * FROM chats WHERE chat_id = $1';
    const result = await pool.query(query, [chat_id]);
    return result.rows[0];
  }

  // Get user's all chats
  static async getUserChats(user_id) {
    const query = `
      SELECT c.*, 
             CASE 
               WHEN c.user1_id = $1 THEN COALESCE(l2.professional_name, u2.display_name)
               ELSE COALESCE(l1.professional_name, u1.display_name)
             END as other_user_name,
             CASE 
               WHEN c.user1_id = $1 THEN COALESCE(l2.profile_image, u2.avatar_url)
               ELSE COALESCE(l1.profile_image, u1.avatar_url)
             END as other_user_avatar,
             CASE 
               WHEN c.user1_id = $1 THEN c.user2_id
               ELSE c.user1_id
             END as other_user_id,
             (SELECT COUNT(*) FROM messages 
              WHERE chat_id = c.chat_id 
                AND sender_id != $1 
                AND is_read = FALSE) as unread_count
      FROM chats c
      JOIN users u1 ON c.user1_id = u1.user_id
      JOIN users u2 ON c.user2_id = u2.user_id
      LEFT JOIN listeners l1 ON c.user1_id = l1.user_id
      LEFT JOIN listeners l2 ON c.user2_id = l2.user_id
      WHERE (c.user1_id = $1 OR c.user2_id = $1)
        AND (
          COALESCE(c.is_active, TRUE) = TRUE
          OR c.last_message IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM messages m2
            WHERE m2.chat_id = c.chat_id
          )
        )
        -- Hide chats with pending listeners
        AND CASE 
              WHEN c.user1_id != $1 AND l1.listener_id IS NOT NULL THEN COALESCE(l1.verification_status, 'approved') = 'approved'
              WHEN c.user2_id != $1 AND l2.listener_id IS NOT NULL THEN COALESCE(l2.verification_status, 'approved') = 'approved'
              ELSE TRUE
            END
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
    `;
    const result = await pool.query(query, [user_id]);
    return result.rows;
  }

  // Update last message
  static async updateLastMessage(chat_id, message_content) {
    const query = `
      UPDATE chats 
      SET last_message = $1, last_message_at = CURRENT_TIMESTAMP
      WHERE chat_id = $2
      RETURNING *
    `;
    const result = await pool.query(query, [message_content, chat_id]);
    return result.rows[0];
  }

  // Delete/deactivate chat
  static async deactivate(chat_id) {
    const query = 'UPDATE chats SET is_active = FALSE WHERE chat_id = $1';
    await pool.query(query, [chat_id]);
  }

  // Clear chat messages while keeping chat relationship intact
  static async clearMessages(chat_id) {
    await pool.query('DELETE FROM messages WHERE chat_id = $1', [chat_id]);
    const query = `
      UPDATE chats
      SET last_message = NULL,
          last_message_at = NULL,
          is_active = TRUE
      WHERE chat_id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [chat_id]);
    return result.rows[0];
  }
}

class Message {
  // Send a message
  static async create(messageData) {
    const {
      chat_id,
      sender_id,
      message_type = 'text',
      message_content,
      media_url = null
    } = messageData;

    const query = `
      INSERT INTO messages (chat_id, sender_id, message_type, message_content, media_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;

    const values = [chat_id, sender_id, message_type, message_content, media_url];
    const result = await pool.query(query, values);

    // Update last message in chat
    await Chat.updateLastMessage(chat_id, message_content);

    return result.rows[0];
  }

  // Get messages for a chat
  static async getChatMessages(chat_id, limit = 50, offset = 0) {
    const query = `
      SELECT m.*, 
             COALESCE(l.professional_name, u.display_name) as sender_name, 
             COALESCE(l.profile_image, u.avatar_url) as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.user_id
      LEFT JOIN listeners l ON m.sender_id = l.user_id
      WHERE m.chat_id = $1
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [chat_id, limit, offset]);
    return result.rows.reverse(); // Return in chronological order
  }

  // Mark messages as read
  static async markAsRead(chat_id, user_id) {
    const query = `
      UPDATE messages 
      SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
      WHERE chat_id = $1 
        AND sender_id != $2 
        AND is_read = FALSE
      RETURNING message_id
    `;
    const result = await pool.query(query, [chat_id, user_id]);
    return result.rows;
  }

  // Get unread message count
  static async getUnreadCount(user_id) {
    const query = `
      SELECT COUNT(*) as unread_count
      FROM messages m
      JOIN chats c ON m.chat_id = c.chat_id
      WHERE (c.user1_id = $1 OR c.user2_id = $1)
        AND m.sender_id != $1
        AND m.is_read = FALSE
    `;
    const result = await pool.query(query, [user_id]);
    return result.rows[0].unread_count;
  }

  // Delete a message permanently (WhatsApp-style delete for everyone)
  // Backend never stores placeholder text - that's handled client-side only
  static async delete(messageId, senderId) {
    // First verify the sender owns this message
    const verifyQuery = `SELECT sender_id, chat_id FROM messages WHERE message_id = $1`;
    const verifyResult = await pool.query(verifyQuery, [messageId]);

    if (verifyResult.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const message = verifyResult.rows[0];
    if (message.sender_id !== senderId) {
      return { success: false, error: 'Not authorized to delete this message' };
    }

    // Permanently delete the message
    const deleteQuery = `DELETE FROM messages WHERE message_id = $1 RETURNING *`;
    const deleteResult = await pool.query(deleteQuery, [messageId]);

    return {
      success: true,
      deletedMessage: deleteResult.rows[0],
      chatId: message.chat_id
    };
  }
}

export { Chat, Message };
