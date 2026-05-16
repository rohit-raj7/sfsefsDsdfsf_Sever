import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import config from './config/config.js';
import { testConnection, ensureSchema, pool } from './db.js';
// Initialize Express app
const app = express();
app.set('trust proxy', 1); // Trust first proxy (required for Coolify/Nginx rate limiting)
const server = http.createServer(app);
const io = new Server(server, {
  cors: config.cors,
  pingTimeout: config.socketIO.pingTimeout,
  pingInterval: config.socketIO.pingInterval
});
app.set('io', io);
setNotificationEmitter(io);

// Import routes
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import listenerRoutes from './routes/listeners.js';
import callRoutes from './routes/calls.js';
import createChatsRouter from './routes/chats.js';
import adminRoutes from './routes/admin.js';
import contactRoutes from './routes/contacts.js';
import notificationsRoutes from './routes/notifications.js';
import accountRoutes from './routes/account.js';
import paymentRoutes from './routes/payments.js';
import ratingRoutes from './routes/ratings.js';
import appRatingRoutes from './routes/appRatings.js';
import rechargePackRoutes from './routes/rechargePacks.js';
import subscriptionRoutes from './routes/subscriptions.js';
import reportRoutes from './routes/reports.js';
import marketingRoutes from './routes/marketing.js';
import User from './models/User.js';
import Listener from './models/Listener.js'; // Import for verification checks
import Call from './models/Call.js';
import { markCallStarted, calculateMaxCallDuration, finalizeCallBilling as billingFinalize } from './services/callBillingService.js';
import { Chat, Message } from './models/Chat.js';
import ChatChargeConfig from './models/ChatChargeConfig.js';
import {
  bootstrapScheduledNotifications,
  processNotifications,
  setNotificationEmitter,
} from './services/notificationWorker.js';

// ============================================
// MIDDLEWARE
// ============================================

// Security middleware
app.use(helmet());

// CORS
app.use(cors(config.cors));
app.options('*', cors(config.cors));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Compression
app.use(compression());

// Logging
if (config.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// Rate limiting Ã¢â‚¬â€ general (generous for mobile retries & socket reconnects)
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,  // Send RateLimit-* headers so clients know remaining quota
  legacyHeaders: false,   // Disable X-RateLimit-* (deprecated)
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

// Stricter rate limit for auth endpoints (login, OTP, register)
const authLimiter = rateLimit({
  windowMs: config.authRateLimit.windowMs,
  max: config.authRateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again after some time.' }
});
app.use('/api/auth/', authLimiter);

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'Dost Talk API Server',
    version: '1.0.0',
    status: 'running'
  });
});

// API health check
app.get('/api/health', async (req, res) => {
  try {
    const dbConnected = await testConnection();
    res.json({
      status: 'healthy',
      database: dbConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});


// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/listeners', listenerRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/chats', createChatsRouter(io)); // Pass io for real-time message delivery
app.use('/api/admin', adminRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/app-ratings', appRatingRoutes);
app.use('/api/recharge-packs', rechargePackRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/marketing', marketingRoutes);

// ============================================
// SOCKET.IO - REAL-TIME FEATURES
// ============================================



// In-memory maps
const connectedUsers = new Map(); // Map of userId -> socketId
const listenerSockets = new Map(); // Map of listenerUserId -> socketId
const activeChannels = new Map(); // Map of channelName -> Set of userIds in channel
const lastSeenMap = new Map(); // Map of userId -> timestamp
const presenceTimeouts = new Map(); // Map of userId -> timeoutId
const busyUsers = new Map(); // Map of listenerUserId -> callId (in-memory busy tracking)
app.set('busyUsers', busyUsers);
const pendingCalls = new Map(); // Map of callId -> { callerId, listenerId, listenerSocketId, createdAt } (tracks pre-answer calls for cancel routing)
const activeCallTimers = new Map(); // Map of callId -> { timerId, callerId, listenerUserId, channelName, startedAt, maxAllowedSeconds }
const processingCalls = new Set(); // Dedup guard: callIds currently being set up in call:joined handler
const LISTENER_TO_USER_RING_TIMEOUT_MS = 32000;

const clearPendingCall = (callId) => {
  const pending = pendingCalls.get(callId);
  if (pending?.timeoutId) {
    clearTimeout(pending.timeoutId);
  }
  pendingCalls.delete(callId);
  return pending;
};

// Ã¢â€â‚¬Ã¢â€â‚¬ Random User-to-User Match Pool Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// When "Match with Verified Expert" toggle is OFF, users join this pool.
// The server instantly pairs two waiting users and emits `random:matched` to both.
const randomUserPool = new Map(); // Map of userId -> { socketId, displayName, avatarUrl, gender, joinedAt }

// Clean up stale pool entries (waiting > 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of randomUserPool.entries()) {
    if (now - entry.joinedAt > 5 * 60 * 1000) {
      console.log(`[RANDOM] Removed stale pool entry for user ${userId}`);
      randomUserPool.delete(userId);
    }
  }
}, 60000);
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬


// Stale pendingCalls cleanup: remove entries older than 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [callId, pending] of pendingCalls.entries()) {
    if (now - pending.createdAt > 60000) {
      console.log(`[SOCKET] Stale pendingCall ${callId} removed (age: ${Math.round((now - pending.createdAt) / 1000)}s)`);
      clearPendingCall(callId);
    }
  }
}, 30000);

// Stale active call timer cleanup: safety net for calls whose timers were lost
// Checks every 5 minutes for any activeCallTimers older than maxAllowedSeconds + 60s
setInterval(() => {
  const now = Date.now();
  for (const [callId, timer] of activeCallTimers.entries()) {
    const elapsed = (now - timer.startedAt) / 1000;
    const maxWithGrace = timer.maxAllowedSeconds + 60;
    if (elapsed > maxWithGrace) {
      console.log(`[SOCKET] Stale activeCallTimer ${callId} removed (elapsed: ${Math.round(elapsed)}s > max: ${maxWithGrace}s)`);
      clearTimeout(timer.timerId);
      activeCallTimers.delete(callId);
      // Trigger billing as safety net
      (async () => {
        try {
          const billDuration = Math.min(Math.round(elapsed), timer.maxAllowedSeconds);
          await billingFinalize({ callId, durationSeconds: billDuration });
          console.log(`[SOCKET] Stale call ${callId}: safety billing completed (${billDuration}s)`);
        } catch (e) {
          console.error(`[SOCKET] Stale call ${callId}: safety billing error:`, e.message);
        }
      })();
    }
  }
}, 300000);

