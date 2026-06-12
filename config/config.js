import dotenv from 'dotenv';
dotenv.config();

const defaultCorsOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175',
  'https://dosttalk-api.appdost.com',
  'https://admindosttalk.appdost.com',
  'https://dosttalk.appdost.com',
];

const envCorsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedCorsOrigins = Array.from(
  new Set([...defaultCorsOrigins, ...envCorsOrigins]),
);

const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/i;

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedCorsOrigins.includes(origin)) return true;
  if (localhostPattern.test(origin)) return true;
  return false;
}

function corsOriginHandler(origin, callback) {
  if (isOriginAllowed(origin)) {
    callback(null, true);
    return;
  }
  callback(new Error(`CORS blocked for origin: ${origin}`));
}

export default {
  // Server configuration
  PORT: process.env.PORT || 3002,
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Database configuration (AWS RDS PostgreSQL)
  database: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false
    },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000 // Increased from 2000 to 10000 ms
  },

  // JWT configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'your-secret-key-change-in-production',
    expiresIn: '30d'
  },

  // Twilio configuration (for SMS OTP)
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER
  },

  // AWS S3 configuration (for file uploads)
  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION || 'us-east-1',
    s3BucketName: process.env.AWS_S3_BUCKET_NAME
  },

  // CORS configuration
  cors: {
    origin: corsOriginHandler,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204,
  },

  // Rate limiting — general API (generous for mobile apps with retries / sockets)
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000 // limit each IP to 1000 requests per 15-min window
  },

  // Rate limiting — auth endpoints (stricter to prevent brute-force)
  authRateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30 // limit each IP to 30 auth requests per 15-min window
  },

  // File upload limits
  upload: {
    maxFileSize: 5 * 1024 * 1024, // 5MB
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/jpg'],
    allowedAudioTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg'],
    allowedVideoTypes: ['video/mp4', 'video/webm']
  },

  // Socket.IO configuration
  socketIO: {
    pingTimeout: 5000,  // Reduced from 60000ms to 5000ms for faster offline detection
    pingInterval: 2000, // Reduced from 25000ms to 2000ms for more frequent heartbeats
  },

  // LiveKit RTC configuration
  livekit: {
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    url: process.env.LIVEKIT_URL || 'wss://livekit.appdost.com'
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET
  }
};






















