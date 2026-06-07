import express from 'express';
import multer from 'multer';
import { Chat, Message } from '../models/Chat.js';
import ChatChargeConfig from '../models/ChatChargeConfig.js';
import { authenticate } from '../middleware/auth.js';
import { deleteFromMinioByUrl, uploadToMinio } from '../utils/minioUpload.js';
import { pool } from '../db.js';

const CHAT_FILE_HARD_MAX_BYTES = 5 * 1024 * 1024;
const configuredChatFileMaxBytes = Number(
  process.env.CHAT_FILE_MAX_BYTES || CHAT_FILE_HARD_MAX_BYTES
);
const CHAT_FILE_MAX_BYTES =
  Number.isFinite(configuredChatFileMaxBytes) && configuredChatFileMaxBytes > 0
    ? Math.min(configuredChatFileMaxBytes, CHAT_FILE_HARD_MAX_BYTES)
    : CHAT_FILE_HARD_MAX_BYTES;

const defaultAllowedMimeTypes = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
];

const allowedMimeTypes = new Set(
  (process.env.CHAT_FILE_ALLOWED_MIME_TYPES || defaultAllowedMimeTypes.join(','))
    .split(',')
    .map((type) => type.trim().toLowerCase())
    .filter((type) => defaultAllowedMimeTypes.includes(type))
    .filter(Boolean)
);

const chatFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_FILE_MAX_BYTES, files: 1 },
});

function handleChatFileUpload(req, res, next) {
  chatFileUpload.single('file')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({
        error: `File is too large. Maximum size is ${Math.round(CHAT_FILE_MAX_BYTES / (1024 * 1024))} MB.`,
        code: 'FILE_TOO_LARGE',
      });
      return;
    }

    res.status(400).json({
      error: error.message || 'Invalid file upload.',
      code: error.code || 'INVALID_FILE_UPLOAD',
    });
  });
}

function normalizeMessage(message) {
  if (!message) return message;
  return {
    ...message,
    file_url: message.file_url || message.media_url || null,
    file_key: message.file_key || null,
    uploaded_at: message.uploaded_at instanceof Date
      ? message.uploaded_at.toISOString()
      : message.uploaded_at,
    created_at: message.created_at instanceof Date
      ? message.created_at.toISOString()
      : message.created_at,
    read_at: message.read_at instanceof Date ? message.read_at.toISOString() : message.read_at,
  };
}

function resolveMessageType(mimeType) {
  const type = String(mimeType || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}

async function getSenderInfo(userId) {
  try {
    const senderInfoResult = await pool.query(
      `SELECT COALESCE(l.professional_name, u.display_name) as sender_name,
              COALESCE(l.profile_image, u.avatar_url) as sender_avatar
       FROM users u
       LEFT JOIN listeners l ON u.user_id = l.user_id
       WHERE u.user_id = $1`,
      [userId]
    );
    return senderInfoResult.rows[0] || {};
  } catch (error) {
    console.error('[CHATS] Sender info lookup failed:', error.message);
    return {};
  }
}

function emitDeliveredIfOnline(io, otherUserId, message, chatId) {
  if (!io || !otherUserId || !message?.message_id) return;
  const sockets = io.sockets.adapter.rooms.get(`user_${otherUserId}`);
  if (!sockets || sockets.size === 0) return;

  Message.markDelivered(message.message_id)
    .then((updated) => {
      if (!updated?.sender_id) return;
      io.to(`user_${updated.sender_id}`).emit('message_status_updated', {
        chatId,
        messageIds: [updated.message_id],
        status: 'delivered',
        deliveredTo: otherUserId,
      });
    })
    .catch((error) => console.error('[CHATS] markDelivered error:', error.message));
}

// Factory function that creates router with socket.io instance
export default function createChatsRouter(io) {
  const router = express.Router();

  // GET /api/chats
  // Get all chats for current user
  router.get('/', authenticate, async (req, res) => {
    try {
      const chats = await Chat.getUserChats(req.userId);

      res.json({
        chats,
        count: chats.length
      });
    } catch (error) {
      console.error('Get chats error:', error);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  });

// POST /api/chats
// Create or get chat with another user
router.post('/', authenticate, async (req, res) => {
  try {
    const { other_user_id } = req.body;

    if (!other_user_id) {
      return res.status(400).json({ error: 'other_user_id is required' });
    }

    if (other_user_id === req.userId) {
      return res.status(400).json({ error: 'Cannot chat with yourself' });
    }

    // VERIFICATION CHECK: If other user is a listener, verify they are approved
    // Import Listener at top of file to avoid circular dependency issues
    const { default: Listener } = await import('../models/Listener.js');
    const otherUserListener = await Listener.findByUserId(other_user_id);
    
    if (otherUserListener) {
      // Other user is a listener - check verification status
      const verificationStatus = otherUserListener.verification_status || 'approved'; // Backward compatibility
      if (verificationStatus !== 'approved') {
        console.log(`[CHATS] Chat blocked: Listener ${otherUserListener.listener_id} not approved (status: ${verificationStatus})`);
        return res.status(403).json({ 
          error: 'Listener not approved yet',
          details: 'This listener is currently under verification and cannot receive chats.'
        });
      }
    }

    const chat = await Chat.findOrCreate(req.userId, other_user_id);

    res.json({
      message: 'Chat ready',
      chat
    });
  } catch (error) {
    console.error('Create chat error:', error);
    res.status(500).json({ error: 'Failed to create chat' });
  }
});

// GET /api/chats/:chat_id
// Get chat details
router.get('/:chat_id', authenticate, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chat_id);

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Check if user is part of the chat
    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({ chat });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ error: 'Failed to fetch chat' });
  }
});

