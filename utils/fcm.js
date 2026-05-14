import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '../.env') });

const MAX_FCM_BATCH_SIZE = 500;
const DEFAULT_BATCH_TIMEOUT_MS = 30000;
let firebaseInitError = null;

function initializeFirebaseAdmin() {
  if (admin.apps.length) {
    return admin.app();
  }

  try {
    const projectId = String(process.env.FIREBASE_PROJECT_ID || '').trim();
    const clientEmail = String(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
    const privateKey = String(process.env.FIREBASE_PRIVATE_KEY || '')
      .replace(/\\n/g, '\n')
      .trim();

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        'Missing Firebase env vars. Required: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY',
      );
    }

    const app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
    firebaseInitError = null;
    console.log(`[FCM] Firebase Admin SDK initialized project=${projectId} email=${clientEmail}`);
    return app;
  } catch (error) {
    firebaseInitError = error;
    console.error('[FCM] Failed to initialize Firebase Admin SDK:', error.message);
    throw error;
  }
}

function getFirebaseMessaging() {
  if (firebaseInitError && !admin.apps.length) {
    throw firebaseInitError;
  }
  return admin.messaging(initializeFirebaseAdmin());
}

try {
  initializeFirebaseAdmin();
} catch {
  // Send helpers convert initialization problems into tracked delivery failures.
}

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
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('enotfound')
  );
}

function isInvalidFcmError(error) {
  const code = String(error?.code || error || '').toLowerCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    code.includes('registration-token-not-registered') ||
    code.includes('invalid-registration-token') ||
    code.includes('invalid-argument') ||
    message.includes('registration-token-not-registered') ||
    message.includes('invalid-registration-token') ||
    message.includes('requested entity was not found') ||
    message.includes('registration token is not a valid fcm registration token')
  );
}

function maskToken(token) {
  const t = String(token || '').trim();
  if (!t) return 'missing';
  return t.length <= 12 ? t : `${t.slice(0, 6)}...${t.slice(-6)}`;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
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

function toFailureResult(item, error) {
  return {
    userId: item.userId,
    token: item.token,
    success: false,
    error: error?.message || 'Unknown FCM error',
    code: error?.code || null,
    isInvalidToken: isInvalidFcmError(error),
    tokenPreview: maskToken(item.token),
  };
}

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
        const response = await getFirebaseMessaging().send(payload);
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

async function sendBatchFCM(items, { chunkSize = MAX_FCM_BATCH_SIZE, timeoutMs = DEFAULT_BATCH_TIMEOUT_MS } = {}) {
  if (!items.length) return [];

  const normalizedItems = items.map((item) => ({
    ...item,
    token: String(item.token || '').trim(),
  }));
  const results = [];
  const validItems = [];

  for (const item of normalizedItems) {
    if (!item.token) {
      results.push(toFailureResult(item, new Error('Missing FCM token')));
    } else {
      validItems.push(item);
    }
  }

  let messaging;
  try {
    messaging = getFirebaseMessaging();
  } catch (error) {
    return [
      ...results,
      ...validItems.map((item) => toFailureResult(item, error)),
    ];
  }

  const chunks = chunkArray(validItems, Math.min(Math.max(chunkSize, 1), MAX_FCM_BATCH_SIZE));
  for (const batch of chunks) {
    try {
      const messages = batch.map((item) => buildFcmPayload(
        item.token,
        item.title,
        item.body,
        item.data,
      ));
      const response = await withTimeout(
        messaging.sendEach(messages),
        timeoutMs,
        `FCM batch (${batch.length})`,
      );

      for (let i = 0; i < response.responses.length; i++) {
        const item = batch[i];
        const itemResponse = response.responses[i];
        if (itemResponse.success) {
          results.push({
            userId: item.userId,
            token: item.token,
            success: true,
            messageId: itemResponse.messageId,
            tokenPreview: maskToken(item.token),
          });
        } else {
          results.push(toFailureResult(item, itemResponse.error));
        }
      }
    } catch (error) {
      console.error(
        `[FCM] batch failed size=${batch.length} retryable=${isRetryableFcmError(error)} err=${error?.message}`,
      );
      for (const item of batch) {
        results.push(toFailureResult(item, error));
      }
    }
  }

  return results;
}

export {
  getFirebaseMessaging,
  initializeFirebaseAdmin,
  isInvalidFcmError,
  sendPushFCM,
  sendBatchFCM,
};
