import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Admin from '../models/Admin.js';
import config from '../config/config.js';

// Middleware to authenticate user via JWT
const authenticate = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret);

    // Get user from database
    const user = await User.findById(decoded.user_id);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    // Attach user info to request
    req.userId = user.user_id;
    req.user = user;

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// Middleware to check if user is a listener
const isListener = async (req, res, next) => {
  try {
    if (!req.user || req.user.account_type === 'user') {
      return res.status(403).json({ error: 'Listener access required' });
    }
    next();
  } catch (error) {
    console.error('Listener check error:', error);
    return res.status(500).json({ error: 'Authorization check failed' });
  }
};

// Middleware to check if user is verified
const isVerified = (req, res, next) => {
  if (!req.user || !req.user.is_verified) {
    return res.status(403).json({ error: 'Account verification required' });
  }
  next();
};

// Middleware to authenticate admin via JWT
const authenticateAdmin = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];

    // Verify token
    const decoded = jwt.verify(token, config.jwt.secret);

    // Check if it's an admin token (has admin_id)
    if (!decoded.admin_id) {
      return res.status(401).json({ error: 'Invalid admin token' });
    }

    // Get admin from database
    const admin = await Admin.findByEmail(decoded.email);

    if (!admin || !admin.is_active) {
      return res.status(401).json({ error: 'Admin not found or inactive' });
    }

    // Attach admin info to request
    req.adminId = admin.admin_id;
    req.admin = admin;

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Admin authentication error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

export { authenticate, isListener, isVerified, authenticateAdmin };