// GET /api/chats/:chat_id/messages
// Get messages in a chat
router.get('/:chat_id/messages', authenticate, async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;

    // Verify user is part of chat
    const chat = await Chat.findById(req.params.chat_id);
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const messages = await Message.getChatMessages(req.params.chat_id, limit, offset, req.userId);

    // Mark messages as read
    await Message.markAsRead(req.params.chat_id, req.userId);

    res.json({
      messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// POST /api/chats/:chat_id/messages
// Send a message in a chat
router.post('/:chat_id/messages', authenticate, async (req, res) => {
  try {
    const { message_content, message_type, media_url } = req.body;

    if (!message_content) {
      return res.status(400).json({ error: 'message_content is required' });
    }

    if ((message_type && message_type !== 'text') || media_url) {
      return res.status(400).json({
        error: 'Use the secure chat file upload endpoint for file messages.'
      });
    }

    // Verify user is part of chat
    const chat = await Chat.findById(req.params.chat_id);
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // VERIFICATION CHECK: If other party is a listener, verify they are approved
    const otherUserId = chat.user1_id === req.userId ? chat.user2_id : chat.user1_id;

    const { default: Listener } = await import('../models/Listener.js');
    const otherUserListener = await Listener.findByUserId(otherUserId);
    
    if (otherUserListener) {
      // Other user is a listener - check verification status
      const verificationStatus = otherUserListener.verification_status || 'approved'; // Backward compatibility
      if (verificationStatus !== 'approved') {
        console.log(`[CHATS] Message send blocked: Listener ${otherUserListener.listener_id} not approved (status: ${verificationStatus})`);
        return res.status(403).json({ 
          error: 'Listener not approved yet',
          details: 'This listener is currently under verification and cannot receive messages.'
        });
      }
    }

    // CHAT CHARGING: Check if user should be charged for this message
    // Uses GLOBAL per-user counters (not per-chat) — survives chat clear/delete
    let chargeResult = null;
    try {
      chargeResult = await ChatChargeConfig.checkAndCharge(req.userId);
      if (!chargeResult.allowed) {
        console.log(`[CHATS] Message blocked for user ${req.userId}: ${chargeResult.reason}`);
        return res.status(402).json({
          status: 'failed',
          message: chargeResult.message || 'Insufficient balance. Please recharge.',
          code: chargeResult.reason || 'LOW_BALANCE',
          remainingFreeMessages: chargeResult.remainingFreeMessages ?? 0,
          totalMessagesSent: chargeResult.totalMessagesSent ?? 0
        });
      }
      if (chargeResult.charged) {
        console.log(`[CHATS] Charged user ${req.userId} ₹${chargeResult.chargeAmount} for chat message`);
      }
    } catch (chargeError) {
      console.error('[CHATS] Chat charge check error:', chargeError);
      // On charging system error, allow message through (fail-open)
    }

    const message = normalizeMessage(await Message.create({
      chat_id: req.params.chat_id,
      sender_id: req.userId,
      message_type: 'text',
      message_content,
    }));

    // Emit to socket for real-time delivery (if io is available)
    if (io) {
      const messageData = {
        chatId: req.params.chat_id,
        message: {
          ...message,
          sender_name: 'User',
        }
      };

      // Broadcast to all users in the chat room
      io.to(`chat_${req.params.chat_id}`).emit('chat:message', messageData);

      // Also send notification to the other user
      const otherUserId = chat.user1_id === req.userId ? chat.user2_id : chat.user1_id;
      io.to(`user_${otherUserId}`).emit('chat:new_message_notification', messageData);
      emitDeliveredIfOnline(io, otherUserId, message, req.params.chat_id);
      
      console.log(`[REST API] Message sent in chat ${req.params.chat_id}, emitted to socket`);
    }

    res.status(201).json({
      message: 'Message sent',
      data: message,
      remainingFreeMessages: chargeResult?.remainingFreeMessages ?? 0,
      totalMessagesSent: chargeResult?.totalMessagesSent ?? 0,
      charged: chargeResult?.charged ?? false,
      chargeAmount: chargeResult?.chargeAmount ?? 0
    });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/chats/:chat_id/files
// Securely upload a chat file to Cloudflare R2, then create and broadcast the file message.
router.post('/:chat_id/files', authenticate, handleChatFileUpload, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chat_id);

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided. Send multipart field "file".' });
    }

    const mimeType = String(req.file.mimetype || '').toLowerCase();
    if (!allowedMimeTypes.has(mimeType)) {
      return res.status(400).json({
        error: 'Unsupported file type.',
        code: 'UNSUPPORTED_FILE_TYPE',
      });
    }

    if (req.file.size > CHAT_FILE_MAX_BYTES) {
      return res.status(400).json({
        error: `File is too large. Maximum size is ${Math.round(CHAT_FILE_MAX_BYTES / (1024 * 1024))} MB.`,
        code: 'FILE_TOO_LARGE',
      });
    }

    const otherUserId = chat.user1_id === req.userId ? chat.user2_id : chat.user1_id;

    const uploadResult = await uploadToMinio(
      req.file.buffer,
      req.file.originalname,
      mimeType,
      `chats/${req.params.chat_id}`
    );

    const fileUrl = uploadResult.secure_url;
    const messageType = resolveMessageType(mimeType);
    const messageContent = req.body.message_content?.trim()
      || req.file.originalname
      || 'Attachment';
    const uploadedAt = new Date();

    let message;
    try {
      message = normalizeMessage(await Message.create({
        chat_id: req.params.chat_id,
        sender_id: req.userId,
        receiver_id: otherUserId,
        message_type: messageType,
        message_content: messageContent,
        media_url: fileUrl,
        file_url: fileUrl,
        file_key: uploadResult.public_id,
        file_name: req.file.originalname,
        file_type: mimeType,
        file_size: req.file.size,
        uploaded_at: uploadedAt,
      }));
    } catch (messageError) {
      try {
        await deleteFromMinioByUrl(fileUrl);
      } catch (deleteError) {
        console.error('[CHATS] Failed to delete unsaved chat upload:', deleteError.message);
      }
      throw messageError;
    }

    let chargeResult = null;
    try {
      chargeResult = await ChatChargeConfig.checkAndCharge(req.userId);
      if (!chargeResult.allowed) {
        try {
          await Message.hardDelete(message.message_id, req.userId);
        } catch (deleteMessageError) {
          console.error('[CHATS] Failed to delete uncharged file message:', deleteMessageError.message);
        }
        try {
          await deleteFromMinioByUrl(fileUrl);
        } catch (deleteFileError) {
          console.error('[CHATS] Failed to delete uncharged chat upload:', deleteFileError.message);
        }

        return res.status(402).json({
          status: 'failed',
          message: chargeResult.message || 'Insufficient balance. Please recharge.',
          code: chargeResult.reason || 'LOW_BALANCE',
          remainingFreeMessages: chargeResult.remainingFreeMessages ?? 0,
          totalMessagesSent: chargeResult.totalMessagesSent ?? 0,
        });
      }
    } catch (chargeError) {
      console.error('[CHATS] Chat file charge check error:', chargeError);
    }

    const senderInfo = await getSenderInfo(req.userId);
    const messageData = {
      chatId: req.params.chat_id,
      message: {
        ...message,
        sender_name: senderInfo.sender_name || 'User',
        sender_avatar: senderInfo.sender_avatar || null,
      },
    };

    if (io) {
      io.to(`chat_${req.params.chat_id}`).emit('chat:message', messageData);

      const otherUserState = io.userChatState?.get?.(otherUserId);
      const isOtherUserViewingThisChat = otherUserState &&
        otherUserState.appState === 'foreground' &&
        otherUserState.activelyViewingChatId === req.params.chat_id;

      if (!isOtherUserViewingThisChat) {
        io.to(`user_${otherUserId}`).emit('chat:new_message_notification', messageData);
      }

      emitDeliveredIfOnline(io, otherUserId, message, req.params.chat_id);
    }

    res.status(201).json({
      message: 'File sent',
      data: message,
      file: {
        fileUrl,
        fileKey: uploadResult.public_id,
        fileName: req.file.originalname,
        fileType: mimeType,
        fileSize: req.file.size,
        uploadedAt: message.uploaded_at,
        senderId: req.userId,
        receiverId: otherUserId,
        chatId: req.params.chat_id,
      },
      remainingFreeMessages: chargeResult?.remainingFreeMessages ?? 0,
      totalMessagesSent: chargeResult?.totalMessagesSent ?? 0,
      charged: chargeResult?.charged ?? false,
      chargeAmount: chargeResult?.chargeAmount ?? 0,
    });
  } catch (error) {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: `File is too large. Maximum size is ${Math.round(CHAT_FILE_MAX_BYTES / (1024 * 1024))} MB.`,
        code: 'FILE_TOO_LARGE',
      });
    }

    console.error('Send chat file error:', error);
    res.status(error.statusCode || 500).json({
      error: error.message || 'Failed to send file',
      code: error.code || 'CHAT_FILE_UPLOAD_FAILED',
    });
  }
});

