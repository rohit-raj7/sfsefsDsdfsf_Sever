import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import config from '../config/config.js';
import { testConnection, ensureSchema, getRateConfig } from '../db.js';

// Import routes
import authRoutes from '../routes/auth.js';
import userRoutes from '../routes/users.js';
import listenerRoutes from '../routes/listeners.js';
import callRoutes from '../routes/calls.js';
import chatRoutes from '../routes/chats.js';
import adminRoutes from '../routes/admin.js';
import notificationsRoutes from '../routes/notifications.js';
import marketingRoutes from '../routes/marketing.js';
import accountRoutes from '../routes/account.js';
import subscriptionRoutes from '../routes/subscriptions.js';
import reportRoutes from '../routes/reports.js';
import paymentRoutes from '../routes/payments.js';
import rechargePackRoutes from '../routes/rechargePacks.js';

// Initialize Express app
const app = express();

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

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'Dost Talk API Server',
    version: '1.0.1',
    status: 'running'
  });
});

// API health check
app.get('/api/health', async (req, res) => {
  try {
    const dbConnected = await testConnection();
    // Try to ensure schema on health check for serverless environments
    try {
      await ensureSchema();
    } catch (e) {
      console.warn('ensureSchema failed during health check:', e.message);
    }
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

app.get('/api/config/call-rates', async (req, res) => {
  try {
    const rateConfig = await getRateConfig();
    res.json({
      normalPerMinuteRate: Number(rateConfig.normal_per_minute_rate),
      firstTimeOfferEnabled: rateConfig.first_time_offer_enabled === true,
      offerMinutesLimit: rateConfig.offer_minutes_limit,
      offerFlatPrice: rateConfig.offer_flat_price
    });
  } catch (error) {
    console.error('Get call rates error:', error);
    res.status(500).json({ error: 'Failed to fetch call rates' });
  }
});

// Mount API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/listeners', listenerRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/marketing', marketingRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/recharge-packs', rechargePackRoutes);

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

// Export for Vercel serverless
export default app;