// WhatsApp-style chat state tracking
const userChatState = new Map(); // Map of userId -> { activelyViewingChatId, appState: 'foreground'|'background' }

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // Helper: Clear busy status for a user (checks both parties)
  function _clearBusyForCall(userId1, userId2) {
    for (const uid of [userId1, userId2]) {
      if (uid && busyUsers.has(uid)) {
        busyUsers.delete(uid);
        io.emit('listener_busy_status', { listenerUserId: uid, busy: false });
        console.log(`[SOCKET] _clearBusyForCall: Listener ${uid} marked NOT BUSY`);
        // Also clear in DB (fire-and-forget)
        Listener.clearBusyByUserId(uid).catch(e => console.error('[SOCKET] clearBusyByUserId DB error:', e.message));
      }
    }
  }

  function _markUserOffline(userId, reason = 'offline') {
    if (!userId) return false;
    const currentSocketId = connectedUsers.get(userId);
    if (!currentSocketId || currentSocketId !== socket.id) {
      return false;
    }

    connectedUsers.delete(userId);
    lastSeenMap.delete(userId);
    if (presenceTimeouts.has(userId)) {
      clearTimeout(presenceTimeouts.get(userId));
      presenceTimeouts.delete(userId);
    }

    User.updateLastSeen(userId).catch((err) => {
      console.error(`[SOCKET] Failed to update last_seen for ${userId}:`, err.message);
    });

    io.emit('user:offline', { userId, timestamp: Date.now(), reason });
    console.log(`[SOCKET] User ${userId} marked offline (${reason})`);
    return true;
  }

  function _markListenerOffline(listenerUserId, reason = 'offline') {
    if (!listenerUserId) return false;
    const currentSocketId = listenerSockets.get(listenerUserId);
    if (!currentSocketId || currentSocketId !== socket.id) {
      return false;
    }

    listenerSockets.delete(listenerUserId);
    io.emit('listener_status', {
      listenerUserId,
      online: false,
      timestamp: Date.now(),
      reason,
    });
    console.log(`[SOCKET] Listener ${listenerUserId} marked offline (${reason})`);
    return true;
  }

  // 1. IDENTITY & PRESENCE
  
  // User joins (can be regular user or listener)
  socket.on('user:join', (data) => {
    // Support both old format (just userId string) and new format (object with userId, userName, avatar)
    let userId, userName, userAvatar, activelyViewingChatId;
    if (typeof data === 'string') {
      userId = data;
    } else if (data && typeof data === 'object') {
      userId = data.userId;
      userName = data.userName;
      userAvatar = data.userAvatar;
      activelyViewingChatId = data.activelyViewingChatId; // WhatsApp-style: which chat is open
    }
    
    if (!userId) return;
    socket.userId = userId;
    socket.userName = userName || 'Unknown';
    socket.userAvatar = userAvatar;
    connectedUsers.set(userId, socket.id);
    lastSeenMap.set(userId, Date.now());
    
    // Initialize or update user chat state (WhatsApp-style tracking)
    userChatState.set(userId, {
      activelyViewingChatId: activelyViewingChatId || null,
      appState: 'foreground'
    });
    
    // Join user's personal room for notifications
    socket.join(`user_${userId}`);
    console.log(`[SOCKET] User ${userId} joined personal room: user_${userId}`);
    
    // Clear any pending offline timeout
    if (presenceTimeouts.has(userId)) {
      clearTimeout(presenceTimeouts.get(userId));
      presenceTimeouts.delete(userId);
    }
    
    io.emit('user:online', { userId, timestamp: Date.now() });
    console.log(`[SOCKET] User joined: ${userId} (${userName || 'unknown name'}), activeChat: ${activelyViewingChatId || 'none'}`);

    // Send current presence snapshots to the newly joined user.
    const onlineListeners = Array.from(listenerSockets.keys());
    const onlineUsers = Array.from(connectedUsers.keys());
    socket.emit('listeners:initial_status', onlineListeners);
    socket.emit('users:initial_status', onlineUsers);
    socket.emit('listeners:initial_busy', Array.from(busyUsers.keys()));
  });

  // Listener specific join (for availability tracking)
  // CRITICAL: This is what makes a listener available to receive calls
  // Must be emitted when listener app is open (any page)
  socket.on('listener:join', async (listenerUserId) => {
    if (!listenerUserId) return;
    socket.userId = listenerUserId; // Sync with userId
    socket.listenerUserId = listenerUserId;
    
    // Remove old socket if exists to prevent ghost sessions
    if (listenerSockets.has(listenerUserId)) {
      const oldSocketId = listenerSockets.get(listenerUserId);
      if (oldSocketId && oldSocketId !== socket.id) {
        console.log(`[SOCKET] listener:join: Removing old socket ${oldSocketId} for listener ${listenerUserId}`);
        const oldSocket = io.sockets.sockets.get(oldSocketId);
        if (oldSocket) oldSocket.disconnect(true);
      }
    }
    
    // Register listener as available for calls
    listenerSockets.set(listenerUserId, socket.id);
    connectedUsers.set(listenerUserId, socket.id); // Also ensure in connectedUsers

    // CRITICAL FIX: Update last_active_at in DB so the REST API call route
    // can confirm listener is online (it checks last_active_at <= 2 min)
    try {
      await Listener.updateLastActiveByUserId(listenerUserId);
      console.log(`[SOCKET] listener:join: Ã¢Å“â€œ Updated last_active_at for ${listenerUserId}`);
    } catch (err) {
      console.error(`[SOCKET] listener:join: Failed to update last_active_at:`, err.message);
    }

    // Keep last_active_at fresh every 90s so calls always work while listener is connected
    const keepAliveInterval = setInterval(async () => {
      if (!listenerSockets.has(listenerUserId) || listenerSockets.get(listenerUserId) !== socket.id) {
        clearInterval(keepAliveInterval);
        return;
      }
      try {
        await Listener.updateLastActiveByUserId(listenerUserId);
      } catch (_) {}
    }, 90000);

    socket.once('disconnect', () => clearInterval(keepAliveInterval));
    
    io.emit('listener_status', { listenerUserId, online: true, timestamp: Date.now() });
    socket.emit('users:initial_status', Array.from(connectedUsers.keys()));
    socket.emit('listeners:initial_busy', Array.from(busyUsers.keys()));
    console.log(`[SOCKET] listener:join: Ã¢Å“â€œ Listener ${listenerUserId} is now ONLINE (socket: ${socket.id})`);
    console.log(`[SOCKET] listener:join: Total online listeners: ${listenerSockets.size}`);
  });

  // Explicit offline events clear foreground/call presence while the socket can
  // remain connected for chat and notification coordination.
  socket.on('listener:offline', (data) => {
    const { listenerUserId } = data || {};
    if (listenerUserId) {
      _markListenerOffline(listenerUserId, 'manual');
      console.log(`[SOCKET] listener:offline: Ã¢Å“â€œ Listener ${listenerUserId} manually went OFFLINE`);
    }
  });

  // Ã¢â€â‚¬Ã¢â€â‚¬ RANDOM USER-TO-USER MATCH Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  socket.on('user:offline', (data) => {
    const { userId } = data || {};
    _markUserOffline(userId, 'manual');
  });

  // Toggle OFF: User wants a free random match with another regular user.
  // Server maintains an in-memory pool. When 2 users are waiting, they are paired.
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // User joins the free random match pool
  socket.on('random:join_pool', async (data) => {
    const { userId, displayName, avatarUrl, gender, preferredGender } = data || {};
    if (!userId) return;

    if (busyUsers.has(userId)) {
      console.log(`[SOCKET] random:join_pool: ❌ User ${userId} is BUSY`);
      socket.emit('random:join_rejected', {
        reason: 'user_busy',
        message: 'You are currently on another call.',
      });
      return;
    }

    // Strict routing guard: random pool is for normal users only (not experts/listeners).
    try {
      const eligibilityResult = await pool.query(
        `
          SELECT
            u.account_type,
            EXISTS (
              SELECT 1
              FROM listeners l
              WHERE l.user_id = u.user_id
                AND l.is_active = TRUE
                AND COALESCE(l.verification_status, 'approved') = 'approved'
                AND COALESCE(l.listener_type, 'full') = 'full'
            ) AS is_expert
          FROM users u
          WHERE u.user_id = $1
          LIMIT 1
        `,
        [userId]
      );

      if (eligibilityResult.rows.length === 0) {
        socket.emit('random:join_rejected', {
          reason: 'user_not_found',
          message: 'Unable to join random pool right now.',
        });
        return;
      }

      const eligibility = eligibilityResult.rows[0];
      const isListenerAccount = eligibility.account_type === 'listener';
      const isExpert = eligibility.is_expert === true;
      if (isListenerAccount || isExpert) {
        socket.emit('random:join_rejected', {
          reason: 'experts_not_allowed',
          message: 'Random call is only available for normal users.',
        });
        return;
      }
    } catch (error) {
      console.error('[RANDOM] Eligibility check failed:', error.message);
      socket.emit('random:join_rejected', {
        reason: 'server_error',
        message: 'Unable to join random pool right now.',
      });
      return;
    }

    // Clear any old stale entry / pending timeout
    if (randomUserPool.has(userId)) {
      const old = randomUserPool.get(userId);
      if (old.timeoutId) clearTimeout(old.timeoutId);
      randomUserPool.delete(userId);
    }

    console.log(`[RANDOM] User ${userId} (${displayName}, gender=${gender}, prefer=${preferredGender}) joined pool. Pool size: ${randomUserPool.size + 1}`);

    // Gender-aware matching:
    // 1st pass: find a user whose gender matches the requester's preference AND
    //           whose own preference matches the requester's gender (mutual)
    // 2nd pass: if preferredGender is 'Any', accept anyone
    let matchedUserId = null;

    // Pass 1: strict gender preference match
    if (preferredGender && preferredGender !== 'Any') {
      for (const [waitingUserId, entry] of randomUserPool.entries()) {
        if (waitingUserId === userId) continue;
        if (busyUsers.has(waitingUserId)) {
          randomUserPool.delete(waitingUserId);
          continue;
        }
        const genderMatch = entry.gender === preferredGender;
        const theirPrefMatch = !entry.preferredGender || entry.preferredGender === 'Any' || entry.preferredGender === gender;
        if (genderMatch && theirPrefMatch) {
          matchedUserId = waitingUserId;
          break;
        }
      }
    }

    // Pass 2: any gender (fallback or 'Any' preference)
    if (!matchedUserId) {
      for (const [waitingUserId, entry] of randomUserPool.entries()) {
        if (waitingUserId === userId) continue;
        if (busyUsers.has(waitingUserId)) {
          randomUserPool.delete(waitingUserId);
          continue;
        }
        // Only accept if their preference also allows any or matches current user
        const theirPrefOk = !entry.preferredGender || entry.preferredGender === 'Any' || entry.preferredGender === gender;
        if (theirPrefOk) {
          matchedUserId = waitingUserId;
          break;
        }
      }
    }

    if (matchedUserId) {
      // Found a match! Pair both users.
      const matchedEntry = randomUserPool.get(matchedUserId);
      if (matchedEntry.timeoutId) clearTimeout(matchedEntry.timeoutId);
      randomUserPool.delete(matchedUserId);

      const currentUserInfo = { userId, displayName, avatarUrl, gender };
      const matchedUserInfo = {
        userId: matchedUserId,
        displayName: matchedEntry.displayName,
        avatarUrl: matchedEntry.avatarUrl,
        gender: matchedEntry.gender,
      };

      socket.emit('random:matched', { matchedUser: matchedUserInfo });

      const matchedSocketId = matchedEntry.socketId;
      if (matchedSocketId) {
        io.to(matchedSocketId).emit('random:matched', { matchedUser: currentUserInfo });
      }

      console.log(`[RANDOM] Ã¢Å“â€œ Matched: ${userId} <-> ${matchedUserId}`);
    } else {
      // No match found Ã¢â‚¬â€ add to pool and set a 30s timeout
      const timeoutId = setTimeout(() => {
        if (randomUserPool.has(userId)) {
          randomUserPool.delete(userId);
          // Notify client that no match was found within the timeout
          socket.emit('random:no_match', {
            preferredGender: preferredGender || 'Any',
            message: preferredGender && preferredGender !== 'Any'
              ? `All ${preferredGender.toLowerCase()} users are busy right now`
              : 'No users available right now',
          });
          console.log(`[RANDOM] Timeout: no match for user ${userId} (prefer: ${preferredGender})`);
        }
      }, 30000);

      randomUserPool.set(userId, {
        socketId: socket.id,
        displayName: displayName || 'User',
        avatarUrl: avatarUrl || null,
        gender: gender || null,
        preferredGender: preferredGender || 'Any',
        joinedAt: Date.now(),
        timeoutId,
      });
      console.log(`[RANDOM] User ${userId} added to pool. Waiting 30s...`);
    }
  });


  // User leaves the free random match pool (cancelled search)
  socket.on('random:leave_pool', (data) => {
    const { userId } = data || {};
    if (userId) {
      randomUserPool.delete(userId);
      console.log(`[RANDOM] User ${userId} left pool. Pool size: ${randomUserPool.size}`);
    }
  });

  // Relaying random match calls (free user-to-user) without billing
  socket.on('random:call_invite', (data) => {
    const { targetUserId, channelName, callerName, callerAvatar } = data || {};
    if (!targetUserId) return;
    const targetSocketId = connectedUsers.get(targetUserId) || listenerSockets.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('random:call_invite', { channelName, callerName, callerAvatar });
      console.log(`[RANDOM] Call invite from ${socket.userId} to ${targetUserId}`);
    }
  });

  // Relaying when a user skips the match
  socket.on('random:match_closed', (data) => {
    const { targetUserId } = data || {};
    if (!targetUserId) return;
    const targetSocketId = connectedUsers.get(targetUserId) || listenerSockets.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('random:match_closed', {});
      console.log(`[RANDOM] Match closed by ${socket.userId} for ${targetUserId}`);
    }
  });

  // Clean up pool entry on disconnect
  socket.on('disconnect', () => {
    const userId = socket.userId;
    if (userId && randomUserPool.has(userId)) {
      randomUserPool.delete(userId);
      console.log(`[RANDOM] Removed disconnected user ${userId} from random pool`);
    }
  });
  // Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

  // 2. CALL HANDLING


  // Initiate call: User -> Listener
  // CRITICAL: This checks if listener is online by looking for their explicit
  // foreground listener availability socket. connectedUsers is not enough:
  // the listener must have the Online button enabled and the app foregrounded.
  socket.on('call:initiate', async (data) => {
    const { listenerId, ...callData } = data || {};
    
    // CALLER BUSY CHECK
    if (socket.userId && busyUsers.has(socket.userId)) {
      console.log(`[SOCKET] call:initiate: ❌ Caller ${socket.userId} is already BUSY`);
      socket.emit('call:failed', { callId: callData.callId, reason: 'caller_busy', message: 'You are already in a call' });
      return;
    }

    let listenerSocketId = listenerSockets.get(listenerId);
    
    console.log(`[SOCKET] call:initiate: Looking for listener ${listenerId}`);
    console.log(`[SOCKET] call:initiate: Found socketId: ${listenerSocketId || 'NONE'}`);
    
    // Fetch listener user to check for FCM token
    let listenerUser = null;
    try {
      listenerUser = await User.findByIdForRealtime(listenerId);
    } catch(e) {
      console.error('[SOCKET] Error fetching listener user for FCM:', e);
    }

    if (!listenerSocketId) {
      // Listener is offline for calls when the Online button is off or the app
      // is backgrounded/closed, even if FCM is available.
      console.log(`[SOCKET] call:initiate: Ã¢Å“â€” Listener ${listenerId} offline for calls`);
      socket.emit('call:failed', { callId: callData.callId, reason: 'listener_offline' });
      return;
    }

    // BUSY CHECK: If listener is already in an active call, notify caller
    if (busyUsers.has(listenerId)) {
      console.log(`[SOCKET] call:initiate: Ã¢Å“â€” Listener ${listenerId} is BUSY (active call: ${busyUsers.get(listenerId)})`);
      socket.emit('call:busy', {
        callId: callData.callId,
        listenerId,
        reason: 'listener_busy',
        message: 'Listener is busy on another call'
      });
      return;
    }

    // Track this pending call so we can route cancel events to listener
    if (callData.callId) {
      pendingCalls.set(callData.callId, {
        initiatorUserId: socket.userId,
        calleeUserId: listenerId,
        listenerUserId: listenerId,
        calleeSocketId: listenerSocketId,
        createdAt: Date.now(),
      });
      console.log(`[SOCKET] call:initiate: Tracking pending call ${callData.callId}`);
    }

    // Forward incoming-call to listener IMMEDIATELY (don't block on DB)
    if (listenerSocketId) {
      io.to(listenerSocketId).emit('incoming-call', callData);
    }
    console.log(`[SOCKET] call:initiate: Ã¢Å“â€œ Forwarded to listener ${listenerId} (socket: ${listenerSocketId})`);

    // THEN verify in background Ã¢â‚¬â€ if not approved, cancel the call
    try {
      const listener = await Listener.findByUserId(listenerId);
      if (listener) {
        const verificationStatus = listener.verification_status || 'approved';
        if (verificationStatus !== 'approved') {
          console.log(`[SOCKET] call:initiate blocked: Listener ${listenerId} not approved (status: ${verificationStatus})`);
          // Notify caller that call failed
          socket.emit('call:failed', { 
            callId: callData.callId, 
            reason: 'listener_not_approved',
            message: 'Listener not approved yet'
          });
          // Also cancel the incoming call on the listener side
          if (listenerSocketId) {
            io.to(listenerSocketId).emit('call:ended', {
              callId: callData.callId,
              reason: 'cancelled',
              code: 'VERIFICATION_FAILED'
            });
          }
          return;
        }
      }
    } catch (err) {
      console.error(`[SOCKET] call:initiate verification check failed:`, err);
      // Don't fail the call for a verification check error Ã¢â‚¬â€ call was already forwarded
    }

    const listenerFcmToken = listenerUser?.fcm_token ? String(listenerUser.fcm_token).trim() : '';
    if (listenerUser && listenerFcmToken) {
      try {
        console.log(`[SOCKET] call:initiate: Sending FCM Push to listener ${listenerId} (token: ${listenerFcmToken.substring(0, 15)}...)`);
        
        // Fetch caller details for notification
        const callerUser = await User.findByIdForRealtime(socket.userId);
        const callerName = callerUser ? (callerUser.display_name || callerUser.full_name) : 'User';
        const callerAvatar = callerUser ? callerUser.avatar_url : '';

        // The data payload explicitly matches what Flutter needs to trigger the incoming call UI
        const pushData = {
          type: 'incoming_call',
          callId: String(callData.callId || ''),
          callerId: String(socket.userId || ''),
          callerName: String(callerName || 'Someone'),
          callerAvatar: String(callerAvatar || ''),
          channelName: String(callData.channelName || ''),
          callType: String(callData.callType || 'audio'),
          ratePerMinute: String(callData.ratePerMinute || '0')
        };

        // For CallKeep / background handling, data payload is the most important part
        const pushResult = await sendPushFCM(
          listenerFcmToken, 
          'Incoming Call', 
          `${callerName} is calling you`, 
          pushData
        );
        if (!pushResult?.success) {
          console.error(
            `[SOCKET] call:initiate: FCM Push failed for listener ${listenerId}: ${pushResult?.error || 'Unknown FCM error'}`,
          );
          if (pushResult?.isInvalidToken) {
            await User.clearFcmToken(listenerId, listenerFcmToken);
          }
        }
        if (pushResult?.success) {
        }
        console.log(`[SOCKET] call:initiate: Ã¢Å“â€œ FCM Push sent successfully to listener ${listenerId}`);
      } catch (fcmErr) {
        console.error(`[SOCKET] call:initiate: Ã¢Å“â€” FCM Push failed:`, fcmErr.message);
      }
    }
  });

  // Initiate call: Listener -> User
  socket.on('listener_call:initiate', async (data) => {
    const { targetUserId, ...callData } = data || {};
    const listenerUserId = socket.listenerUserId || socket.userId;

    // CALLER BUSY CHECK
    if (listenerUserId && busyUsers.has(listenerUserId)) {
      console.log(`[SOCKET] listener_call:initiate: ❌ Caller ${listenerUserId} is already BUSY`);
      socket.emit('call:failed', { callId: callData.callId, reason: 'caller_busy', message: 'You are already in a call' });
      return;
    }

    // TARGET BUSY CHECK
    if (targetUserId && busyUsers.has(targetUserId)) {
      console.log(`[SOCKET] listener_call:initiate: ❌ Target user ${targetUserId} is BUSY`);
      socket.emit('call:busy', { callId: callData.callId, reason: 'user_busy', message: 'User is busy on another call' });
      return;
    }

    // Always trust backend-created call snapshot rates over client payload.
    // This keeps user charge / listener payout aligned with admin rule settings.
    let resolvedRatePerMinute = Number(callData.ratePerMinute || 0);
    let resolvedListenerDbId = callData.listenerId || callData.listener_id || null;
    if (callData.callId) {
      try {
        const persistedCall = await Call.findById(callData.callId);
        if (persistedCall) {
          const persistedRate = Number(
            persistedCall.billed_user_rate_per_min || persistedCall.rate_per_minute || 0
          );
          if (Number.isFinite(persistedRate) && persistedRate > 0) {
            resolvedRatePerMinute = persistedRate;
          }
          resolvedListenerDbId = resolvedListenerDbId || persistedCall.listener_id || null;
        }
      } catch (rateErr) {
        console.error('[SOCKET] listener_call:initiate rate resolve error:', rateErr.message);
      }
    }
    callData.ratePerMinute = resolvedRatePerMinute;
    if (resolvedListenerDbId) {
      callData.listenerId = resolvedListenerDbId;
      callData.listener_id = resolvedListenerDbId;
    }
    
    let targetSocketId = connectedUsers.get(targetUserId);
    
    console.log(`[SOCKET] listener_call:initiate: Looking for target user ${targetUserId}`);
    console.log(`[SOCKET] listener_call:initiate: Found socketId: ${targetSocketId || 'NONE'}`);
    
    // Fetch target user to check for FCM token
    let targetUser = null;
    try {
      targetUser = await User.findByIdForRealtime(targetUserId);
    } catch(e) {
      console.error('[SOCKET] Error fetching target user for FCM:', e);
    }

    if (!targetSocketId) {
      console.log(`[SOCKET] listener_call:initiate: Ã¢Å“â€” User ${targetUserId} offline for calls`);
      socket.emit('call:failed', { callId: callData.callId, reason: 'user_offline' });
      return;
    }

    // Track this pending call so we can route cancel events
    if (callData.callId) {
      const pendingTimeoutId = setTimeout(async () => {
        const pending = clearPendingCall(callData.callId);
        if (!pending) return;

        console.log(
          `[SOCKET] listener_call:initiate: pending call ${callData.callId} timed out (no answer)`,
        );

        const initiatorSocketId =
          connectedUsers.get(pending.initiatorUserId) ||
          listenerSockets.get(pending.initiatorUserId);
        if (initiatorSocketId) {
          io.to(initiatorSocketId).emit('call:ended', {
            callId: callData.callId,
            endedBy: pending.calleeUserId || targetUserId,
            reason: 'no_answer',
            code: 'NO_ANSWER',
          });
        }

        if (pending.calleeSocketId) {
          io.to(pending.calleeSocketId).emit('call:ended', {
            callId: callData.callId,
            endedBy: pending.initiatorUserId,
            reason: 'ring_timeout',
            code: 'NO_ANSWER',
          });
        }

        try {
          const checkCall = await Call.findById(callData.callId);
          if (
            checkCall &&
            ['pending', 'ringing', 'initiated'].includes(checkCall.status)
          ) {
            await Call.updateStatus(callData.callId, 'missed');
          }
        } catch (err) {
          console.error(
            `[SOCKET] listener_call:initiate no-answer status update failed for ${callData.callId}:`,
            err.message,
          );
        }
      }, LISTENER_TO_USER_RING_TIMEOUT_MS);

      pendingCalls.set(callData.callId, {
        initiatorUserId: listenerUserId,
        calleeUserId: targetUserId,
        listenerUserId,
        calleeSocketId: targetSocketId,
        createdAt: Date.now(),
        timeoutId: pendingTimeoutId,
      });
      console.log(`[SOCKET] listener_call:initiate: Tracking pending call ${callData.callId}`);
    }

    // Forward incoming-call to user IMMEDIATELY
    if (targetSocketId) {
      io.to(targetSocketId).emit('incoming-call', callData);
    }
    console.log(`[SOCKET] listener_call:initiate: Ã¢Å“â€œ Forwarded to user ${targetUserId} (socket: ${targetSocketId})`);

    const targetFcmToken = targetUser?.fcm_token ? String(targetUser.fcm_token).trim() : '';
    if (targetUser && targetFcmToken) {
      try {
        console.log(`[SOCKET] listener_call:initiate: Sending FCM Push to user ${targetUserId}`);
        
        // Fetch listener details for notification
        let listenerName = 'Experts';
        let listenerAvatar = '';
        try {
           const listenerObj = await Listener.findByUserId(socket.userId);
           if (listenerObj) {
             listenerName = listenerObj.professional_name || listenerObj.full_name || 'Experts';
             listenerAvatar = listenerObj.profile_image || '';
           }
        } catch (e) {}

        const pushData = {
          type: 'incoming_call',
          callId: String(callData.callId || ''),
          callerId: String(socket.userId || ''), // Listener is the caller from User perspective
          callerName: String(listenerName),
          callerAvatar: String(listenerAvatar),
          listenerId: String(callData.listenerId || ''),
          listener_id: String(callData.listenerId || ''),
          channelName: String(callData.channelName || ''),
          callType: String(callData.callType || 'audio'),
          ratePerMinute: String(callData.ratePerMinute || '0')
        };

        const pushResult = await sendPushFCM(
          targetFcmToken, 
          'Incoming Call', 
          `${listenerName} is calling you`, 
          pushData
        );
        if (!pushResult?.success) {
          console.error(
            `[SOCKET] listener_call:initiate: FCM Push failed for user ${targetUserId}: ${pushResult?.error || 'Unknown FCM error'}`,
          );
          if (pushResult?.isInvalidToken) {
            await User.clearFcmToken(targetUserId, targetFcmToken);
          }
        }
        if (pushResult?.success) {
        }
        console.log(`[SOCKET] listener_call:initiate: Ã¢Å“â€œ FCM Push sent successfully to user ${targetUserId}`);
      } catch (fcmErr) {
        console.error(`[SOCKET] listener_call:initiate: Ã¢Å“â€” FCM Push failed:`, fcmErr.message);
      }
    }
  });

  // Accept call for either direction: user -> listener or listener -> user.
  socket.on('call:accept', async (data) => {
    const { callId, callerId } = data;
    console.log(`[SOCKET] call:accept: Call ${callId} accepted by ${socket.userId}`);

    const pending = clearPendingCall(callId);

    let listenerUserId = pending?.listenerUserId || null;
    if (!listenerUserId && callId) {
      try {
        const call = await Call.findById(callId);
        if (call?.listener_id) {
          const listener = await Listener.findById(call.listener_id);
          listenerUserId = listener?.user_id || null;
        }
      } catch (err) {
        console.error('[SOCKET] call:accept lookup error:', err.message);
      }
    }

    // BUSY: Mark BOTH parties as busy in memory.
    [listenerUserId, callerId].forEach(uid => {
      if (!uid) return;
      busyUsers.set(uid, callId);
      io.emit('listener_busy_status', {
        listenerUserId: uid,
        busy: true,
      });
      console.log(`[SOCKET] call:accept: User/Listener ${uid} marked BUSY`);
    });

    if (listenerUserId) {
      Listener.findByUserId(listenerUserId)
        .then((listener) => {
          if (listener) {
            Listener.setBusy(listener.listener_id).catch((e) =>
              console.error('[SOCKET] setBusy DB error:', e.message),
            );
          }
        })
        .catch((e) =>
          console.error('[SOCKET] findByUserId for setBusy error:', e.message),
        );
    }

    const serverTimestamp = Date.now();
    const callerSocketId = connectedUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call:accepted', {
        callId,
        listenerId: listenerUserId || socket.userId,
        acceptedBy: socket.userId,
        serverTime: serverTimestamp,
      });
    } else {
      _clearBusyForCall(listenerUserId || socket.userId, callerId);
      socket.emit('call:ended', {
        callId,
        endedBy: callerId,
        reason: 'caller_unavailable',
      });
    }
  });

  // Reject call: Listener -> User
  socket.on('call:reject', (data) => {
    const { callId, callerId } = data;
    console.log(`[SOCKET] call:reject: Call ${callId} rejected by ${socket.userId}`);

    const pending = clearPendingCall(callId);
    const listenerUserId = pending?.listenerUserId || socket.userId;

    const callerSocketId = connectedUsers.get(callerId);
    if (callerSocketId) {
      io.to(callerSocketId).emit('call:rejected', {
        callId,
        listenerId: listenerUserId,
        rejectedBy: socket.userId,
      });
    }
  });

  // Joined call channel (for both parties)
  socket.on('call:joined', (data) => {
    const { callId, channelName } = data;
    const userId = socket.userId;
    if (!userId) return;

    console.log(`[SOCKET] User ${userId} joined channel ${channelName}`);
    
    if (!activeChannels.has(channelName)) {
      activeChannels.set(channelName, new Set());
    }
    activeChannels.get(channelName).add(userId);
    
    const usersInChannel = activeChannels.get(channelName);
    if (usersInChannel.size >= 2 && callId) {
      // Dedup: prevent double execution when both parties race to this point
      // (both call:joined events can see size >= 2 near-simultaneously)
      if (activeCallTimers.has(callId) || processingCalls.has(String(callId))) {
        console.log(`[SOCKET] call:joined: Call ${callId} already tracked/processing, skipping duplicate`);
        return;
      }
      processingCalls.add(String(callId));

      console.log(`[SOCKET] Both parties in ${channelName}, starting server-tracked call ${callId}`);

      // Snapshot channel users for use in async callback / timer
      const channelUsers = new Set(usersInChannel);

      // Server-authoritative call start: mark started_at and calculate max duration
      (async () => {
        try {
          const callData = await markCallStarted(callId);
          if (!callData) {
            const serverStartTimeMs = Date.now();
            console.error(`[SOCKET] Failed to mark call ${callId} as started`);
            channelUsers.forEach(uid => {
              const sid = connectedUsers.get(uid);
              if (sid) io.to(sid).emit('call:connected', { callId, channelName, maxAllowedSeconds: 0, serverStartTimeMs });
            });
            return;
          }

          const normalRate = Number(
            callData.billed_user_rate_per_min || callData.rate_per_minute || 0
          );
          const { maxAllowedSeconds, balance } = await calculateMaxCallDuration(
            callData.caller_id,
            {
              normalRate,
              fallbackRate: Number(callData.rate_per_minute || 0),
              offerApplied: callData.offer_applied === true,
              offerMinutesLimit: Number(callData.offer_minutes_limit || 0),
              offerFlatPrice: Number(callData.offer_flat_price || 0),
            }
          );

          console.log(`[SOCKET] Call ${callId}: rate=\u20b9${normalRate}/min, balance=\u20b9${balance}, maxAllowed=${maxAllowedSeconds}s`);

          const serverStartTimeMs = Date.now();

          // Emit call:connected with max duration to both parties
          channelUsers.forEach(uid => {
            const sid = connectedUsers.get(uid);
            if (sid) {
              io.to(sid).emit('call:connected', {
                callId,
                channelName,
                maxAllowedSeconds,
                serverStartTimeMs,
                ratePerMinute: normalRate
              });
            }
          });

          // Server-side auto-disconnect timer
          if (maxAllowedSeconds > 0) {
            // Add 3-second grace period for network latency
            const timerMs = (maxAllowedSeconds + 3) * 1000;
            const timerId = setTimeout(async () => {
              console.log(`[SOCKET] Call ${callId}: max duration reached (${maxAllowedSeconds}s), auto-ending`);
              activeCallTimers.delete(callId);

              // Notify both parties to disconnect
              channelUsers.forEach(uid => {
                const sid = connectedUsers.get(uid);
                if (sid) {
                  io.to(sid).emit('call:ended', {
                    callId,
                    channelName,
                    reason: 'balance_exhausted',
                    code: 'MAX_DURATION_REACHED'
                  });
                }
              });

              // Trigger billing from server as safety net
              try {
                await billingFinalize({ callId, durationSeconds: maxAllowedSeconds });
                console.log(`[SOCKET] Call ${callId}: server-triggered billing completed`);
              } catch (billingErr) {
                console.error(`[SOCKET] Call ${callId}: server-triggered billing error:`, billingErr.message);
              }

              // Clear busy status for both parties
              channelUsers.forEach(uid => {
                if (busyUsers.has(uid)) {
                  busyUsers.delete(uid);
                  io.emit('listener_busy_status', { listenerUserId: uid, busy: false });
                  Listener.clearBusyByUserId(uid).catch(e => console.error('[SOCKET] clearBusy timer error:', e.message));
                }
              });

              // Clean up channel
              activeChannels.delete(channelName);
            }, timerMs);

            // Find listener's userId from channel participants (not the caller)
            const listenerUserId = [...channelUsers].find(uid => String(uid) !== String(callData.caller_id)) || null;

            activeCallTimers.set(callId, {
              timerId,
              callerId: callData.caller_id,
              listenerUserId,
              channelName,
              startedAt: Date.now(),
              maxAllowedSeconds
            });
            console.log(`[SOCKET] Call ${callId}: auto-disconnect timer set for ${maxAllowedSeconds + 3}s`);
          } else {
            // Zero balance Ã¢â‚¬â€ disconnect immediately
            console.log(`[SOCKET] Call ${callId}: zero allowed duration, disconnecting immediately`);
            channelUsers.forEach(uid => {
              const sid = connectedUsers.get(uid);
              if (sid) {
                io.to(sid).emit('call:ended', {
                  callId,
                  channelName,
                  reason: 'balance_exhausted',
                  code: 'ZERO_BALANCE'
                });
              }
            });
          }
        } catch (err) {
          console.error(`[SOCKET] Error in call:joined handler for call ${callId}:`, err);
          const serverStartTimeMs = Date.now();
          // Still emit call:connected without max duration as fallback
          channelUsers.forEach(uid => {
            const sid = connectedUsers.get(uid);
            if (sid) io.to(sid).emit('call:connected', { callId, channelName, maxAllowedSeconds: 0, serverStartTimeMs });
          });
        } finally {
          processingCalls.delete(String(callId));
        }
      })();
    }
  });

  // End call
  socket.on('call:end', (data) => {
    const { callId, otherUserId, reason } = data || {};
    const endedBy = socket.userId;
    const endReason = reason || 'call_ended';
    console.log(`[SOCKET] call:end: Call ${callId} ended by ${endedBy} (${endReason})`);
    
    // Clear server-side auto-disconnect timer & capture data for safety billing
    let endTimerData = null;
    if (callId && activeCallTimers.has(callId)) {
      endTimerData = activeCallTimers.get(callId);
      clearTimeout(endTimerData.timerId);
      activeCallTimers.delete(callId);
      console.log(`[SOCKET] call:end: Cleared auto-disconnect timer for call ${callId}`);
    }
    
    // BUSY: Clear busy for both parties (whichever is the listener)
    _clearBusyForCall(endedBy, otherUserId);

    const notifiedSocketIds = new Set();
    const notifyCallEnded = (targetUserId, extra = {}) => {
      if (!targetUserId || String(targetUserId) === String(endedBy)) return;
      const targetSocketId = connectedUsers.get(targetUserId) || listenerSockets.get(targetUserId);
      if (!targetSocketId || notifiedSocketIds.has(targetSocketId)) return;

      notifiedSocketIds.add(targetSocketId);
      io.to(targetSocketId).emit('call:ended', {
        callId,
        endedBy,
        reason: endReason,
        ...extra
      });
    };
    
    // 1. Try direct otherUserId path (for connected calls)
    notifyCallEnded(otherUserId);
    
    // 2. Check pendingCalls Ã¢â‚¬â€ caller cancelled BEFORE listener answered
    const pending = pendingCalls.get(callId);
    if (pending) {
      clearPendingCall(callId);
      notifyCallEnded(pending.calleeUserId, {
        reason: endReason || 'caller_cancelled',
      });
      console.log(
        `[SOCKET] call:end: Cancelled pending call ${callId}, notified callee ${pending.calleeUserId}`,
      );
    }

    // 3. Notify and remove every participant still tracked in the active channel.
    const candidateChannelNames = new Set();
    if (endTimerData?.channelName) candidateChannelNames.add(endTimerData.channelName);
    if (callId) candidateChannelNames.add(callId);

    for (const [channelName, users] of activeChannels.entries()) {
      if (candidateChannelNames.has(channelName) || users.has(endedBy) || users.has(otherUserId)) {
        users.forEach(uid => notifyCallEnded(uid, { channelName }));
        activeChannels.delete(channelName);
        console.log(`[SOCKET] call:end: Cleared active channel ${channelName}`);
      }
    }

    // 4. Safety billing: ensure billing happens even if frontend POST /api/calls/end fails
    //    billingFinalize is idempotent (checks call_records for existing billing)
    if (callId && endTimerData) {
      (async () => {
        try {
          const elapsed = Math.max(0, Math.round((Date.now() - endTimerData.startedAt) / 1000));
          const billDuration = Math.min(elapsed, endTimerData.maxAllowedSeconds);
          if (billDuration > 0) {
            await billingFinalize({ callId, durationSeconds: billDuration });
            console.log(`[SOCKET] call:end: Safety billing for call ${callId} (${billDuration}s)`);
          }
        } catch (e) {
          console.error(`[SOCKET] call:end: Safety billing error for call ${callId}:`, e.message);
        }
      })();
    }
  });

  // Leave channel
  socket.on('call:left', (data) => {
    const { channelName } = data;
    if (activeChannels.has(channelName) && socket.userId) {
      activeChannels.get(channelName).delete(socket.userId);
      if (activeChannels.get(channelName).size === 0) {
        activeChannels.delete(channelName);
      }
    }
  });

  // ============================================
  // 2.5 CHAT HANDLING (Real-time messaging)
  // ============================================

  // Join a chat room
  socket.on('chat:join', async (data) => {
    const { chatId, isActivelyViewing = true } = data || {};
    if (!chatId || !socket.userId) {
      console.log(`[SOCKET] chat:join failed - missing chatId or userId`);
      return;
    }

    // Join the Socket.IO room for this chat
    socket.join(`chat_${chatId}`);
    socket.chatRooms = socket.chatRooms || new Set();
    socket.chatRooms.add(chatId);
    
    // WhatsApp-style: Track which chat user is actively viewing
    if (isActivelyViewing) {
      const state = userChatState.get(socket.userId) || { appState: 'foreground' };
      state.activelyViewingChatId = chatId;
      userChatState.set(socket.userId, state);
    }
    
    console.log(`[SOCKET] User ${socket.userId} joined chat room: ${chatId} (activelyViewing: ${isActivelyViewing})`);

    // Fetch and send chat history
    try {
      const messages = await Message.getChatMessages(chatId, 50, 0);
      // FIX: Ensure all message timestamps are UTC ISO strings for consistent client parsing
      const normalizedMessages = messages.map(msg => ({
        ...msg,
        created_at: msg.created_at instanceof Date
          ? msg.created_at.toISOString()
          : msg.created_at,
        read_at: msg.read_at instanceof Date
          ? msg.read_at.toISOString()
          : msg.read_at,
      }));
      socket.emit('chat:history', {
        chatId,
        messages: normalizedMessages,
        count: normalizedMessages.length
      });
    } catch (error) {
      console.error(`[SOCKET] Error fetching chat history:`, error);
      socket.emit('chat:error', { error: 'Failed to fetch chat history' });
    }
  });

  // Leave a chat room
  socket.on('chat:leave', (data) => {
    const { chatId } = data || {};
    if (!chatId) return;

    socket.leave(`chat_${chatId}`);
    if (socket.chatRooms) {
      socket.chatRooms.delete(chatId);
    }
    
    // WhatsApp-style: Clear actively viewing state
    const state = userChatState.get(socket.userId);
    if (state && state.activelyViewingChatId === chatId) {
      state.activelyViewingChatId = null;
      userChatState.set(socket.userId, state);
    }
    
    console.log(`[SOCKET] User ${socket.userId} left chat room: ${chatId}`);
  });

  // WhatsApp-style: Update which chat user is actively viewing
  socket.on('chat:set_active_viewing', (data) => {
    const { chatId, isActivelyViewing } = data || {};
    if (!socket.userId) return;
    
    const state = userChatState.get(socket.userId) || { appState: 'foreground' };
    state.activelyViewingChatId = isActivelyViewing ? chatId : null;
    userChatState.set(socket.userId, state);
    
    console.log(`[SOCKET] User ${socket.userId} set actively viewing: ${chatId || 'none'}`);
  });

  // WhatsApp-style: Track app foreground/background state
  socket.on('user:app_state', (data) => {
    const { userId, state: appState, activelyViewingChatId } = data || {};
    if (!userId) return;
    
    const chatState = userChatState.get(userId) || {};
    chatState.appState = appState || 'foreground';
    
    // Also update actively viewing chat if provided
    if (appState === 'background') {
      chatState.activelyViewingChatId = null; // Not viewing any chat when in background
    } else if (activelyViewingChatId !== undefined) {
      chatState.activelyViewingChatId = activelyViewingChatId;
    }
    
    userChatState.set(userId, chatState);

    if (appState === 'background') {
      _markUserOffline(userId, 'background');
      if (socket.listenerUserId === userId || listenerSockets.get(userId) === socket.id) {
        _markListenerOffline(userId, 'background');
      }
    } else if (appState === 'foreground') {
      const wasForeground = connectedUsers.get(userId) === socket.id;
      socket.userId = userId;
      connectedUsers.set(userId, socket.id);
      lastSeenMap.set(userId, Date.now());
      socket.join(`user_${userId}`);
      if (presenceTimeouts.has(userId)) {
        clearTimeout(presenceTimeouts.get(userId));
        presenceTimeouts.delete(userId);
      }
      if (!wasForeground) {
        io.emit('user:online', { userId, timestamp: Date.now() });
      }
    }

    console.log(`[SOCKET] User ${userId} app state: ${appState}, activeChat: ${chatState.activelyViewingChatId || 'none'}`);
  });

  // Send a message in a chat
  socket.on('chat:send', async (data) => {
    const { chatId, content, messageType = 'text', mediaUrl } = data || {};
    
    if (!chatId || !content || !socket.userId) {
      console.log(`[SOCKET] chat:send failed - missing required fields`);
      socket.emit('chat:error', { error: 'Missing required fields' });
      return;
    }

    try {
      const chat = await Chat.findById(chatId);
      if (!chat) {
        socket.emit('chat:error', { error: 'Chat not found' });
        return;
      }

      if (chat.user1_id !== socket.userId && chat.user2_id !== socket.userId) {
        socket.emit('chat:error', { error: 'Forbidden' });
        return;
      }

      const otherUserId = chat.user1_id === socket.userId ? chat.user2_id : chat.user1_id;

      // CHAT CHARGING: Check if user should be charged for this message
      // Uses GLOBAL per-user counters (not per-chat) Ã¢â‚¬â€ survives chat clear/delete
      try {
        const chargeResult = await ChatChargeConfig.checkAndCharge(socket.userId);
        if (!chargeResult.allowed) {
          console.log(`[SOCKET] Message blocked for user ${socket.userId}: ${chargeResult.reason}`);
          socket.emit('chat:error', {
            status: 'failed',
            message: chargeResult.message || 'Insufficient balance. Please recharge.',
            code: chargeResult.reason || 'LOW_BALANCE',
            remainingFreeMessages: chargeResult.remainingFreeMessages ?? 0,
            totalMessagesSent: chargeResult.totalMessagesSent ?? 0
          });
          return;
        }
        if (chargeResult.charged) {
          console.log(`[SOCKET] Charged user ${socket.userId} Ã¢â€šÂ¹${chargeResult.chargeAmount} for chat message`);
        }
      } catch (chargeError) {
        console.error('[SOCKET] Chat charge check error:', chargeError);
        // On charging system error, allow message through (fail-open)
      }

      // Save message to database (Chat & Message already imported at module level)
      const message = await Message.create({
        chat_id: chatId,
        sender_id: socket.userId,
        message_type: messageType,
        message_content: content,
        media_url: mediaUrl
      });

      // Look up sender's display info from DB (prefer listener profile over Google data)
      let senderName = socket.userName || 'Unknown';
      let senderAvatar = socket.userAvatar;
      try {
        const senderInfoResult = await pool.query(
          `SELECT COALESCE(l.professional_name, u.display_name) as sender_name,
                  COALESCE(l.profile_image, u.avatar_url) as sender_avatar
           FROM users u
           LEFT JOIN listeners l ON u.user_id = l.user_id
           WHERE u.user_id = $1`,
          [socket.userId]
        );
        if (senderInfoResult.rows.length > 0) {
          senderName = senderInfoResult.rows[0].sender_name || senderName;
          senderAvatar = senderInfoResult.rows[0].sender_avatar || senderAvatar;
        }
      } catch (lookupErr) {
        console.error('[SOCKET] Sender info lookup failed, using socket data:', lookupErr.message);
      }

      const messageData = {
        chatId,
        message: {
          ...message,
          // FIX: Ensure created_at is always a UTC ISO string for consistent client parsing
          // The pg type parser in db.js now returns ISO strings, but this is defense-in-depth
          created_at: message.created_at instanceof Date
            ? message.created_at.toISOString()
            : message.created_at,
          sender_name: senderName,
          sender_avatar: senderAvatar
        }
      };

      // Broadcast message to all users in the chat room IMMEDIATELY (real-time UI update)
      console.log(`[SOCKET] chat:send timestamp debug: raw=${message.created_at}, type=${typeof message.created_at}, isDate=${message.created_at instanceof Date}, final=${messageData.message.created_at}`);
      io.to(`chat_${chatId}`).emit('chat:message', messageData);

      // Send notification to offline/non-viewing users asynchronously (don't block)
      Promise.resolve(chat).then(chatData => {
        if (chatData) {
          const otherUserState = userChatState.get(otherUserId);
          
          const isOtherUserViewingThisChat = otherUserState && 
            otherUserState.appState === 'foreground' && 
            otherUserState.activelyViewingChatId === chatId;
          
          if (!isOtherUserViewingThisChat) {
            io.to(`user_${otherUserId}`).emit('chat:new_message_notification', messageData);
            console.log(`[SOCKET] Sent notification to user_${otherUserId}`);
          }
        }
      }).catch(err => console.error('[SOCKET] Notification error:', err));

      console.log(`[SOCKET] Message sent in chat ${chatId} by ${socket.userId}`);
    } catch (error) {
      console.error(`[SOCKET] Error sending message:`, error.message || error);
      console.error(`[SOCKET] Error stack:`, error.stack);
      socket.emit('chat:error', { error: `Failed to send message: ${error.message || 'Unknown error'}` });
    }
  });

  // Typing indicator
  socket.on('chat:typing', (data) => {
    const { chatId, isTyping } = data || {};
    if (!chatId || !socket.userId) return;

    // Broadcast typing status to others in the chat room (not the sender)
    socket.to(`chat_${chatId}`).emit('chat:user_typing', {
      chatId,
      userId: socket.userId,
      userName: socket.userName || 'Unknown',
      isTyping: isTyping === true
    });
  });

  // Mark messages as read
  socket.on('chat:read', async (data) => {
    const { chatId } = data || {};
    if (!chatId || !socket.userId) return;

    try {
      await Message.markAsRead(chatId, socket.userId);
      
      // Notify the other user that messages were read
      socket.to(`chat_${chatId}`).emit('chat:messages_read', {
        chatId,
        readBy: socket.userId
      });
    } catch (error) {
      console.error(`[SOCKET] Error marking messages as read:`, error);
    }
  });

  // WhatsApp-style: Delete message for everyone
  // This permanently deletes from DB and broadcasts to both users
  // Backend does NOT store placeholder text - that's client-side only
  socket.on('delete_message', async (data) => {
    const { messageId, chatId, senderId, receiverId } = data || {};
    
    if (!messageId || !senderId) {
      console.log(`[SOCKET] delete_message failed - missing messageId or senderId`);
      socket.emit('chat:error', { error: 'Missing required fields for delete' });
      return;
    }

    try {
      // Delete message from database (validates sender ownership)
      const result = await Message.delete(messageId, senderId);
      
      if (!result.success) {
        console.log(`[SOCKET] delete_message failed: ${result.error}`);
        socket.emit('chat:error', { error: result.error });
        return;
      }

      console.log(`[SOCKET] Message ${messageId} deleted from DB by ${senderId}`);

      // Broadcast delete event to all users in the chat room
      // Both sender and receiver will save this locally and show placeholder
      const deleteData = {
        messageId,
        chatId: result.chatId || chatId,
        deletedBy: senderId
      };

      // Emit to chat room (for users currently in the chat)
      io.to(`chat_${chatId}`).emit('message:deleted', deleteData);
      
      // Also emit to both users' personal rooms (in case they're not in chat room)
      io.to(`user_${senderId}`).emit('message:deleted', deleteData);
      if (receiverId) {
        io.to(`user_${receiverId}`).emit('message:deleted', deleteData);
      }

      console.log(`[SOCKET] Delete event broadcast for message ${messageId}`);
    } catch (error) {
      console.error(`[SOCKET] Error deleting message:`, error);
      socket.emit('chat:error', { error: 'Failed to delete message' });
    }
  });

  // 3. DISCONNECTION

  socket.on('disconnect', () => {
    const userId = socket.userId;
    const listenerUserId = socket.listenerUserId;

    console.log(`[SOCKET] Disconnected: ${socket.id} (User: ${userId}, Listener: ${listenerUserId})`);

    // Clear any active call timers for this user's calls (matches both caller and listener)
    for (const [callId, timerData] of activeCallTimers.entries()) {
      const isCaller = String(timerData.callerId) === String(userId);
      const isListener = timerData.listenerUserId && String(timerData.listenerUserId) === String(userId);
      if (isCaller || isListener) {
        clearTimeout(timerData.timerId);
        activeCallTimers.delete(callId);
        console.log(`[SOCKET] disconnect: Cleared timer for call ${callId} (${isCaller ? 'caller' : 'listener'} disconnected)`);
        // Trigger billing safety net for disconnected calls
        (async () => {
          try {
            const elapsed = Math.max(0, Math.round((Date.now() - timerData.startedAt) / 1000));
            const billDuration = Math.min(elapsed, timerData.maxAllowedSeconds);
            if (billDuration > 0) {
              await billingFinalize({ callId, durationSeconds: billDuration });
              console.log(`[SOCKET] disconnect: Safety billing for call ${callId} (${billDuration}s)`);
            }
          } catch (e) {
            console.error(`[SOCKET] disconnect: Safety billing error for call ${callId}:`, e.message);
          }
        })();
      }
    }

    // Handle listener cleanup
    if (listenerUserId && listenerSockets.get(listenerUserId) === socket.id) {
      listenerSockets.delete(listenerUserId);
      io.emit('listener_status', { listenerUserId, online: false, timestamp: Date.now() });
      console.log(`[SOCKET] Listener marked offline: ${listenerUserId}`);
      
      // BUSY: Clear busy on disconnect (safety net)
      if (busyUsers.has(listenerUserId)) {
        busyUsers.delete(listenerUserId);
        io.emit('listener_busy_status', { listenerUserId, busy: false });
        console.log(`[SOCKET] Listener ${listenerUserId} busy cleared on disconnect`);
        Listener.clearBusyByUserId(listenerUserId).catch(e => console.error('[SOCKET] clearBusyByUserId on disconnect error:', e.message));
      }
    }

    // Handle user cleanup and active calls
    if (userId) {
      // BUSY: Clear busy if this userId is a busy listener (covers both listenerUserId and userId)
      if (busyUsers.has(userId)) {
        busyUsers.delete(userId);
        io.emit('listener_busy_status', { listenerUserId: userId, busy: false });
        console.log(`[SOCKET] User ${userId} busy cleared on disconnect (userId path)`);
        Listener.clearBusyByUserId(userId).catch(e => console.error('[SOCKET] clearBusyByUserId on disconnect error:', e.message));
      }

      // PENDING CALLS: If this user was a caller who disconnected during ringing,
      // notify the callee and clean up.
      for (const [callId, pending] of pendingCalls.entries()) {
        if (String(pending.initiatorUserId) === String(userId)) {
          console.log(`[SOCKET] Caller ${userId} disconnected during pending call ${callId}, notifying callee`);
          if (pending.calleeSocketId) {
            io.to(pending.calleeSocketId).emit('call:ended', {
              callId,
              endedBy: userId,
              reason: 'caller_disconnected',
            });
          }
          clearPendingCall(callId);
        }
      }

      // Notify others in active channels
      for (const [channelName, users] of activeChannels.entries()) {
        if (users.has(userId)) {
          users.forEach(otherUid => {
            if (otherUid !== userId) {
              const otherSid = connectedUsers.get(otherUid);
              if (otherSid) {
                io.to(otherSid).emit('call:ended', {
                  callId: channelName,
                  endedBy: userId,
                  reason: 'peer_disconnected'
                });
              }
            }
          });
          users.delete(userId);
          if (users.size === 0) activeChannels.delete(channelName);
        }
      }

      // Debounce offline status. If this socket was already removed from
      // foreground presence by app backgrounding, do not emit a duplicate
      // offline event on the eventual disconnect.
      if (connectedUsers.get(userId) === socket.id) {
        if (presenceTimeouts.has(userId)) {
          clearTimeout(presenceTimeouts.get(userId));
        }

        const timeoutId = setTimeout(async () => {
          const lastSeen = lastSeenMap.get(userId) || 0;
          if (Date.now() - lastSeen > 1000) {
            _markUserOffline(userId, 'disconnect');
            userChatState.delete(userId); // Clean up chat state on disconnect
          }
        }, 1000);

        presenceTimeouts.set(userId, timeoutId);
      }
    }
  });
});