// DELETE /api/chats/:chat_id/messages/:message_id/me
// Persistently hide a message for the current user only.
router.delete('/:chat_id/messages/:message_id/me', authenticate, async (req, res) => {
  try {
    const result = await Message.deleteForMe(
      req.params.message_id,
      req.userId,
      req.params.chat_id
    );

    if (!result.success) {
      const status = result.error === 'Forbidden' ? 403 : 404;
      return res.status(status).json({ error: result.error });
    }

    res.json({
      message: 'Message deleted for you',
      chatId: result.chatId,
      messageId: req.params.message_id,
      deletedFor: req.userId,
    });
  } catch (error) {
    console.error('Delete message for me error:', error);
    res.status(500).json({ error: 'Failed to delete message for you' });
  }
});

// GET /api/chats/:chat_id/messages/:message_id/file
// Authenticated file proxy for opening/downloading chat files.
router.get('/:chat_id/messages/:message_id/file', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*
       FROM messages m
       JOIN chats c ON c.chat_id = m.chat_id
       WHERE m.message_id = $1
         AND m.chat_id = $2
         AND (c.user1_id = $3 OR c.user2_id = $3)
         AND COALESCE(m.is_deleted_for_everyone, FALSE) = FALSE
         AND NOT ($3::uuid = ANY(COALESCE(m.deleted_for, '{}')))
       LIMIT 1`,
      [req.params.message_id, req.params.chat_id, req.userId]
    );

    const message = result.rows[0];
    if (!message) {
      return res.status(404).json({ error: 'File not found' });
    }

    const fileUrl = message.file_url || message.media_url;
    if (!fileUrl) {
      return res.status(404).json({ error: 'File not found' });
    }

    const upstream = await fetch(fileUrl);
    if (!upstream.ok) {
      console.error('[CHATS] File proxy upstream failed', {
        messageId: req.params.message_id,
        fileKey: message.file_key,
        status: upstream.status,
      });
      return res.status(502).json({ error: 'File is temporarily unavailable' });
    }

    const contentType = message.file_type || upstream.headers.get('content-type') || 'application/octet-stream';
    const fileName = String(message.file_name || 'attachment').replace(/["\r\n]/g, '');
    const arrayBuffer = await upstream.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', Buffer.byteLength(Buffer.from(arrayBuffer)));
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
    res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    console.error('Open chat file error:', error);
    res.status(500).json({ error: 'Failed to open file' });
  }
});

// DELETE /api/chats/:chat_id/messages
// Clear all messages in a chat
router.delete('/:chat_id/messages', authenticate, async (req, res) => {
  try {
    const chat = await Chat.findById(req.params.chat_id);

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await Chat.clearMessages(req.params.chat_id);

    if (io) {
      io.to(`chat_${req.params.chat_id}`).emit('chat:cleared', {
        chatId: req.params.chat_id,
        clearedBy: req.userId,
      });
    }

    res.json({ message: 'Chat cleared successfully' });
  } catch (error) {
    console.error('Clear chat error:', error);
    res.status(500).json({ error: 'Failed to clear chat' });
  }
});

// PUT /api/chats/:chat_id/read
// Mark all messages in chat as read
router.put('/:chat_id/read', authenticate, async (req, res) => {
  try {
    const markedMessages = await Message.markAsRead(req.params.chat_id, req.userId);

    res.json({
      message: 'Messages marked as read',
      count: markedMessages.length
    });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// GET /api/chats/unread/count
// Get unread message count
router.get('/unread/count', authenticate, async (req, res) => {
  try {
    const count = await Message.getUnreadCount(req.userId);

    res.json({
      unread_count: parseInt(count)
    });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Failed to fetch unread count' });
  }
});

// DELETE /api/chats/:chat_id
// Delete/deactivate a chat
router.delete('/:chat_id', authenticate, async (req, res) => {
  try {
    // Verify user is part of chat
    const chat = await Chat.findById(req.params.chat_id);
    
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.user1_id !== req.userId && chat.user2_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await Chat.deactivate(req.params.chat_id);

    res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({ error: 'Failed to delete chat' });
  }
});

  return router;
}
