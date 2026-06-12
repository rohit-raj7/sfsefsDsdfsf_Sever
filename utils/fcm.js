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

function formatFirebaseErrorMessage(message) {
  const msg = String(message || '');
  if (msg.includes('invalid_grant') && msg.includes('JWT Signature')) {
    return 'Firebase authentication failed: The service account private key is invalid or has been revoked. Please generate a new service account key file in the Firebase Console (Settings > Service Accounts) and update the FIREBASE_SERVICE_ACCOUNT_JSON environment variable.';
  }
  if (msg.includes('invalid_grant') && msg.includes('clock')) {
    return 'Firebase authentication failed: The server system time is out of sync. Please synchronize your server clock with NTP.';
  }
  if (msg.includes('Credential implementation') && msg.includes('fetch a valid Google OAuth2 access token')) {
    return 'Firebase authentication failed: Unable to fetch OAuth2 access token. Please verify that your service account credentials are correct and that the key is active in the Google Cloud Console.';
  }
  return msg;
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
    const formattedError = formatFirebaseErrorMessage(error?.message);
    console.error(
      `[FCM] send failed token=${maskToken(normalizedToken)} code=${error?.code || 'unknown'} invalid=${invalidToken} err=${formattedError}`,
    );
    return {
      success: false,
      error: formattedError || 'Unknown FCM error',
      code: error?.code || null,
      isInvalidToken: invalidToken,
      tokenPreview: maskToken(normalizedToken),
    };
  }
}

// ─── Batch FCM Send (parallel with concurrency control) ─────────────
/**
 * Send FCM notifications in parallel batches using FCM sendEach API.
 * @param {Array<{userId: string, token: string, title: string, body: string, data: object}>} items
 * @param {object} options
 * @param {number} options.concurrency - (deprecated, kept for compatibility, chunks are 500 by FCM standard)
 * @returns {Promise<Array<{userId: string, token: string, success: boolean, error?: string, isInvalidToken?: boolean}>>}
 */
async function sendBatchFCM(items, { concurrency = 50 } = {}) {
  if (!items.length) return [];

  const results = [];
  const chunkSize = 500; // FCM sendEach limit is 500 per request

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    
    // Build initial messages for the chunk
    const chunkMessages = chunk.map(item => 
      buildFcmPayload(String(item.token || '').trim(), item.title, item.body, item.data)
    );

    let attempt = 0;
    let currentChunk = chunk;
    let currentMessages = chunkMessages;
    
    // Retry configuration (matches single send delays)
    const maxAttempts = 3;
    const retryDelays = [0, 500, 1500];
    const chunkResults = new Map();

    try {
      while (currentChunk.length > 0 && attempt < maxAttempts) {
        if (retryDelays[attempt] > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        }

        try {
          const response = await admin.messaging().sendEach(currentMessages);
          
          const nextChunk = [];
          const nextMessages = [];

          for (let j = 0; j < currentChunk.length; j++) {
            const item = currentChunk[j];
            const res = response.responses[j];

            if (res.success) {
              chunkResults.set(item.userId, {
                userId: item.userId,
                token: item.token,
                success: true,
                messageId: res.messageId,
                tokenPreview: maskToken(item.token),
              });
            } else {
              const error = res.error;
              const isRetryable = isRetryableFcmError(error);
              const isInvalidToken = isInvalidFcmError(error);

              if (isRetryable && attempt < maxAttempts - 1) {
                nextChunk.push(item);
                nextMessages.push(currentMessages[j]);
              } else {
                const formattedError = formatFirebaseErrorMessage(error?.message);
                chunkResults.set(item.userId, {
                  userId: item.userId,
                  token: item.token,
                  success: false,
                  error: formattedError || 'FCM delivery failed',
                  code: error?.code || null,
                  isInvalidToken,
                  tokenPreview: maskToken(item.token),
                });
              }
            }
          }

          currentChunk = nextChunk;
          currentMessages = nextMessages;
          attempt++;
        } catch (error) {
          console.error(`[FCM] sendEach failed on attempt ${attempt + 1}: ${error.message}`);
          const formattedError = formatFirebaseErrorMessage(error.message);
          
          for (const item of currentChunk) {
            chunkResults.set(item.userId, {
              userId: item.userId,
              token: item.token,
              success: false,
              error: formattedError || 'FCM batch send failed',
              code: error.code || 'messaging/batch-send-failed',
              isInvalidToken: false,
              tokenPreview: maskToken(item.token),
            });
          }
          
          throw error; // Propagate to outer catch for chunk aborting
        }
      }
    } catch (error) {
      const formattedError = formatFirebaseErrorMessage(error.message);
      const isAuthError = error.message?.includes('invalid_grant') || error.message?.includes('JWT Signature') || error.message?.includes('credential') || error.code?.includes('invalid-credential');

      // Fill remaining items of this chunk and all subsequent chunks with this error
      for (let k = i; k < items.length; k++) {
        const item = items[k];
        if (!chunkResults.has(item.userId)) {
          chunkResults.set(item.userId, {
            userId: item.userId,
            token: item.token,
            success: false,
            error: formattedError || 'FCM batch send failed',
            code: error.code || 'messaging/batch-send-failed',
            isInvalidToken: false,
            tokenPreview: maskToken(item.token),
          });
        }
      }

      if (isAuthError) {
        break; // Break the chunks loop on structural auth error
      }
      continue; // Continue to next chunk on transient chunk error
    }

    // Append resolved results for this chunk in the original order
    for (const item of chunk) {
      const res = chunkResults.get(item.userId);
      if (res) {
        results.push(res);
      } else {
        results.push({
          userId: item.userId,
          token: item.token,
          success: false,
          error: 'Unprocessed message in batch',
          isInvalidToken: false,
          tokenPreview: maskToken(item.token),
        });
      }
    }
  }

  return results;
}

export { isInvalidFcmError, sendPushFCM, sendBatchFCM };
