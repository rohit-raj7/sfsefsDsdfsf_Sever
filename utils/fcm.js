import admin from 'firebase-admin';
import dotenv from 'dotenv';

dotenv.config();

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON (must be valid JSON)');
  }
}

function loadFirebaseServiceAccountFromEnv() {
  const jsonFromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonFromEnv) return parseJsonSafe(jsonFromEnv);

  const base64FromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
  if (base64FromEnv) {
    const decoded = Buffer.from(base64FromEnv, 'base64').toString('utf8');
    return parseJsonSafe(decoded);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;
  const privateKey = privateKeyRaw ? privateKeyRaw.replace(/\\n/g, '\n').trim() : '';

  if (projectId && clientEmail && privateKey) {
    return {
      type: 'service_account',
      project_id: projectId,
      private_key: privateKey,
      client_email: clientEmail,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID?.trim(),
      client_id: process.env.FIREBASE_CLIENT_ID?.trim(),
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL?.trim(),
      universe_domain: 'googleapis.com',
    };
  }

  throw new Error(
    'Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON (preferred) or FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.',
  );
}

// ─── Firebase Admin Init ────────────────────────────────────────────
try {
  if (!admin.apps.length) {
    const serviceAccount = loadFirebaseServiceAccountFromEnv();
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('✅ Firebase Admin SDK initialized successfully.');
  }
} catch (error) {
  console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
}

// ─── Error Classification ───────────────────────────────────────────
function isRetryableFcmError(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return (
    code.includes('internal-error') ||
    code.includes('server-unavailable') ||
    code.includes('quota-exceeded') ||
    message.includes('internal error') ||
    message.includes('server unavailable') ||
    message.includes('timeout') ||
    message.includes('timed out')
  );
}

function isInvalidFcmError(error) {
  const code = String(error?.code || error || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-registration-token') ||
    message.includes('registration-token-not-registered') ||
    message.includes('invalid-registration-token') ||
    message.includes('requested entity was not found') ||
    message.includes('registration token is not a valid fcm registration token')
  );
}

// ─── Helpers ────────────────────────────────────────────────────────
function maskToken(token) {
  const t = String(token || '').trim();
  if (!t) return 'missing';
  return t.length <= 12 ? t : `${t.slice(0, 6)}...${t.slice(-6)}`;
}

function buildFcmPayload(token, title, body, data = {}) {
  const stringData = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value !== undefined && value !== null) {
      stringData[key] = String(value);
    }
  }
  return {
    token,
    notification: { title, body },
    data: {
      title: String(title ?? ''),
      body: String(body ?? ''),
      ...stringData,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    android: {
      priority: 'high',
      ttl: 3600000,
      notification: {
        channelId: 'dost_talk_admin_channel',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        sound: 'default',
        priority: 'max',
        defaultSound: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
      payload: {
        aps: { contentAvailable: true, mutableContent: true, sound: 'default' },
      },
    },
  };
}

// ─── Single FCM Send (with retries) ────────────────────────────────
const RETRY_DELAYS = [0, 500, 1500];

async function sendPushFCM(token, title, body, data = {}) {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    return {
      success: false,
      error: 'Missing FCM token',
      code: 'messaging/missing-registration-token',
      isInvalidToken: true,
      tokenPreview: 'missing',
    };
  }

  try {
    const payload = buildFcmPayload(normalizedToken, title, body, data);
    let lastError = null;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
      try {
        const response = await admin.messaging().send(payload);
        return {
          success: true,
          messageId: response,
          attempts: attempt + 1,
          tokenPreview: maskToken(normalizedToken),
        };
      } catch (error) {
        lastError = error;
        if (!isRetryableFcmError(error) || attempt === RETRY_DELAYS.length - 1) break;
      }
    }
    throw lastError;
  } catch (error) {
    const invalidToken = isInvalidFcmError(error);
    console.error(
      `[FCM] send failed token=${maskToken(normalizedToken)} code=${error?.code || 'unknown'} invalid=${invalidToken} err=${error?.message}`,
    );
    return {
      success: false,
      error: error?.message || 'Unknown FCM error',
      code: error?.code || null,
      isInvalidToken: invalidToken,
      tokenPreview: maskToken(normalizedToken),
    };
  }
}

// ─── Batch FCM Send (parallel with concurrency control) ─────────────
/**
 * Send FCM notifications in parallel batches.
 * @param {Array<{userId: string, token: string, title: string, body: string, data: object}>} items
 * @param {object} options
 * @param {number} options.concurrency - max parallel sends (default 50)
 * @returns {Promise<Array<{userId: string, token: string, success: boolean, error?: string, isInvalidToken?: boolean}>>}
 */
async function sendBatchFCM(items, { concurrency = 50 } = {}) {
  if (!items.length) return [];

  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((item) => sendPushFCM(item.token, item.title, item.body, item.data)),
    );
    for (let j = 0; j < settled.length; j++) {
      const item = batch[j];
      const result = settled[j];
      if (result.status === 'fulfilled') {
        results.push({ userId: item.userId, token: item.token, ...result.value });
      } else {
        results.push({
          userId: item.userId,
          token: item.token,
          success: false,
          error: result.reason?.message || 'Unknown error',
          isInvalidToken: isInvalidFcmError(result.reason),
        });
      }
    }
  }
  return results;
}

export { isInvalidFcmError, sendPushFCM, sendBatchFCM };