const NOTIFICATION_QUEUE_POLL_MS = 15 * 1000;



// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(config.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = config.PORT;

async function startServer() {
  try {
    // Test database connection Ã¢â‚¬â€ retry up to 10 times (30s apart) so the
    // container doesn't crash-loop while waiting for Postgres to be ready.
    console.log('Ã°Å¸â€â€” Connecting to PostgreSQL...');
    let connected = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      connected = await testConnection();
      if (connected) break;
      console.error(`Ã¢ÂÅ’ DB connection attempt ${attempt}/10 failed. Retrying in 30s...`);
      await new Promise(r => setTimeout(r, 30000));
    }
    if (!connected) {
      console.error('Ã¢ÂÅ’ Could not connect to database after 10 attempts. Exiting...');
      process.exit(1);
    }

    // Ensure schema has required columns (safe, idempotent)
    try {
      await ensureSchema();
    } catch (err) {
      console.error('Ã¢ÂÅ’ Failed to ensure database schema:', err.message);
      process.exit(1);
    }

    // PRODUCTION SAFETY: Clear all stale is_busy flags on startup.
    // If the server crashed or restarted, listeners may be stuck as busy.
    try {
      const { pool: startupPool } = await import('./db.js');
      const cleared = await startupPool.query(
        `UPDATE listeners SET is_busy = FALSE WHERE is_busy = TRUE RETURNING listener_id`
      );
      if (cleared.rowCount > 0) {
        console.log(`Ã°Å¸Â§Â¹ Cleared ${cleared.rowCount} stale busy flag(s) on startup:`, cleared.rows.map(r => r.listener_id));
      }
    } catch (err) {
      console.error('Ã¢Å¡Â Ã¯Â¸Â  Failed to clear stale busy flags:', err.message);
    }

    const listenWithFallback = (initialPort, attempts = 8) =>
      new Promise((resolve, reject) => {
        let port = Number(initialPort) || 3002;
        let tries = 0;
        const tryListen = () => {
          const onError = (err) => {
            server.off('error', onError);
            if (err && err.code === 'EADDRINUSE' && tries < attempts - 1) {
              port += 1;
              tries += 1;
              tryListen();
            } else {
              reject(err);
            }
          };
          server.once('error', onError);
          server.listen(port, () => {
            server.off('error', onError);
            resolve(port);
          });
        };
        tryListen();
      });

    const boundPort = await listenWithFallback(PORT, 8);
    console.log('\n' + '='.repeat(50));
    console.log(`Ã°Å¸Å¡â‚¬ Dost Talk Backend Server`);
    console.log(`Ã°Å¸â€œÂ¡ Environment: ${config.NODE_ENV}`);
    console.log(`Ã°Å¸Å’Â Server running on port ${boundPort}`);
    console.log(`Ã°Å¸â€Å’ Socket.IO ready for connections`);
    console.log(`Ã°Å¸â€œÅ  API endpoints available at http://localhost:${boundPort}/api`);
    console.log('='.repeat(50) + '\n');

    // Notify PM2 that the process is ready to receive traffic (for cluster mode)
    if (process.send) {
      process.send('ready');
    }

    setNotificationEmitter(io);

    processNotifications().catch((err) => {
      console.error('processNotifications startup error:', err.message);
    });
    bootstrapScheduledNotifications().catch((err) => {
      console.error('bootstrapScheduledNotifications startup error:', err.message);
    });

    setInterval(() => {
      processNotifications().catch((err) => {
        console.error('processNotifications fatal error:', err.message);
      });
    }, NOTIFICATION_QUEUE_POLL_MS);
  } catch (error) {
    console.error('Ã¢ÂÅ’ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nÃ°Å¸â€ºâ€˜ SIGTERM signal received: closing server gracefully');
  server.close(() => {
    console.log('Ã¢Å“â€œ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\nÃ°Å¸â€ºâ€˜ SIGINT signal received: closing server gracefully');
  server.close(() => {
    console.log('Ã¢Å“â€œ Server closed');
    process.exit(0);
  });
});

export { app, server, io };



















// import express from 'express';
// import http from 'http';
// import { Server } from 'socket.io';
// import cors from 'cors';
// import helmet from 'helmet';
// import morgan from 'morgan';
// import compression from 'compression';
// import rateLimit from 'express-rate-limit';
// import config from './config/config.js';
// import { testConnection, ensureSchema } from './db.js';
// // Initialize Express app
// const app = express();
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: config.cors,
//   pingTimeout: config.socketIO.pingTimeout,
//   pingInterval: config.socketIO.pingInterval
// });

// // Import routes
// import authRoutes from './routes/auth.js';
// import userRoutes from './routes/users.js';
// import listenerRoutes from './routes/listeners.js';
// import callRoutes from './routes/calls.js';
// import chatRoutes from './routes/chats.js';
// import adminRoutes from './routes/admin.js';
// import User from './models/User.js';

// // ============================================
// // MIDDLEWARE
// // ============================================

// // Security middleware
// app.use(helmet());

// // CORS
// app.use(cors(config.cors));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Compression
// app.use(compression());

// // Logging
// if (config.NODE_ENV === 'development') {
//   app.use(morgan('dev'));
// } else {
//   app.use(morgan('combined'));
// }

// // Rate limiting
// const limiter = rateLimit({
//   windowMs: config.rateLimit.windowMs,
//   max: config.rateLimit.max,
//   message: 'Too many requests from this IP, please try again later.'
// });
// app.use('/api/', limiter);

// // ============================================
// // ROUTES
// // ============================================

// // Health check
// app.get('/', (req, res) => {
//   res.json({
//     message: 'Dost Talk API Server',
//     version: '1.0.0',
//     status: 'running'
//   });
// });

// // API health check
// app.get('/api/health', async (req, res) => {
//   try {
//     const dbConnected = await testConnection();
//     res.json({
//       status: 'healthy',
//       database: dbConnected ? 'connected' : 'disconnected',
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     res.status(500).json({
//       status: 'unhealthy',
//       error: error.message
//     });
//   }
// });

// // Mount API routes
// app.use('/api/auth', authRoutes);
// app.use('/api/users', userRoutes);
// app.use('/api/listeners', listenerRoutes);
// app.use('/api/calls', callRoutes);
// app.use('/api/chats', chatRoutes);
// app.use('/api/admin', adminRoutes);

// // ============================================
// // SOCKET.IO - REAL-TIME FEATURES
// // ============================================



// // In-memory maps
// const connectedUsers = new Map(); // Map of userId -> socketId
// const listenerSockets = new Map(); // Map of listenerUserId -> socketId
// const activeChannels = new Map(); // Map of channelName -> Set of userIds in channel
// const lastSeenMap = new Map(); // Map of userId -> timestamp
// const presenceTimeouts = new Map(); // Map of userId -> timeoutId

// // Socket.IO connection handler
// io.on('connection', (socket) => {
//   console.log(`[SOCKET] Connected: ${socket.id}`);

//   // 1. IDENTITY & PRESENCE
  
//   // User joins (can be regular user or listener)
//   socket.on('user:join', (userId) => {
//     if (!userId) return;
//     socket.userId = userId;
//     connectedUsers.set(userId, socket.id);
//     lastSeenMap.set(userId, Date.now());
    
//     // Clear any pending offline timeout
//     if (presenceTimeouts.has(userId)) {
//       clearTimeout(presenceTimeouts.get(userId));
//       presenceTimeouts.delete(userId);
//     }
    
//     io.emit('user:online', { userId });
//     console.log(`[SOCKET] User joined: ${userId}`);

//     // Send current online listeners to the newly joined user
//     const onlineListeners = Array.from(listenerSockets.keys());
//     socket.emit('listeners:initial_status', onlineListeners);
//   });

//   // Listener specific join (for availability tracking)
//   socket.on('listener:join', (listenerUserId) => {
//     if (!listenerUserId) return;
//     socket.userId = listenerUserId; // Sync with userId
//     socket.listenerUserId = listenerUserId;
    
//     // Remove old socket if exists to prevent ghost sessions
//     if (listenerSockets.has(listenerUserId)) {
//       const oldSocketId = listenerSockets.get(listenerUserId);
//       if (oldSocketId && oldSocketId !== socket.id) {
//         const oldSocket = io.sockets.sockets.get(oldSocketId);
//         if (oldSocket) oldSocket.disconnect(true);
//       }
//     }
    
//     listenerSockets.set(listenerUserId, socket.id);
//     connectedUsers.set(listenerUserId, socket.id); // Also ensure in connectedUsers
    
//     io.emit('listener_status', { listenerUserId, online: true, timestamp: Date.now() });
//     console.log(`[SOCKET] Listener joined: ${listenerUserId}`);
//   });

//   // Explicit offline event
//   socket.on('listener:offline', (data) => {
//     const { listenerUserId } = data || {};
//     if (listenerUserId) {
//       listenerSockets.delete(listenerUserId);
//       io.emit('listener_status', { listenerUserId, online: false, timestamp: Date.now() });
//       console.log(`[SOCKET] Listener offline: ${listenerUserId}`);
//     }
//   });

//   // 2. CALL HANDLING

//   // Initiate call: User -> Listener
//   socket.on('call:initiate', (data) => {
//     const { listenerId, ...callData } = data || {};
//     // Check both maps for the listener's socket
//     const listenerSocketId = listenerSockets.get(listenerId) || connectedUsers.get(listenerId);
    
//     if (listenerSocketId) {
//       io.to(listenerSocketId).emit('incoming-call', callData);
//       console.log(`[SOCKET] call:initiate: Forwarded to listener ${listenerId}`);
//     } else {
//       console.log(`[SOCKET] call:initiate: Listener ${listenerId} NOT online`);
//       // Optionally notify the caller that the listener is offline
//       socket.emit('call:failed', { callId: callData.callId, reason: 'listener_offline' });
//     }
//   });

//   // Accept call: Listener -> User
//   socket.on('call:accept', (data) => {
//     const { callId, callerId } = data;
//     console.log(`[SOCKET] call:accept: Call ${callId} accepted by ${socket.userId}`);
//     const callerSocketId = connectedUsers.get(callerId);
//     if (callerSocketId) {
//       io.to(callerSocketId).emit('call:accepted', {
//         callId,
//         listenerId: socket.userId
//       });
//     }
//   });

//   // Reject call: Listener -> User
//   socket.on('call:reject', (data) => {
//     const { callId, callerId } = data;
//     console.log(`[SOCKET] call:reject: Call ${callId} rejected by ${socket.userId}`);
//     const callerSocketId = connectedUsers.get(callerId);
//     if (callerSocketId) {
//       io.to(callerSocketId).emit('call:rejected', {
//         callId,
//         listenerId: socket.userId
//       });
//     }
//   });

//   // Joined call channel (for both parties)
//   socket.on('call:joined', (data) => {
//     const { callId, channelName } = data;
//     const userId = socket.userId;
//     if (!userId) return;

//     console.log(`[SOCKET] User ${userId} joined channel ${channelName}`);
    
//     if (!activeChannels.has(channelName)) {
//       activeChannels.set(channelName, new Set());
//     }
//     activeChannels.get(channelName).add(userId);
    
//     const usersInChannel = activeChannels.get(channelName);
//     if (usersInChannel.size >= 2) {
//       console.log(`[SOCKET] Both parties in ${channelName}, emitting call:connected`);
//       usersInChannel.forEach(uid => {
//         const sid = connectedUsers.get(uid);
//         if (sid) {
//           io.to(sid).emit('call:connected', { callId, channelName });
//         }
//       });
//     }
//   });

//   // End call
//   socket.on('call:end', (data) => {
//     const { callId, otherUserId } = data;
//     console.log(`[SOCKET] call:end: Call ${callId} ended by ${socket.userId}`);
//     const otherSocketId = connectedUsers.get(otherUserId);
//     if (otherSocketId) {
//       io.to(otherSocketId).emit('call:ended', {
//         callId,
//         endedBy: socket.userId
//       });
//     }
//   });

//   // Leave channel
//   socket.on('call:left', (data) => {
//     const { channelName } = data;
//     if (activeChannels.has(channelName) && socket.userId) {
//       activeChannels.get(channelName).delete(socket.userId);
//       if (activeChannels.get(channelName).size === 0) {
//         activeChannels.delete(channelName);
//       }
//     }
//   });

//   // 3. DISCONNECTION

//   socket.on('disconnect', () => {
//     const userId = socket.userId;
//     const listenerUserId = socket.listenerUserId;

//     console.log(`[SOCKET] Disconnected: ${socket.id} (User: ${userId}, Listener: ${listenerUserId})`);

//     // Handle listener cleanup
//     if (listenerUserId && listenerSockets.get(listenerUserId) === socket.id) {
//       listenerSockets.delete(listenerUserId);
//       io.emit('listener_status', { listenerUserId, online: false, timestamp: Date.now() });
//       console.log(`[SOCKET] Listener marked offline: ${listenerUserId}`);
//     }

//     // Handle user cleanup and active calls
//     if (userId) {
//       // Notify others in active channels
//       for (const [channelName, users] of activeChannels.entries()) {
//         if (users.has(userId)) {
//           users.forEach(otherUid => {
//             if (otherUid !== userId) {
//               const otherSid = connectedUsers.get(otherUid);
//               if (otherSid) {
//                 io.to(otherSid).emit('call:ended', {
//                   callId: channelName,
//                   endedBy: userId,
//                   reason: 'peer_disconnected'
//                 });
//               }
//             }
//           });
//           users.delete(userId);
//           if (users.size === 0) activeChannels.delete(channelName);
//         }
//       }

//       // Debounce offline status
//       if (presenceTimeouts.has(userId)) {
//         clearTimeout(presenceTimeouts.get(userId));
//       }
      
//       const timeoutId = setTimeout(async () => {
//         const lastSeen = lastSeenMap.get(userId) || 0;
//         if (Date.now() - lastSeen > 1000) {
//           connectedUsers.delete(userId);
//           lastSeenMap.delete(userId);
//           presenceTimeouts.delete(userId);
          
//           try {
//             // await User.updateLastSeen(userId); 
//           } catch (err) {}
          
//           io.emit('user:offline', { userId });
//           console.log(`[SOCKET] User ${userId} marked offline (debounce)`);
//         }
//       }, 1000);
      
//       presenceTimeouts.set(userId, timeoutId);
//     }
//   });
// });



// // ============================================
// // ERROR HANDLING
// // ============================================

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({
//     error: 'Route not found',
//     path: req.originalUrl
//   });
// });

// // Global error handler
// app.use((err, req, res, next) => {
//   console.error('Error:', err);
  
//   res.status(err.status || 500).json({
//     error: err.message || 'Internal server error',
//     ...(config.NODE_ENV === 'development' && { stack: err.stack })
//   });
// });

// // ============================================
// // SERVER STARTUP
// // ============================================

// const PORT = config.PORT;

// async function startServer() {
//   try {
//     // Test database connection
//     console.log('Ã°Å¸â€â€” Connecting to AWS RDS PostgreSQL...');
//     const connected = await testConnection();
    
//     if (!connected) {
//       console.error('Ã¢ÂÅ’ Failed to connect to database. Exiting...');
//       process.exit(1);
//     }

//     // Ensure schema has required columns (safe, idempotent)
//     try {
//       await ensureSchema();
//     } catch (err) {
//       console.error('Ã¢ÂÅ’ Failed to ensure database schema:', err.message);
//       process.exit(1);
//     }

//     // Start server
//     server.listen(PORT, () => {
//       console.log('\n' + '='.repeat(50));
//       console.log(`Ã°Å¸Å¡â‚¬ Dost Talk Backend Server`);
//       console.log(`Ã°Å¸â€œÂ¡ Environment: ${config.NODE_ENV}`);
//       console.log(`Ã°Å¸Å’Â Server running on port ${PORT}`);
//       console.log(`Ã°Å¸â€Å’ Socket.IO ready for connections`);
//       console.log(`Ã°Å¸â€œÅ  API endpoints available at http://localhost:${PORT}/api`);
//       console.log('='.repeat(50) + '\n');
//     });
//   } catch (error) {
//     console.error('Ã¢ÂÅ’ Failed to start server:', error);
//     process.exit(1);
//   }
// }

// // Start the server
// startServer();

// // Handle graceful shutdown
// process.on('SIGTERM', () => {
//   console.log('\nÃ°Å¸â€ºâ€˜ SIGTERM signal received: closing server gracefully');
//   server.close(() => {
//     console.log('Ã¢Å“â€œ Server closed');
//     process.exit(0);
//   });
// });

// process.on('SIGINT', () => {
//   console.log('\nÃ°Å¸â€ºâ€˜ SIGINT signal received: closing server gracefully');
//   server.close(() => {
//     console.log('Ã¢Å“â€œ Server closed');
//     process.exit(0);
//   });
// });

// export { app, server, io };import express from 'express';
// import http from 'http';
// import { Server } from 'socket.io';
// import cors from 'cors';
// import helmet from 'helmet';
// import morgan from 'morgan';
// import compression from 'compression';
// import rateLimit from 'express-rate-limit';
// import config from './config/config.js';
// import { testConnection, ensureSchema } from './db.js';
// // Initialize Express app
// const app = express();
// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: config.cors,
//   pingTimeout: config.socketIO.pingTimeout,
//   pingInterval: config.socketIO.pingInterval
// });

// // Import routes
// import authRoutes from './routes/auth.js';
// import userRoutes from './routes/users.js';
// import listenerRoutes from './routes/listeners.js';
// import callRoutes from './routes/calls.js';
// import chatRoutes from './routes/chats.js';
// import adminRoutes from './routes/admin.js';
// import User from './models/User.js';

// // ============================================
// // MIDDLEWARE
// // ============================================

// // Security middleware
// app.use(helmet());

// // CORS
// app.use(cors(config.cors));

// // Body parsing
// app.use(express.json({ limit: '10mb' }));
// app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// // Compression
// app.use(compression());

// // Logging
// if (config.NODE_ENV === 'development') {
//   app.use(morgan('dev'));
// } else {
//   app.use(morgan('combined'));
// }

// // Rate limiting
// const limiter = rateLimit({
//   windowMs: config.rateLimit.windowMs,
//   max: config.rateLimit.max,
//   message: 'Too many requests from this IP, please try again later.'
// });
// app.use('/api/', limiter);

// // ============================================
// // ROUTES
// // ============================================

// // Health check
// app.get('/', (req, res) => {
//   res.json({
//     message: 'Dost Talk API Server',
//     version: '1.0.0',
//     status: 'running'
//   });
// });

// // API health check
// app.get('/api/health', async (req, res) => {
//   try {
//     const dbConnected = await testConnection();
//     res.json({
//       status: 'healthy',
//       database: dbConnected ? 'connected' : 'disconnected',
//       timestamp: new Date().toISOString()
//     });
//   } catch (error) {
//     res.status(500).json({
//       status: 'unhealthy',
//       error: error.message
//     });
//   }
// });

// // Mount API routes
// app.use('/api/auth', authRoutes);
// app.use('/api/users', userRoutes);
// app.use('/api/listeners', listenerRoutes);
// app.use('/api/calls', callRoutes);
// app.use('/api/chats', chatRoutes);
// app.use('/api/admin', adminRoutes);

// // ============================================
// // SOCKET.IO - REAL-TIME FEATURES
// // ============================================



// // In-memory maps
// const connectedUsers = new Map(); // Map of userId -> socketId
// const listenerSockets = new Map(); // Map of listenerUserId -> socketId
// const activeChannels = new Map(); // Map of channelName -> Set of userIds in channel
// const lastSeenMap = new Map(); // Map of userId -> timestamp
// const presenceTimeouts = new Map(); // Map of userId -> timeoutId

// // Socket.IO connection handler
// io.on('connection', (socket) => {
//   console.log(`[SOCKET] Connected: ${socket.id}`);

//   // 1. IDENTITY & PRESENCE
  
//   // User joins (can be regular user or listener)
//   socket.on('user:join', (userId) => {
//     if (!userId) return;
//     socket.userId = userId;
//     connectedUsers.set(userId, socket.id);
//     lastSeenMap.set(userId, Date.now());
    
//     // Clear any pending offline timeout
//     if (presenceTimeouts.has(userId)) {
//       clearTimeout(presenceTimeouts.get(userId));
//       presenceTimeouts.delete(userId);
//     }
    
//     io.emit('user:online', { userId });
//     console.log(`[SOCKET] User joined: ${userId}`);

//     // Send current online listeners to the newly joined user
//     const onlineListeners = Array.from(listenerSockets.keys());
//     socket.emit('listeners:initial_status', onlineListeners);
//   });

//   // Listener specific join (for availability tracking)
//   socket.on('listener:join', (listenerUserId) => {
//     if (!listenerUserId) return;
//     socket.userId = listenerUserId; // Sync with userId
//     socket.listenerUserId = listenerUserId;
    
//     // Remove old socket if exists to prevent ghost sessions
//     if (listenerSockets.has(listenerUserId)) {
//       const oldSocketId = listenerSockets.get(listenerUserId);
//       if (oldSocketId && oldSocketId !== socket.id) {
//         const oldSocket = io.sockets.sockets.get(oldSocketId);
//         if (oldSocket) oldSocket.disconnect(true);
//       }
//     }
    
//     listenerSockets.set(listenerUserId, socket.id);
//     connectedUsers.set(listenerUserId, socket.id); // Also ensure in connectedUsers
    
//     io.emit('listener_status', { listenerUserId, online: true, timestamp: Date.now() });
//     console.log(`[SOCKET] Listener joined: ${listenerUserId}`);
//   });

//   // Explicit offline event
//   socket.on('listener:offline', (data) => {
//     const { listenerUserId } = data || {};
//     if (listenerUserId) {
//       listenerSockets.delete(listenerUserId);
//       io.emit('listener_status', { listenerUserId, online: false, timestamp: Date.now() });
//       console.log(`[SOCKET] Listener offline: ${listenerUserId}`);
//     }
//   });

//   // 2. CALL HANDLING

//   // Initiate call: User -> Listener
//   socket.on('call:initiate', (data) => {
//     const { listenerId, ...callData } = data || {};
//     // Check both maps for the listener's socket
//     const listenerSocketId = listenerSockets.get(listenerId) || connectedUsers.get(listenerId);
    
//     if (listenerSocketId) {
//       io.to(listenerSocketId).emit('incoming-call', callData);
//       console.log(`[SOCKET] call:initiate: Forwarded to listener ${listenerId}`);
//     } else {
//       console.log(`[SOCKET] call:initiate: Listener ${listenerId} NOT online`);
//       // Optionally notify the caller that the listener is offline
//       socket.emit('call:failed', { callId: callData.callId, reason: 'listener_offline' });
//     }
//   });

//   // Accept call: Listener -> User
//   socket.on('call:accept', (data) => {
//     const { callId, callerId } = data;
//     console.log(`[SOCKET] call:accept: Call ${callId} accepted by ${socket.userId}`);
//     const callerSocketId = connectedUsers.get(callerId);
//     if (callerSocketId) {
//       io.to(callerSocketId).emit('call:accepted', {
//         callId,
//         listenerId: socket.userId
//       });
//     }
//   });

//   // Reject call: Listener -> User
//   socket.on('call:reject', (data) => {
//     const { callId, callerId } = data;
//     console.log(`[SOCKET] call:reject: Call ${callId} rejected by ${socket.userId}`);
//     const callerSocketId = connectedUsers.get(callerId);
//     if (callerSocketId) {
//       io.to(callerSocketId).emit('call:rejected', {
//         callId,
//         listenerId: socket.userId
//       });
//     }
//   });

//   // Joined call channel (for both parties)
//   socket.on('call:joined', (data) => {
//     const { callId, channelName } = data;
//     const userId = socket.userId;
//     if (!userId) return;

//     console.log(`[SOCKET] User ${userId} joined channel ${channelName}`);
    
//     if (!activeChannels.has(channelName)) {
//       activeChannels.set(channelName, new Set());
//     }
//     activeChannels.get(channelName).add(userId);
    
//     const usersInChannel = activeChannels.get(channelName);
//     if (usersInChannel.size >= 2) {
//       console.log(`[SOCKET] Both parties in ${channelName}, emitting call:connected`);
//       usersInChannel.forEach(uid => {
//         const sid = connectedUsers.get(uid);
//         if (sid) {
//           io.to(sid).emit('call:connected', { callId, channelName });
//         }
//       });
//     }
//   });

//   // End call
//   socket.on('call:end', (data) => {
//     const { callId, otherUserId } = data;
//     console.log(`[SOCKET] call:end: Call ${callId} ended by ${socket.userId}`);
//     const otherSocketId = connectedUsers.get(otherUserId);
//     if (otherSocketId) {
//       io.to(otherSocketId).emit('call:ended', {
//         callId,
//         endedBy: socket.userId
//       });
//     }
//   });

//   // Leave channel
//   socket.on('call:left', (data) => {
//     const { channelName } = data;
//     if (activeChannels.has(channelName) && socket.userId) {
//       activeChannels.get(channelName).delete(socket.userId);
//       if (activeChannels.get(channelName).size === 0) {
//         activeChannels.delete(channelName);
//       }
//     }
//   });

//   // 3. DISCONNECTION

//   socket.on('disconnect', () => {
//     const userId = socket.userId;
//     const listenerUserId = socket.listenerUserId;

//     console.log(`[SOCKET] Disconnected: ${socket.id} (User: ${userId}, Listener: ${listenerUserId})`);

//     // Handle listener cleanup
//     if (listenerUserId && listenerSockets.get(listenerUserId) === socket.id) {
//       listenerSockets.delete(listenerUserId);
//       io.emit('listener_status', { listenerUserId, online: false, timestamp: Date.now() });
//       console.log(`[SOCKET] Listener marked offline: ${listenerUserId}`);
//     }

//     // Handle user cleanup and active calls
//     if (userId) {
//       // Notify others in active channels
//       for (const [channelName, users] of activeChannels.entries()) {
//         if (users.has(userId)) {
//           users.forEach(otherUid => {
//             if (otherUid !== userId) {
//               const otherSid = connectedUsers.get(otherUid);
//               if (otherSid) {
//                 io.to(otherSid).emit('call:ended', {
//                   callId: channelName,
//                   endedBy: userId,
//                   reason: 'peer_disconnected'
//                 });
//               }
//             }
//           });
//           users.delete(userId);
//           if (users.size === 0) activeChannels.delete(channelName);
//         }
//       }

//       // Debounce offline status
//       if (presenceTimeouts.has(userId)) {
//         clearTimeout(presenceTimeouts.get(userId));
//       }
      
//       const timeoutId = setTimeout(async () => {
//         const lastSeen = lastSeenMap.get(userId) || 0;
//         if (Date.now() - lastSeen > 1000) {
//           connectedUsers.delete(userId);
//           lastSeenMap.delete(userId);
//           presenceTimeouts.delete(userId);
          
//           try {
//             // await User.updateLastSeen(userId); 
//           } catch (err) {}
          
//           io.emit('user:offline', { userId });
//           console.log(`[SOCKET] User ${userId} marked offline (debounce)`);
//         }
//       }, 1000);
      
//       presenceTimeouts.set(userId, timeoutId);
//     }
//   });
// });



// // ============================================
// // ERROR HANDLING
// // ============================================

// // 404 handler
// app.use((req, res) => {
//   res.status(404).json({
//     error: 'Route not found',
//     path: req.originalUrl
//   });
// });

// // Global error handler
// app.use((err, req, res, next) => {
//   console.error('Error:', err);
  
//   res.status(err.status || 500).json({
//     error: err.message || 'Internal server error',
//     ...(config.NODE_ENV === 'development' && { stack: err.stack })
//   });
// });

// // ============================================
// // SERVER STARTUP
// // ============================================

// const PORT = config.PORT;

// async function startServer() {
//   try {
//     // Test database connection
//     console.log('Ã°Å¸â€â€” Connecting to AWS RDS PostgreSQL...');
//     const connected = await testConnection();
    
//     if (!connected) {
//       console.error('Ã¢ÂÅ’ Failed to connect to database. Exiting...');
//       process.exit(1);
//     }

//     // Ensure schema has required columns (safe, idempotent)
//     try {
//       await ensureSchema();
//     } catch (err) {
//       console.error('Ã¢ÂÅ’ Failed to ensure database schema:', err.message);
//       process.exit(1);
//     }

//     // Start server
//     server.listen(PORT, () => {
//       console.log('\n' + '='.repeat(50));
//       console.log(`Ã°Å¸Å¡â‚¬ Dost Talk Backend Server`);
//       console.log(`Ã°Å¸â€œÂ¡ Environment: ${config.NODE_ENV}`);
//       console.log(`Ã°Å¸Å’Â Server running on port ${PORT}`);
//       console.log(`Ã°Å¸â€Å’ Socket.IO ready for connections`);
//       console.log(`Ã°Å¸â€œÅ  API endpoints available at http://localhost:${PORT}/api`);
//       console.log('='.repeat(50) + '\n');
//     });
//   } catch (error) {
//     console.error('Ã¢ÂÅ’ Failed to start server:', error);
//     process.exit(1);
//   }
// }

// // Start the server
// startServer();

// // Handle graceful shutdown
// process.on('SIGTERM', () => {
//   console.log('\nÃ°Å¸â€ºâ€˜ SIGTERM signal received: closing server gracefully');
//   server.close(() => {
//     console.log('Ã¢Å“â€œ Server closed');
//     process.exit(0);
//   });
// });

// process.on('SIGINT', () => {
//   console.log('\nÃ°Å¸â€ºâ€˜ SIGINT signal received: closing server gracefully');
//   server.close(() => {
//     console.log('Ã¢Å“â€œ Server closed');
//     process.exit(0);
//   });
// });

// export { app, server, io };


