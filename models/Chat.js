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
                AND is_read = FALSE
                AND COALESCE(is_deleted_for_everyone, FALSE) = FALSE
                AND NOT ($1::uuid = ANY(COALESCE(deleted_for, '{}')))) as unread_count
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

  static async refreshLastMessage(chat_id) {
    const query = `
      UPDATE chats
      SET last_message = latest.message_content,
          last_message_at = latest.created_at
      FROM (
        SELECT message_content, created_at
        FROM messages
        WHERE chat_id = $1
        ORDER BY created_at DESC
        LIMIT 1
      ) latest
      WHERE chats.chat_id = $1
      RETURNING chats.*
    `;
    const result = await pool.query(query, [chat_id]);
    if (result.rows.length > 0) {
      return result.rows[0];
    }

    const clearQuery = `
      UPDATE chats
      SET last_message = NULL, last_message_at = NULL
      WHERE chat_id = $1
      RETURNING *
    `;
    const clearResult = await pool.query(clearQuery, [chat_id]);
    return clearResult.rows[0];
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
      media_url = null,
      file_url = null,
      file_key = null,
      file_name = null,
      file_type = null,
      file_size = null,
      uploaded_at = null,
      receiver_id = null
    } = messageData;

    // Try inserting with status column; fall back gracefully if column doesn't exist yet
    let result;
    try {
      const query = `
        INSERT INTO messages (
          chat_id, sender_id, receiver_id, message_type, message_content,
          media_url, file_url, file_key, file_name, file_type, file_size, uploaded_at, status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, CURRENT_TIMESTAMP), 'sent')
        RETURNING *
      `;
      result = await pool.query(query, [
        chat_id,
        sender_id,
        receiver_id,
        message_type,
        message_content,
        media_url,
        file_url,
        file_key,
        file_name,
        file_type,
        file_size,
        uploaded_at,
      ]);
    } catch (err) {
      if (err.code === '42703') {
        // 'status' column does not exist yet — fall back to old schema
        const query = `
          INSERT INTO messages (chat_id, sender_id, message_type, message_content, media_url)
          VALUES ($1, $2, $3, $4, $5)
          RETURNING *
        `;
        result = await pool.query(query, [chat_id, sender_id, message_type, message_content, media_url]);
      } else {
        throw err;
      }
    }

    // Update last message in chat
    await Chat.updateLastMessage(chat_id, message_content);

    return result.rows[0];
  }

  static async markDelivered(messageId) {
    try {
      const query = `
        UPDATE messages
        SET status = 'delivered'
        WHERE message_id = $1
          AND COALESCE(is_read, FALSE) = FALSE
          AND COALESCE(status, 'sent') = 'sent'
        RETURNING message_id, sender_id
      `;
      const result = await pool.query(query, [messageId]);
      return result.rows[0] || null;
    } catch (err) {
      if (err.code === '42703') {
        return null;
      }
      throw err;
    }
  }

  // Get messages for a chat
  static normalizeDeletedMessage(message) {
    if (!message || message.is_deleted_for_everyone !== true) {
      return message;
    }

    return {
      ...message,
      message_type: 'text',
      message_content: 'This message was deleted',
      media_url: null,
      file_url: null,
      file_key: null,
      file_name: null,
      file_type: null,
      file_size: null,
      uploaded_at: null,
    };
  }

  static async getChatMessages(chat_id, limit = 50, offset = 0, viewer_id = null) {
    const params = [chat_id, limit, offset];
    let deletedForFilter = '';
    if (viewer_id) {
      params.push(viewer_id);
      deletedForFilter = `AND NOT ($4::uuid = ANY(COALESCE(m.deleted_for, '{}')))`;
    }

    const query = `
      SELECT m.*, 
             COALESCE(l.professional_name, u.display_name) as sender_name, 
             COALESCE(l.profile_image, u.avatar_url) as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.user_id
      LEFT JOIN listeners l ON m.sender_id = l.user_id
      WHERE m.chat_id = $1
        ${deletedForFilter}
      ORDER BY m.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, params);
    return result.rows.reverse().map(Message.normalizeDeletedMessage); // Return in chronological order
  }

  // Mark messages as read (seen) — returns {messageId, senderId} pairs so the
  // backend can notify each original sender via message_status_updated.
  static async markAsRead(chat_id, user_id) {
    // Try with status column first; fall back if column missing
    try {
      const query = `
        UPDATE messages
        SET is_read = TRUE, read_at = CURRENT_TIMESTAMP, status = 'seen'
        WHERE chat_id = $1
          AND sender_id != $2
          AND is_read = FALSE
          AND COALESCE(is_deleted_for_everyone, FALSE) = FALSE
          AND NOT ($2::uuid = ANY(COALESCE(deleted_for, '{}')))
        RETURNING message_id, sender_id
      `;
      const result = await pool.query(query, [chat_id, user_id]);
      return result.rows; // [{message_id, sender_id}, ...]
    } catch (err) {
      if (err.code === '42703') {
        // status column doesn't exist — use old schema
        const query = `
          UPDATE messages
          SET is_read = TRUE, read_at = CURRENT_TIMESTAMP
          WHERE chat_id = $1
            AND sender_id != $2
            AND is_read = FALSE
            AND NOT ($2::uuid = ANY(COALESCE(deleted_for, '{}')))
          RETURNING message_id, sender_id
        `;
        const result = await pool.query(query, [chat_id, user_id]);
        return result.rows;
      }
      throw err;
    }
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
        AND COALESCE(m.is_deleted_for_everyone, FALSE) = FALSE
        AND NOT ($1::uuid = ANY(COALESCE(m.deleted_for, '{}')))
    `;
    const result = await pool.query(query, [user_id]);
    return result.rows[0].unread_count;
  }

  static async deleteForMe(messageId, userId, chatId = null) {
    const verifyQuery = `
      SELECT m.message_id, m.chat_id, c.user1_id, c.user2_id
      FROM messages m
      JOIN chats c ON c.chat_id = m.chat_id
      WHERE m.message_id = $1
    `;
    const verifyResult = await pool.query(verifyQuery, [messageId]);

    if (verifyResult.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const message = verifyResult.rows[0];
    if (chatId && String(message.chat_id) !== String(chatId)) {
      return { success: false, error: 'Message not found in this chat' };
    }
    if (message.user1_id !== userId && message.user2_id !== userId) {
      return { success: false, error: 'Forbidden' };
    }

    const query = `
      UPDATE messages
      SET deleted_for = CASE
        WHEN $2::uuid = ANY(COALESCE(deleted_for, '{}')) THEN deleted_for
        ELSE array_append(COALESCE(deleted_for, '{}'), $2::uuid)
      END
      WHERE message_id = $1
      RETURNING *
    `;
    const result = await pool.query(query, [messageId, userId]);

    return {
      success: true,
      message: result.rows[0],
      chatId: message.chat_id,
    };
  }

  static async deleteForEveryone(messageId, senderId, chatId = null) {
    const verifyQuery = `
      SELECT m.*, c.user1_id, c.user2_id
      FROM messages m
      JOIN chats c ON c.chat_id = m.chat_id
      WHERE m.message_id = $1
    `;
    const verifyResult = await pool.query(verifyQuery, [messageId]);

    if (verifyResult.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const message = verifyResult.rows[0];
    if (chatId && String(message.chat_id) !== String(chatId)) {
      return { success: false, error: 'Message not found in this chat' };
    }
    if (message.sender_id !== senderId) {
      return { success: false, error: 'Not authorized to delete this message' };
    }

    const updateQuery = `
      UPDATE messages
      SET is_deleted_for_everyone = TRUE,
          deleted_at = CURRENT_TIMESTAMP,
          deleted_by = $2,
          message_type = 'text',
          message_content = 'This message was deleted',
          media_url = NULL,
          file_url = NULL,
          file_key = NULL,
          file_name = NULL,
          file_type = NULL,
          file_size = NULL,
          uploaded_at = NULL,
          is_read = TRUE,
          status = 'seen'
      WHERE message_id = $1
      RETURNING *
    `;
    const updateResult = await pool.query(updateQuery, [messageId, senderId]);
    await Chat.refreshLastMessage(message.chat_id);

    return {
      success: true,
      deletedMessage: Message.normalizeDeletedMessage(updateResult.rows[0]),
      originalMessage: message,
      chatId: message.chat_id,
      receiverId: message.user1_id === senderId ? message.user2_id : message.user1_id,
    };
  }

  static async hardDelete(messageId, senderId) {
    const verifyQuery = `SELECT sender_id, chat_id FROM messages WHERE message_id = $1`;
    const verifyResult = await pool.query(verifyQuery, [messageId]);

    if (verifyResult.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }

    const message = verifyResult.rows[0];
    if (message.sender_id !== senderId) {
      return { success: false, error: 'Not authorized to delete this message' };
    }

    const deleteQuery = `DELETE FROM messages WHERE message_id = $1 RETURNING *`;
    const deleteResult = await pool.query(deleteQuery, [messageId]);
    await Chat.refreshLastMessage(message.chat_id);

    return {
      success: true,
      deletedMessage: deleteResult.rows[0],
      chatId: message.chat_id
    };
  }
}

export { Chat, Message };
