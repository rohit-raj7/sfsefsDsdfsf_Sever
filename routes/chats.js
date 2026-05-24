import express from 'express';
import { Chat, Message } from '../models/Chat.js';
import ChatChargeConfig from '../models/ChatChargeConfig.js';
import { authenticate } from '../middleware/auth.js';

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

    const messages = await Message.getChatMessages(req.params.chat_id, limit, offset);

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

    const message = await Message.create({
      chat_id: req.params.chat_id,
      sender_id: req.userId,
      message_type: message_type || 'text',
      message_content,
      media_url
    });

    // Emit to socket for real-time delivery (if io is available)
    if (io) {
      const messageData = {
        chatId: req.params.chat_id,
        message: {
          ...message,
          // FIX: Ensure created_at is a UTC ISO string for consistent client parsing
          created_at: message.created_at instanceof Date
            ? message.created_at.toISOString()
            : message.created_at,
          sender_name: 'User',
        }
      };

      // Broadcast to all users in the chat room
      io.to(`chat_${req.params.chat_id}`).emit('chat:message', messageData);

      // Also send notification to the other user
      const otherUserId = chat.user1_id === req.userId ? chat.user2_id : chat.user1_id;
      io.to(`user_${otherUserId}`).emit('chat:new_message_notification', messageData);
      
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
