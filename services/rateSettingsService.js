import { pool } from '../db.js';

const DEFAULT_DROPDOWN_SETTINGS = {
  ratingRanges: [
    { label: 'All ratings', minRating: '0', maxRating: '5' },
    { label: 'Top rated (4.5 - 5.0)', minRating: '4.5', maxRating: '5' },
    { label: 'Strong performers (4.0 - 5.0)', minRating: '4', maxRating: '5' },
    { label: 'Growing listeners (3.0 - 4.0)', minRating: '3', maxRating: '4' },
    { label: 'Needs support (0.0 - 3.0)', minRating: '0', maxRating: '3' },
  ],
  durationRanges: [
    { label: 'All call durations', minDuration: '0', maxDuration: '999999' },
    { label: 'New listeners (0 - 99 mins)', minDuration: '0', maxDuration: '99' },
    { label: 'Building history (100 - 499 mins)', minDuration: '100', maxDuration: '499' },
    { label: 'Established (500 - 999 mins)', minDuration: '500', maxDuration: '999' },
    { label: 'Highly experienced (1000+ mins)', minDuration: '1000', maxDuration: '999999' },
  ],
  ratePlans: [
    { label: 'Base plan - ₹4 user / ₹1 payout', userRate: '4', payoutRate: '1' },
    { label: 'Growth plan - ₹6 user / ₹1.50 payout', userRate: '6', payoutRate: '1.5' },
    { label: 'Preferred plan - ₹8 user / ₹2 payout', userRate: '8', payoutRate: '2' },
    { label: 'Premium plan - ₹10 user / ₹2.50 payout', userRate: '10', payoutRate: '2.5' },
    { label: 'Elite plan - ₹15 user / ₹4 payout', userRate: '15', payoutRate: '4' },
  ],
};

const toNumber = (value) => Number(value);

const isPositiveNumber = (value) => Number.isFinite(value) && value > 0;

const hasValue = (value) => value !== undefined && value !== null && String(value).trim() !== '';

const cleanLabel = (label) =>
  String(label || '')
    .replace(/\?{3}/g, '\u20B9')
    .replace(/â‚¹/g, '\u20B9');

const normalizeOptions = (options = [], defaults = []) =>
  (Array.isArray(options) && options.length ? options : defaults)
    .map((option) => ({
      ...option,
      label: cleanLabel(option.label),
    }));

const normalizeDropdownSettings = (settings = {}) => ({
  ratingRanges: normalizeOptions(settings.ratingRanges, DEFAULT_DROPDOWN_SETTINGS.ratingRanges),
  durationRanges: normalizeOptions(settings.durationRanges, DEFAULT_DROPDOWN_SETTINGS.durationRanges),
  ratePlans: normalizeOptions(settings.ratePlans, DEFAULT_DROPDOWN_SETTINGS.ratePlans),
});

const validateDropdownSettings = (settings = {}) => {
  const normalized = normalizeDropdownSettings(settings);

  for (const option of normalized.ratingRanges) {
    const min = toNumber(option.minRating);
    const max = toNumber(option.maxRating);
    if (!hasValue(option.label) || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max > 5 || min > max) {
      return { error: 'Invalid average rating options' };
    }
  }

  for (const option of normalized.durationRanges) {
    const min = toNumber(option.minDuration);
    const max = toNumber(option.maxDuration);
    if (!hasValue(option.label) || !Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
      return { error: 'Invalid call duration options' };
    }
  }

  for (const option of normalized.ratePlans) {
    const userRate = toNumber(option.userRate);
    const payoutRate = toNumber(option.payoutRate);
    if (!hasValue(option.label) || !isPositiveNumber(userRate) || !isPositiveNumber(payoutRate) || payoutRate > userRate) {
      return { error: 'Invalid rate plan options' };
    }
  }

  return { value: normalized };
};

const mapGlobalRate = (row) => ({
  configId: row.config_id,
  userRate: Number(row.user_rate),
  payoutRate: Number(row.payout_rate),
  updatedAt: row.updated_at,
});

