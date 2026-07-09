/**
 * middleware/validate.js
 * Joi-based request validation middleware factory.
 */

'use strict';

const Joi = require('joi');

/**
 * validate(schema) – validates req.body against a Joi schema.
 * Returns 422 with field-level errors on failure.
 */
function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly:   false,
      stripUnknown: true,
      convert:      true,
    });

    if (error) {
      const details = error.details.map(d => ({
        field:   d.context.key || d.path.join('.'),
        message: d.message.replace(/['"]/g, ''),
      }));
      return res.status(422).json({ error: 'Validation failed.', details });
    }

    req.body = value; // use sanitised/coerced value
    next();
  };
}

// ─── Shared schemas ────────────────────────────────────────────────────────

const itemNumberSchema = Joi.string()
  .trim()
  .min(1)
  .max(40)
  .pattern(/^[A-Za-z0-9\-_]+$/)
  .required()
  .messages({
    'string.pattern.base': 'Item Number may only contain letters, numbers, hyphens and underscores.',
  });

const schemas = {
  login: Joi.object({
    username:  Joi.string().trim().min(3).max(32).pattern(/^[A-Za-z0-9._-]+$/).required()
      .messages({ 'string.pattern.base': 'Username may only contain letters, numbers, dots, hyphens and underscores (e.g. firstname.lastname).' }),
    password: Joi.string().max(128).required(),
  }),

  startTimer: Joi.object({
    itemNumber:      itemNumberSchema,
    timeCheck:       Joi.boolean().optional().default(false),
    workstation:     Joi.string().trim().max(100).optional().allow('', null),
    woNumber:        Joi.string().trim().max(100).optional().allow('', null),
    routeCardNumber: Joi.string().trim().max(50).optional().allow('', null),
    quantity:        Joi.number().integer().min(1).max(999).optional().default(1),
    timerCategory:   Joi.string().valid('work', 'rework').optional().default('work'),
  }),

  stopTimer: Joi.object({
    notes: Joi.string().trim().max(500).optional().allow('', null),
  }),

  cancelTimer: Joi.object({
    reason: Joi.string().trim().max(500).required(),
  }),

  adjustTimer: Joi.object({
    startedAt:   Joi.string().isoDate().optional(),
    completedAt: Joi.string().isoDate().optional(),
    reason:      Joi.string().trim().max(500).required(),
    notes:       Joi.string().trim().max(500).optional().allow('', null),
  }).or('startedAt', 'completedAt'),

  createUser: Joi.object({
    username:  Joi.string().trim().min(3).max(32).pattern(/^[A-Za-z0-9._-]+$/).required()
  .messages({ 'string.pattern.base': 'Username may only contain letters, numbers, dots, hyphens and underscores (e.g. firstname.lastname).' }),
    password:  Joi.string().min(8).max(64).required(),
    full_name: Joi.string().trim().min(2).max(100).required(),
    role:      Joi.string().valid('operator','supervisor','manager','administrator').required(),
  }),

  updateUser: Joi.object({
    full_name:  Joi.string().trim().min(2).max(100).optional(),
    role:       Joi.string().valid('operator','supervisor','manager','administrator').optional(),
    department: Joi.string().valid('Production','Stores','Test and Inspection','PCB').optional(),
    is_active:  Joi.boolean().optional(),
  }).min(1),

  resetPassword: Joi.object({
    password: Joi.string().min(8).max(64).required(),
  }),
};

module.exports = { validate, schemas };