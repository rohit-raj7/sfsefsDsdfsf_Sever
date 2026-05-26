import express from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';

import User from '../models/User.js';
import Listener from '../models/Listener.js';
import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

// GOOGLE_AUDIENCES: all valid client IDs the backend will accept in idToken.
// Android sends idToken with audience = GOOGLE_WEB_CLIENT_ID (serverClientId).
// So GOOGLE_WEB_CLIENT_ID MUST be in this list, or verification will fail.
const GOOGLE_AUDIENCES = [
  process.env.GOOGLE_WEB_CLIENT_ID,   // Web Client ID — Android idToken audience
  process.env.GOOGLE_CLIENT_ID,        // Android Client ID (fallback)
  process.env.ADMIN_GOOGLE_CLIENT_ID,  // Admin Web Client ID (fallback)
]
  .map((value) => value?.trim())
  .filter((value, index, arr) => value && arr.indexOf(value) === index);

// Use Web Client ID as primary for OAuth2Client — this matches Android idToken audience
const primaryClientId = process.env.GOOGLE_WEB_CLIENT_ID || GOOGLE_AUDIENCES[0] || undefined;
const googleClient = new OAuth2Client(primaryClientId);
const configuredProviderTimeoutMs = Number(process.env.AUTH_PROVIDER_TIMEOUT_MS);
const providerRequestTimeoutMs =
  Number.isFinite(configuredProviderTimeoutMs) && configuredProviderTimeoutMs > 0
    ? configuredProviderTimeoutMs
    : 10000;

function looksLikeJwt(value) {
  return typeof value === 'string' && value.split('.').length === 3;
}

function normalizeFcmToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  return token.length > 0 ? token : null;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}


/**
 * =====================================================
 * SOCIAL LOGIN / SIGNUP (SAME BUTTON)
 * Google + Facebook
 * =====================================================
 */