const mapRule = (row) => ({
  ruleId: row.rule_id,
  minRating: Number(row.min_rating),
  maxRating: Number(row.max_rating),
  minDuration: Number(row.min_duration),
  maxDuration: Number(row.max_duration),
  userRate: Number(row.user_rate),
  payoutRate: Number(row.payout_rate),
  isActive: row.is_active === true,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const createDuplicateRuleError = (existingRuleId) => {
  const error = new Error('Duplicate rule: this Avg Rating + Total Duration range already exists');
  error.code = 'DUPLICATE_RATE_RULE';
  error.existingRuleId = existingRuleId || null;
  return error;
};

const findDuplicateRuleByRange = async (
  { minRating, maxRating, minDuration, maxDuration, excludeRuleId = null },
  queryable = pool
) => {
  const result = await queryable.query(
    `SELECT rule_id
     FROM listener_rate_rules
     WHERE min_rating = $1
       AND max_rating = $2
       AND min_duration = $3
       AND max_duration = $4
       AND ($5::uuid IS NULL OR rule_id <> $5::uuid)
     LIMIT 1`,
    [minRating, maxRating, minDuration, maxDuration, excludeRuleId]
  );

  return result.rows[0] || null;
};

const validateGlobalRateInput = ({ userRate, payoutRate }) => {
  const parsedUserRate = toNumber(userRate);
  const parsedPayoutRate = toNumber(payoutRate);

  if (!isPositiveNumber(parsedUserRate) || !isPositiveNumber(parsedPayoutRate)) {
    return { error: 'User rate and payout must be positive numbers' };
  }

  if (parsedPayoutRate > parsedUserRate) {
    return { error: 'Payout must be less than or equal to user rate' };
  }

  return {
    value: {
      userRate: parsedUserRate,
      payoutRate: parsedPayoutRate,
    },
  };
};

const validateRuleInput = (rule) => {
  const requiredFields = [
    'minRating',
    'maxRating',
    'minDuration',
    'maxDuration',
    'userRate',
    'payoutRate',
  ];

  if (requiredFields.some((field) => !hasValue(rule[field]))) {
    return { error: 'All rule fields are required' };
  }

  const parsed = {
    minRating: toNumber(rule.minRating),
    maxRating: toNumber(rule.maxRating),
    minDuration: toNumber(rule.minDuration),
    maxDuration: toNumber(rule.maxDuration),
    userRate: toNumber(rule.userRate),
    payoutRate: toNumber(rule.payoutRate),
    isActive: rule.isActive !== false,
  };

  if (!Number.isFinite(parsed.minRating) || !Number.isFinite(parsed.maxRating)) {
    return { error: 'Rating range is required' };
  }

  if (parsed.minRating < 0 || parsed.maxRating > 5 || parsed.minRating > parsed.maxRating) {
    return { error: 'Rating range must be between 0 and 5' };
  }

  if (!Number.isFinite(parsed.minDuration) || !Number.isFinite(parsed.maxDuration)) {
    return { error: 'Call duration range is required' };
  }

  if (parsed.minDuration < 0 || parsed.maxDuration < 0 || parsed.minDuration > parsed.maxDuration) {
    return { error: 'Call duration range must be valid' };
  }

  if (!isPositiveNumber(parsed.userRate) || !isPositiveNumber(parsed.payoutRate)) {
    return { error: 'User rate and payout must be positive numbers' };
  }

  if (parsed.payoutRate > parsed.userRate) {
    return { error: 'Payout must be less than or equal to user rate' };
  }

  return { value: parsed };
};

const getGlobalRate = async (queryable = pool) => {
  const result = await queryable.query(
    `SELECT config_id, user_rate, payout_rate, updated_at
     FROM listener_global_rate_config
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (result.rows.length > 0) {
    return mapGlobalRate(result.rows[0]);
  }
  return null;
};

const upsertGlobalRate = async ({ userRate, payoutRate, adminId }) => {
  const result = await pool.query(
    `INSERT INTO listener_global_rate_config (singleton_key, user_rate, payout_rate, updated_by, updated_at)
     VALUES (TRUE, $1, $2, $3, CURRENT_TIMESTAMP)
     ON CONFLICT (singleton_key)
     DO UPDATE SET
       user_rate = EXCLUDED.user_rate,
       payout_rate = EXCLUDED.payout_rate,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP
     RETURNING config_id, user_rate, payout_rate, updated_at`,
    [userRate, payoutRate, adminId || null]
  );

  return mapGlobalRate(result.rows[0]);
};

const listRateRules = async () => {
  const result = await pool.query(
    `SELECT rule_id, min_rating, max_rating, min_duration, max_duration,
            user_rate, payout_rate, is_active, created_at, updated_at
     FROM listener_rate_rules
     ORDER BY is_active DESC, min_rating DESC, min_duration DESC, updated_at DESC`
  );

  return result.rows.map(mapRule);
};

const createRateRule = async (rule, adminId) => {
  const duplicate = await findDuplicateRuleByRange({
    minRating: rule.minRating,
    maxRating: rule.maxRating,
    minDuration: rule.minDuration,
    maxDuration: rule.maxDuration,
  });
  if (duplicate) {
    throw createDuplicateRuleError(duplicate.rule_id);
  }

  const result = await pool.query(
    `INSERT INTO listener_rate_rules (
       min_rating, max_rating, min_duration, max_duration,
       user_rate, payout_rate, is_active, updated_by
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING rule_id, min_rating, max_rating, min_duration, max_duration,
               user_rate, payout_rate, is_active, created_at, updated_at`,
    [
      rule.minRating,
      rule.maxRating,
      rule.minDuration,
      rule.maxDuration,
      rule.userRate,
      rule.payoutRate,
      rule.isActive,
      adminId || null,
    ]
  );

  return mapRule(result.rows[0]);
};

const updateRateRule = async (ruleId, rule, adminId) => {
  const duplicate = await findDuplicateRuleByRange({
    minRating: rule.minRating,
    maxRating: rule.maxRating,
    minDuration: rule.minDuration,
    maxDuration: rule.maxDuration,
    excludeRuleId: ruleId,
  });
  if (duplicate) {
    throw createDuplicateRuleError(duplicate.rule_id);
  }

  const result = await pool.query(
    `UPDATE listener_rate_rules
     SET min_rating = $2,
         max_rating = $3,
         min_duration = $4,
         max_duration = $5,
         user_rate = $6,
         payout_rate = $7,
         is_active = $8,
         updated_by = $9,
         updated_at = CURRENT_TIMESTAMP
     WHERE rule_id = $1
     RETURNING rule_id, min_rating, max_rating, min_duration, max_duration,
               user_rate, payout_rate, is_active, created_at, updated_at`,
    [
      ruleId,
      rule.minRating,
      rule.maxRating,
      rule.minDuration,
      rule.maxDuration,
      rule.userRate,
      rule.payoutRate,
      rule.isActive,
      adminId || null,
    ]
  );

  return result.rows[0] ? mapRule(result.rows[0]) : null;
};

const deleteRateRule = async (ruleId) => {
  const result = await pool.query(
    'DELETE FROM listener_rate_rules WHERE rule_id = $1 RETURNING rule_id',
    [ruleId]
  );
  return result.rowCount > 0;
};

const getDropdownSettings = async () => {
  const result = await pool.query(
    `SELECT settings, updated_at
     FROM listener_rate_dropdown_settings
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (result.rows.length > 0) {
    return {
      settings: normalizeDropdownSettings(result.rows[0].settings || {}),
      updatedAt: result.rows[0].updated_at,
    };
  }

  const created = await pool.query(
    `INSERT INTO listener_rate_dropdown_settings (settings)
     VALUES ($1)
     RETURNING settings, updated_at`,
    [DEFAULT_DROPDOWN_SETTINGS]
  );

  return {
    settings: normalizeDropdownSettings(created.rows[0].settings || {}),
    updatedAt: created.rows[0].updated_at,
  };
};

const updateDropdownSettings = async (settings, adminId) => {
  const validation = validateDropdownSettings(settings);
  if (validation.error) return validation;

  const result = await pool.query(
    `INSERT INTO listener_rate_dropdown_settings (singleton_key, settings, updated_by, updated_at)
     VALUES (TRUE, $1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (singleton_key)
     DO UPDATE SET
       settings = EXCLUDED.settings,
       updated_by = EXCLUDED.updated_by,
       updated_at = CURRENT_TIMESTAMP
     RETURNING settings, updated_at`,
    [validation.value, adminId || null]
  );

  return {
    value: {
      settings: normalizeDropdownSettings(result.rows[0].settings || {}),
      updatedAt: result.rows[0].updated_at,
    },
  };
};

const getListenerRateInputs = async (listenerId, queryable = pool) => {
  const result = await queryable.query(
    `SELECT
       l.listener_id,
       COALESCE(r_agg.average_rating, 0) AS average_rating,
       COALESCE(c_agg.total_call_minutes, 0) AS total_call_minutes
     FROM listeners l
     LEFT JOIN (
       SELECT listener_id, ROUND(AVG(rating)::numeric, 2) AS average_rating
       FROM ratings
       GROUP BY listener_id
     ) r_agg ON r_agg.listener_id = l.listener_id
     LEFT JOIN (
       SELECT
         c.listener_id,
         COALESCE(
           SUM(
             COALESCE(
               NULLIF(c.billed_minutes, 0),
               NULLIF(cr.minutes, 0),
               CASE
                 WHEN COALESCE(c.duration_seconds, 0) > 0
                 THEN CEIL(c.duration_seconds / 60.0)
                 ELSE 0
               END
             )
           ),
           0
         )::numeric(10, 1) AS total_call_minutes
       FROM calls c
       LEFT JOIN call_records cr ON cr.call_id = c.call_id
       WHERE c.status = 'completed'
       GROUP BY c.listener_id
     ) c_agg ON c_agg.listener_id = l.listener_id
     WHERE l.listener_id = $1`,
    [listenerId]
  );

  return result.rows[0] || null;
};

const resolveRateForListener = async (listenerId, queryable = pool) => {
  const listener = await getListenerRateInputs(listenerId, queryable);
  if (!listener) return null;

  const averageRating = Number(listener.average_rating || 0);
  const totalCallMinutes = Number(listener.total_call_minutes || 0);

  const matchingRule = await queryable.query(
    `SELECT rule_id, min_rating, max_rating, min_duration, max_duration,
            user_rate, payout_rate, is_active, created_at, updated_at
     FROM listener_rate_rules
     WHERE is_active = TRUE
       AND $1 BETWEEN min_rating AND max_rating
       AND $2 BETWEEN min_duration AND max_duration
     ORDER BY min_rating DESC, min_duration DESC, updated_at DESC
     LIMIT 1`,
    [averageRating, totalCallMinutes]
  );

  if (matchingRule.rows.length > 0) {
    const rule = mapRule(matchingRule.rows[0]);
    return {
      userRate: rule.userRate,
      payoutRate: rule.payoutRate,
      source: 'rule',
      rule,
      averageRating,
      totalCallMinutes,
    };
  }

  const globalRate = await getGlobalRate(queryable);
  if (!globalRate) {
    return {
      userRate: null,
      payoutRate: null,
      source: 'none',
      rule: null,
      averageRating,
      totalCallMinutes,
    };
  }
  return {
    userRate: globalRate.userRate,
    payoutRate: globalRate.payoutRate,
    source: 'global',
    rule: null,
    averageRating,
    totalCallMinutes,
  };
};

export {
  validateGlobalRateInput,
  validateRuleInput,
  getGlobalRate,
  upsertGlobalRate,
  listRateRules,
  createRateRule,
  updateRateRule,
  deleteRateRule,
  getDropdownSettings,
  updateDropdownSettings,
  resolveRateForListener,
};
