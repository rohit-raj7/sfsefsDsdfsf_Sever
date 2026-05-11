import { body, param, query, validationResult } from 'express-validator';

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Phone number validation
const validatePhoneNumber = [
  body('phone_number')
    .notEmpty()
    .withMessage('Phone number is required')
    .matches(/^\+?[1-9]\d{1,14}$/)
    .withMessage('Invalid phone number format'),
  handleValidationErrors
];

// OTP validation
const validateOTP = [
  body('phone_number')
    .notEmpty()
    .withMessage('Phone number is required'),
  body('otp')
    .notEmpty()
    .withMessage('OTP is required')
    .isLength({ min: 6, max: 6 })
    .withMessage('OTP must be 6 digits'),
  handleValidationErrors
];

// User registration validation
const validateUserRegistration = [
  body('display_name')
    .optional()
    .isLength({ min: 2, max: 50 })
    .withMessage('Display name must be between 2 and 50 characters'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Invalid email format'),
  body('gender')
    .optional()
    .isIn(['Male', 'Female', 'Other'])
    .withMessage('Gender must be Male, Female, or Other'),
  body('city')
    .optional()
    .isLength({ min: 2, max: 100 })
    .withMessage('City name is invalid'),
  handleValidationErrors
];

// Listener profile validation
const validateListenerProfile = [
  body('professional_name')
    .notEmpty()
    .withMessage('Professional name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Professional name must be between 2 and 100 characters'),
  body('rate_per_minute')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Rate must be a positive number'),
  body('specialties')
    .notEmpty()
    .withMessage('At least one specialty is required')
    .isArray({ min: 1 })
    .withMessage('Specialties must be an array with at least one item'),
  body('languages')
    .notEmpty()
    .withMessage('At least one language is required')
    .isArray({ min: 1 })
    .withMessage('Languages must be an array with at least one item'),
  handleValidationErrors
];

// Call creation validation
const validateCallCreation = [
  body('listener_id')
    .notEmpty()
    .withMessage('Listener ID is required')
    .isUUID()
    .withMessage('Invalid listener ID format'),
  body('call_type')
    .optional()
    .isIn(['audio', 'video', 'random'])
    .withMessage('Call type must be audio, video, or random'),
  handleValidationErrors
];

// Rating validation
const validateRating = [
  body('rating')
    .notEmpty()
    .withMessage('Rating is required')
    .isFloat({ min: 1, max: 5 })
    .withMessage('Rating must be between 1 and 5'),
  body('review_text')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Review text must not exceed 500 characters'),
  handleValidationErrors
];

// Message validation
const validateMessage = [
  body('message_content')
    .notEmpty()
    .withMessage('Message content is required')
    .isLength({ max: 2000 })
    .withMessage('Message is too long (max 2000 characters)'),
  body('message_type')
    .optional()
    .isIn(['text', 'image', 'audio', 'video', 'file'])
    .withMessage('Invalid message type'),
  handleValidationErrors
];

// UUID parameter validation
const validateUUIDParam = (paramName) => [
  param(paramName)
    .isUUID()
    .withMessage(`Invalid ${paramName} format`),
  handleValidationErrors
];

// Pagination validation
const validatePagination = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Offset must be a non-negative integer'),
  handleValidationErrors
];

export {
  handleValidationErrors,
  validatePhoneNumber,
  validateOTP,
  validateUserRegistration,
  validateListenerProfile,
  validateCallCreation,
  validateRating,
  validateMessage,
  validateUUIDParam,
  validatePagination
};