router.post('/social-login', async (req, res) => {
  try {
    const { provider, token, id_token, access_token, fcm_token } = req.body;
    const normalizedFcmToken = normalizeFcmToken(fcm_token);
    const idTokenCandidate = id_token || (looksLikeJwt(token) ? token : null);
    const accessTokenCandidate = access_token || token;

    if (!provider || (!idTokenCandidate && !accessTokenCandidate)) {
      return res.status(400).json({ error: 'provider and token are required' });
    }

    if (!['google', 'facebook'].includes(provider)) {
      return res.status(400).json({ error: 'Unsupported provider' });
    }

    console.log(
      `[AUTH] social-login provider=${provider} hasFcmToken=${normalizedFcmToken != null}`,
    );

    let userInfo;

    // ===================== GOOGLE =====================
    if (provider === 'google') {
      try {
        if (!idTokenCandidate) {
          throw new Error('Missing Google ID token');
        }

        // First, try to verify as ID token
        const verifyOptions = { idToken: idTokenCandidate };
        if (GOOGLE_AUDIENCES.length > 0) {
          verifyOptions.audience = GOOGLE_AUDIENCES;
        }
        const ticket = await withTimeout(
          googleClient.verifyIdToken(verifyOptions),
          providerRequestTimeoutMs,
          'Google ID token verification timed out'
        );

        const payload = ticket.getPayload();

        userInfo = {
          provider_user_id: payload.sub,
          email: payload.email,
          full_name: payload.name,
          display_name: payload.given_name || payload.name,
          avatar_url: payload.picture,
        };
      } catch (idTokenError) {
        // If ID token verification fails, try as access token
        console.log('ID token verification failed, trying access token:', idTokenError.message);
        try {
          if (!accessTokenCandidate) {
            throw new Error('Missing access token');
          }
          const googleRes = await axios.get(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            {
              params: { access_token: accessTokenCandidate },
              timeout: providerRequestTimeoutMs,
            }
          );

          const googleUser = googleRes.data;

          userInfo = {
            provider_user_id: googleUser.sub,
            email: googleUser.email,
            full_name: googleUser.name,
            display_name: googleUser.given_name || googleUser.name,
            avatar_url: googleUser.picture,
          };
        } catch (accessTokenError) {
          console.error('Google token verification failed:', accessTokenError);
          return res.status(401).json({ error: 'Invalid Google token' });
        }
      }
    }

    // ===================== FACEBOOK =====================
    if (provider === 'facebook') {
      const appToken = `${process.env.facebook_app_id}|${process.env.facebook_app_secret}`;

      const debug = await axios.get(
        'https://graph.facebook.com/debug_token',
        {
          params: { input_token: token, access_token: appToken },
          timeout: providerRequestTimeoutMs,
        }
      );

      if (!debug.data.data.is_valid) {
        return res.status(401).json({ error: 'Invalid Facebook token' });
      }

      const fbRes = await axios.get(
        'https://graph.facebook.com/me',
        {
          params: { fields: 'id,email,name,first_name,picture', access_token: token },
          timeout: providerRequestTimeoutMs,
        }
      );

      const fb = fbRes.data;

      userInfo = {
        provider_user_id: fb.id,
        email: fb.email,
        full_name: fb.name,
        display_name: fb.first_name || fb.name,
        avatar_url: fb.picture?.data?.url,
      };
    }

    // Safety guard — should never reach here, but prevents crash if provider handler missed a case
    if (!userInfo) {
      return res.status(401).json({ error: 'Could not retrieve user info from provider' });
    }

    // ===================== FIND USER =====================
    let user = await User.findByProvider(provider, userInfo.provider_user_id);
    let isNewUser = false;

    // Try matching by email and link provider
    if (!user && userInfo.email) {
      const existingByEmail = await User.findByEmail(userInfo.email);
      if (existingByEmail) {
        user = await User.linkProvider(
          existingByEmail.user_id,
          provider,
          userInfo.provider_user_id
        );
      }
    }

    // ===================== CREATE USER =====================
    if (!user) {
      const isFirstTimeUser = true; // All new users are first-time users
      user = await User.create({
        phone_number: null,
        email: userInfo.email || null,
        auth_provider: provider,
        google_id: provider === 'google' ? userInfo.provider_user_id : null,
        facebook_id: provider === 'facebook' ? userInfo.provider_user_id : null,
        full_name: userInfo.full_name,
        display_name: userInfo.display_name,
        avatar_url: userInfo.avatar_url,
        fcm_token: normalizedFcmToken,
        account_type: 'user',
        is_first_time_user: isFirstTimeUser,
        offer_used: false
      });
      if (normalizedFcmToken) {
        await User.updateFcmToken(user.user_id, normalizedFcmToken);
      }
      isNewUser = true;
    } else {
      const profileUpdates = {};

      if (userInfo.email && user.email !== userInfo.email) {
        profileUpdates.email = userInfo.email;
      }
      if (userInfo.full_name && !user.full_name) {
        profileUpdates.full_name = userInfo.full_name;
      }
      if (userInfo.display_name && !user.display_name) {
        profileUpdates.display_name = userInfo.display_name;
      }
      if (userInfo.avatar_url && !user.avatar_url) {
        profileUpdates.avatar_url = userInfo.avatar_url;
      }

      if (Object.keys(profileUpdates).length > 0) {
        await User.update(user.user_id, profileUpdates);
      }

      await User.updateLastLogin(user.user_id);
      if (normalizedFcmToken) {
        await User.updateFcmToken(user.user_id, normalizedFcmToken);
      }
    }

    await User.verifyUser(user.user_id);

    // ===================== JWT =====================
    const sessionId = crypto.randomUUID();
    await pool.query(
      'UPDATE users SET active_session_id = $1 WHERE user_id = $2',
      [sessionId, user.user_id]
    );

    const jwtToken = jwt.sign(
      {
        user_id: user.user_id,
        session_id: sessionId,
        provider,
        email: user.email,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({
      message: isNewUser ? 'Signup successful' : 'Login successful',
      token: jwtToken,
      user: await User.findById(user.user_id),
      isNewUser,
    });

  } catch (error) {
    console.error('Social login error:', error);
    return res.status(500).json({ error: 'Social authentication failed' });
  }
});

/**
 * =====================================================
 * LOGOUT
 * Mobile calls POST /api/auth/logout
 * JWT is stateless — we can't invalidate server-side without a blocklist.
 * Mobile clears token locally. Backend just updates last_seen.
 * =====================================================
 */
router.post('/logout', authenticate, async (req, res) => {
  try {
    await User.updateLastSeen(req.userId);
    return res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    // Always return success — logout must never block the client
    return res.json({ message: 'Logged out' });
  }
});

/**
 * =====================================================
 * OTP LOGIN / SIGNUP
 * Phone Number + 2Factor API
 * =====================================================
 */
router.post('/trusted-login', async (req, res) => {
  try {
    const { 
      phone_number, 
      device_id, 
      platform, 
      device_name, 
      manufacturer, 
      model, 
      os_version, 
      app_version, 
      firebase_installation_id,
      fcm_token 
    } = req.body;

    if (!phone_number) {
      return res.status(400).json({ error: 'phone_number is required' });
    }

    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(phone_number)) {
      return res.status(400).json({ error: 'Invalid phone number format. Must be exactly 10 digits.' });
    }

    const normalizedFcmToken = normalizeFcmToken(fcm_token);
    
    // Check if there is a trusted device record for this phone number
    const trustedDevicesResult = await pool.query(
      'SELECT * FROM trusted_devices WHERE mobile_number = $1 AND is_trusted = TRUE',
      [phone_number]
    );

    let matchedDevice = null;
    let needsDeviceIdUpdate = false;

    if (trustedDevicesResult.rows.length > 0) {
      // 1. Try exact device_id match
      if (device_id) {
        matchedDevice = trustedDevicesResult.rows.find(d => d.device_id === device_id);
      }
      
      // 2. If no exact match, try fingerprint matching (fallback for app reinstall/clear data)
      if (!matchedDevice && platform && model && manufacturer) {
        // We look for a strong match: same platform, model, manufacturer
        // and optionally firebase_installation_id if available.
        matchedDevice = trustedDevicesResult.rows.find(d => {
          const strongFingerprintMatch = 
            d.platform === platform && 
            d.model === model && 
            d.manufacturer === manufacturer;
            
          // If firebase_installation_id is provided by both, they must match
          if (strongFingerprintMatch && firebase_installation_id && d.firebase_installation_id) {
            return d.firebase_installation_id === firebase_installation_id;
          }
          
          return strongFingerprintMatch;
        });
        
        if (matchedDevice) {
          needsDeviceIdUpdate = true;
        }
      }
    }

    // If we have a confident match, skip OTP
    if (matchedDevice) {
      console.log(`[AUTH] Trusted device login successful for ${phone_number}`);
      
      // Update device id if it was a fingerprint match, and update last_login_at
      if (needsDeviceIdUpdate && device_id) {
        await pool.query(
          'UPDATE trusted_devices SET device_id = $1, last_login_at = CURRENT_TIMESTAMP WHERE id = $2',
          [device_id, matchedDevice.id]
        );
      } else {
        await pool.query(
          'UPDATE trusted_devices SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1',
          [matchedDevice.id]
        );
      }

      // Generate token (same as verify-otp logic)
      let user = await User.findByPhone(phone_number);
      let isNewUser = false;
      
      if (!user) {
        const isFirstTimeUser = true;
        user = await User.create({
          phone_number: phone_number,
          auth_provider: 'phone',
          fcm_token: normalizedFcmToken,
          account_type: 'user',
          is_first_time_user: isFirstTimeUser,
          offer_used: false
        });
        if (normalizedFcmToken) {
          await User.updateFcmToken(user.user_id, normalizedFcmToken);
        }
        isNewUser = true;
      } else {
        await User.updateLastLogin(user.user_id);
        if (normalizedFcmToken) {
          await User.updateFcmToken(user.user_id, normalizedFcmToken);
        }
      }

      await User.verifyUser(user.user_id);

      const sessionId = crypto.randomUUID();
      await pool.query(
        'UPDATE users SET active_session_id = $1 WHERE user_id = $2',
        [sessionId, user.user_id]
      );

      const jwtToken = jwt.sign(
        { user_id: user.user_id, session_id: sessionId, provider: 'phone' },
        process.env.JWT_SECRET,
        { expiresIn: '30d' }
      );

      return res.json({
        action: 'LOGIN_SUCCESS',
        message: 'Login successful',
        token: jwtToken,
        user: await User.findById(user.user_id),
        isNewUser,
      });
    }

    // If no trusted device found, proceed to send OTP
    console.log(`[AUTH] No trusted device found for ${phone_number}, sending OTP`);
    const apiKey = process.env.TWO_FACTOR_API_KEY || process.env.MOBILE_NUMBER_AUTH;
    if (!apiKey) {
      return res.status(500).json({ error: 'Authentication service temporarily unavailable' });
    }

    const templateName = process.env.SMS_TEMPLATE_NAME;
    const sendOtpUrl = templateName
      ? `https://2factor.in/API/V1/${apiKey}/SMS/${phone_number}/AUTOGEN/${templateName}`
      : `https://2factor.in/API/V1/${apiKey}/SMS/${phone_number}/AUTOGEN`;

    const response = await axios.get(sendOtpUrl);

    if (response.data && response.data.Status === "Success") {
      try {
        await pool.query('INSERT INTO otp_tracking (phone_number) VALUES ($1)', [phone_number]);
      } catch (err) {
        console.error('Failed to log OTP track:', err);
      }

      return res.json({
        action: 'OTP_REQUIRED',
        message: 'OTP sent successfully',
        session_id: response.data.Details
      });
    } else {
      return res.status(400).json({ error: 'Failed to send OTP. Please try again later.' });
    }
  } catch (error) {
    console.error('Trusted Login error:', error.message || error);
    return res.status(500).json({ error: 'Internal server error during login' });
  }
});

router.post('/send-otp', async (req, res) => {
  try {
    const { phone_number } = req.body;

    if (!phone_number) {
      return res.status(400).json({ error: 'phone_number is required' });
    }

    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(phone_number)) {
      return res.status(400).json({ error: 'Invalid phone number format. Must be exactly 10 digits.' });
    }

    const apiKey = process.env.TWO_FACTOR_API_KEY || process.env.MOBILE_NUMBER_AUTH;
    if (!apiKey) {
      console.error('[AUTH] TWO_FACTOR_API_KEY/MOBILE_NUMBER_AUTH is missing from environment variables');
      return res.status(500).json({ error: 'Authentication service temporarily unavailable' });
    }

    // Build the 2Factor send-OTP URL.
    // When SMS_TEMPLATE_NAME is set, the SMS will use a custom DLT-registered
    // template that includes the SMS Retriever app hash, enabling automatic
    // OTP detection on Android without READ_SMS permission.
    const templateName = process.env.SMS_TEMPLATE_NAME;
    const sendOtpUrl = templateName
      ? `https://2factor.in/API/V1/${apiKey}/SMS/${phone_number}/AUTOGEN/${templateName}`
      : `https://2factor.in/API/V1/${apiKey}/SMS/${phone_number}/AUTOGEN`;

    const response = await axios.get(sendOtpUrl);

    if (response.data && response.data.Status === "Success") {
      try {
        await pool.query('INSERT INTO otp_tracking (phone_number) VALUES ($1)', [phone_number]);
      } catch (err) {
        console.error('Failed to log OTP track:', err);
      }

      return res.json({
        message: 'OTP sent successfully',
        session_id: response.data.Details
      });
    } else {
      return res.status(400).json({ error: 'Failed to send OTP. Please try again later.' });
    }
  } catch (error) {
    console.error('Send OTP error:', error.message || error);
    return res.status(500).json({ error: 'Internal server error while sending OTP' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { 
      phone_number, 
      otp, 
      session_id, 
      fcm_token,
      device_id, 
      platform, 
      device_name, 
      manufacturer, 
      model, 
      os_version, 
      app_version, 
      firebase_installation_id 
    } = req.body;
    const normalizedFcmToken = normalizeFcmToken(fcm_token);

    if (!phone_number || !otp || !session_id) {
      return res.status(400).json({ error: 'phone_number, otp, and session_id are required' });
    }

    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(phone_number)) {
      return res.status(400).json({ error: 'Invalid phone number format. Must be exactly 10 digits.' });
    }

    const apiKey = process.env.TWO_FACTOR_API_KEY || process.env.MOBILE_NUMBER_AUTH;
    if (!apiKey) {
      console.error('[AUTH] TWO_FACTOR_API_KEY/MOBILE_NUMBER_AUTH is missing from environment variables');
      return res.status(500).json({ error: 'Authentication service temporarily unavailable' });
    }

    console.log(
      `[AUTH] verify-otp phone=${phone_number} hasFcmToken=${normalizedFcmToken != null}`,
    );

    // Verify OTP against 2Factor API
    try {
      const response = await axios.get(
        `https://2factor.in/API/V1/${apiKey}/SMS/VERIFY/${session_id}/${otp}`
      );
      if (!response.data || response.data.Status !== 'Success') {
        return res.status(400).json({ error: 'Invalid OTP' });
      }
    } catch (apiError) {
      console.error('2Factor verify error:', apiError.response?.data || apiError.message);
      return res.status(400).json({ error: 'Invalid OTP or expired session' });
    }

    // ===================== FIND USER =====================
    let user = await User.findByPhone(phone_number);
    let isNewUser = false;

    // ===================== CREATE USER =====================
    if (!user) {
      const isFirstTimeUser = true;
      user = await User.create({
        phone_number: phone_number,
        auth_provider: 'phone',
        fcm_token: normalizedFcmToken,
        account_type: 'user',
        is_first_time_user: isFirstTimeUser,
        offer_used: false
      });
      if (normalizedFcmToken) {
        await User.updateFcmToken(user.user_id, normalizedFcmToken);
      }
      isNewUser = true;
    } else {
      await User.updateLastLogin(user.user_id);
      if (normalizedFcmToken) {
        await User.updateFcmToken(user.user_id, normalizedFcmToken);
      }
    }

    await User.verifyUser(user.user_id);

    // Save trusted device information
    if (device_id) {
      try {
        // Check if this device_id already exists for this phone number
        const existingDevice = await pool.query(
          'SELECT id FROM trusted_devices WHERE mobile_number = $1 AND device_id = $2',
          [phone_number, device_id]
        );
        
        if (existingDevice.rows.length === 0) {
          await pool.query(`
            INSERT INTO trusted_devices 
            (mobile_number, device_id, platform, device_name, manufacturer, model, os_version, app_version, firebase_installation_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `, [phone_number, device_id, platform, device_name, manufacturer, model, os_version, app_version, firebase_installation_id]);
        } else {
          await pool.query(
            'UPDATE trusted_devices SET last_login_at = CURRENT_TIMESTAMP, is_trusted = TRUE WHERE id = $1',
            [existingDevice.rows[0].id]
          );
        }
      } catch (deviceError) {
        console.error('Failed to save trusted device:', deviceError);
        // Continue login even if trusted device save fails
      }
    }

    // ===================== JWT =====================
    const sessionId = crypto.randomUUID();
    await pool.query(
      'UPDATE users SET active_session_id = $1 WHERE user_id = $2',
      [sessionId, user.user_id]
    );

    const jwtToken = jwt.sign(
      {
        user_id: user.user_id,
        session_id: sessionId,
        provider: 'phone',
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.json({
      message: isNewUser ? 'Signup successful' : 'Login successful',
      token: jwtToken,
      user: await User.findById(user.user_id),
      isNewUser,
    });

  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(500).json({ error: 'OTP verification failed' });
  }
});

/**
 * =====================================================
 * COMPLETE PROFILE AFTER SOCIAL LOGIN
 * =====================================================
 */
router.post('/register', authenticate, async (req, res) => {
  try {
    const {
      email,
      full_name,
      display_name,
      gender,
      date_of_birth,
      city,
      country,
      avatar_url,
      bio,
      fcm_token,
      original_name,
      rate_per_minute,
      languages,
    } = req.body;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let accountType = 'user';
    if (gender && gender.toLowerCase() === 'female') {
      accountType = 'listener';
    }

    const profileUpdates = {
      email,
      full_name,
      display_name,
      gender,
      date_of_birth,
      city,
      country,
      avatar_url,
      bio,
    };
    const normalizedRegisterFcm = normalizeFcmToken(fcm_token);
    if (Object.values(profileUpdates).some((value) => value !== undefined)) {
      await User.update(user.user_id, profileUpdates);
    }
    if (normalizedRegisterFcm) {
      await User.updateFcmToken(user.user_id, normalizedRegisterFcm);
    }

    if (accountType === 'listener') {
      if (!display_name || !languages) {
        return res.status(400).json({
          error: 'Listener requires display_name and languages',
        });
      }

      const listener = await Listener.create({
        user_id: user.user_id,
        original_name: original_name || full_name,
        professional_name: display_name,
        languages: Array.isArray(languages) ? languages : [languages],
        // Rate is controlled by admin-side rule/global configuration.
        rate_per_minute: 0,
        profile_image: avatar_url,
        experience_years: 0,
      });

      await pool.query(
        "UPDATE users SET account_type = 'listener' WHERE user_id = $1",
        [user.user_id]
      );

      return res.json({
        message: 'Listener profile created',
        user: await User.findById(user.user_id),
        listener,
        accountType: 'listener',
      });
    }

    await pool.query(
      "UPDATE users SET account_type = 'user' WHERE user_id = $1",
      [user.user_id]
    );

    return res.json({
      message: 'Profile updated',
      user: await User.findById(user.user_id),
      accountType: 'user',
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Profile update failed' });
  }
});

/**
 * =====================================================
 * GET CURRENT USER
 * =====================================================
 */
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

export default router;
