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
  .pattern(/^[A-Za-z0-9\-_\/]+$/)
  .required()
  .messages({
    'string.pattern.base': 'Item Number may only contain letters, numbers, hyphens, underscores and slashes.',
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
    role:      Joi.string().valid('operator','supervisor','manager','planner','administrator').required(),
  }),

  updateUser: Joi.object({
    full_name:  Joi.string().trim().min(2).max(100).optional(),
    role:       Joi.string().valid('operator','supervisor','manager','planner','administrator').optional(),
    department: Joi.string().valid('Production','Stores','Test and Inspection','PCB').optional(),
    is_active:  Joi.boolean().optional(),
  }).min(1),

  resetPassword: Joi.object({
    password: Joi.string().min(8).max(64).required(),
  }),

  plannedWork: Joi.object({
    itemNumber:       itemNumberSchema,
    woNumber:         Joi.string().trim().max(100).optional().allow('', null),
    worksOrder:       Joi.string().trim().max(100).optional().allow('', null),
    startDate:        Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
      .messages({ 'string.pattern.base': 'Start date must be a valid date (YYYY-MM-DD).' }),
    quantity:         Joi.number().integer().min(1).max(9999).required(),
    estimatedHours:   Joi.number().integer().min(0).max(999).optional().allow(null),
    estimatedMinutes: Joi.number().integer().min(0).max(59).optional().allow(null),
    department:       Joi.string().valid('Production','Stores','Test and Inspection','PCB').optional().allow('', null),
    sourceRequiredBy: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional().allow(null),
    sourcePoLine:     Joi.string().trim().max(20).optional().allow('', null),
    sourceOrderedQty: Joi.number().integer().min(0).optional().allow(null),
  }),

  plannedWorkUpdate: Joi.object({
    itemNumber:       itemNumberSchema.optional(),
    woNumber:         Joi.string().trim().max(100).optional().allow('', null),
    worksOrder:       Joi.string().trim().max(100).optional().allow('', null),
    startDate:        Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
    quantity:         Joi.number().integer().min(1).max(9999).optional(),
    estimatedHours:   Joi.number().integer().min(0).max(999).optional().allow(null),
    estimatedMinutes: Joi.number().integer().min(0).max(59).optional().allow(null),
    department:       Joi.string().valid('Production','Stores','Test and Inspection','PCB').optional().allow('', null),
  }).min(1),

  plannerAssignees: Joi.object({
    userIds: Joi.array().items(Joi.string().trim().max(64)).max(50).required(),
  }),

  plannerMobImport: Joi.object({
    dryRun: Joi.boolean().default(false),
    rows: Joi.array().max(500).min(1).required().items(Joi.object({
      itemNumber:      Joi.string().trim().max(60).required(),
      worksOrder:      Joi.string().trim().max(60).allow('', null),
      custRef:         Joi.string().trim().max(60).allow('', null),
      description:     Joi.string().trim().max(200).allow('', null),
      quantity:        Joi.number().integer().min(1).max(100000).required(),
      commitmentDate:  Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
      commitmentValue: Joi.number().min(0).allow(null),
    })),
  }),

  orderBookUpload: Joi.object({
    customer: Joi.string().trim().min(1).max(60).required(),
    rows: Joi.array().max(10000).items(Joi.object({
      poNumber:    Joi.string().trim().max(40).allow('', null),
      poLine:      Joi.string().trim().max(20).allow('', null),
      itemNumber:  Joi.string().trim().max(60).required(),
      description: Joi.string().trim().max(200).allow('', null),
      // Dates arrive pre-normalised by the client to ISO, or null (the 9999 sentinel).
      requiredBy:  Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
      dueDate:     Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
      quantity:    Joi.number().integer().min(0).required(),
      lineValue:   Joi.number().allow(null),
      rework:      Joi.boolean().default(false),
    })).required(),
  }),

  // Push/Pull weekly upload: two .xlsx files as base64 (parsed server-side).
  pushPullSnapshot: Joi.object({
    customer:     Joi.string().trim().min(1).max(60).required(),
    snapshotDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
      .messages({ 'string.pattern.base': 'Snapshot date must be a valid date (YYYY-MM-DD).' }),
    orderBookB64: Joi.string().base64().max(16000000).required(),
    priorityB64:  Joi.string().base64().max(16000000).required(),
  }),

  // ── CRM / RFQ ───────────────────────────────────────────────────────────────
  // contactEmail is a loose string, not Joi.email(): the historical data (and a
  // phoned-in request) may carry a name or a messy value, not a clean address.
  customerCreate: Joi.object({
    name:  Joi.string().trim().min(1).max(120).required(),
    code:  Joi.string().trim().max(40).allow('', null),
    notes: Joi.string().trim().max(1000).allow('', null),
  }),

  rfqCreate: Joi.object({
    customerId:             Joi.string().trim().max(64).required(),
    partNumber:             Joi.string().trim().max(100).allow('', null),
    partName:               Joi.string().trim().max(200).allow('', null),
    revision:               Joi.string().trim().max(40).allow('', null),
    coNumber:               Joi.string().trim().max(40).allow('', null),
    quoteType:              Joi.string().valid('new', 'up_rev').allow(null),
    priority:               Joi.string().valid('A', 'B', 'C').allow(null),
    dateRequiredBy:         Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
    freeIssue:              Joi.boolean().allow(null),
    potentialUnitsAnnual:   Joi.number().integer().min(0).allow(null),
    potentialRevenueAnnual: Joi.number().min(0).allow(null),
    requestComments:        Joi.string().trim().max(4000).allow('', null),
    contactEmail:           Joi.string().trim().max(200).allow('', null),
    buildMinutes:           Joi.number().integer().min(0).max(100000).allow(null),
    inspectionMinutes:      Joi.number().integer().min(0).max(100000).allow(null),
    testMinutes:            Joi.number().integer().min(0).max(100000).allow(null),
    quotedValue:            Joi.number().min(0).allow(null),
    quoteRef:               Joi.string().trim().max(60).allow('', null),
    quotedAt:               Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
    status:                 Joi.string().valid('open', 'awaiting_response', 'completed', 'declined').default('open'),
    assignees:              Joi.array().max(20).items(Joi.object({
                              userId: Joi.string().trim().max(64).allow(null),
                              name:   Joi.string().trim().max(120).allow('', null),
                            })).default([]),
  }),

  rfqUpdate: Joi.object({
    customerId:             Joi.string().trim().max(64),
    partNumber:             Joi.string().trim().max(100).allow('', null),
    partName:               Joi.string().trim().max(200).allow('', null),
    revision:               Joi.string().trim().max(40).allow('', null),
    coNumber:               Joi.string().trim().max(40).allow('', null),
    quoteType:              Joi.string().valid('new', 'up_rev').allow(null),
    priority:               Joi.string().valid('A', 'B', 'C').allow(null),
    dateRequiredBy:         Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
    freeIssue:              Joi.boolean().allow(null),
    potentialUnitsAnnual:   Joi.number().integer().min(0).allow(null),
    potentialRevenueAnnual: Joi.number().min(0).allow(null),
    requestComments:        Joi.string().trim().max(4000).allow('', null),
    contactEmail:           Joi.string().trim().max(200).allow('', null),
    buildMinutes:           Joi.number().integer().min(0).max(100000).allow(null),
    inspectionMinutes:      Joi.number().integer().min(0).max(100000).allow(null),
    testMinutes:            Joi.number().integer().min(0).max(100000).allow(null),
    quotedValue:            Joi.number().min(0).allow(null),
    quoteRef:               Joi.string().trim().max(60).allow('', null),
    quotedAt:               Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow(null),
    status:                 Joi.string().valid('open', 'awaiting_response', 'completed', 'declined'),
    assignees:              Joi.array().max(20).items(Joi.object({
                              userId: Joi.string().trim().max(64).allow(null),
                              name:   Joi.string().trim().max(120).allow('', null),
                            })),
  }).min(1),

  rfqEvent: Joi.object({
    type:       Joi.string().valid('comment', 'status_change', 'assignment', 'quote_issued', 'customer_message', 'other').default('comment'),
    body:       Joi.string().trim().max(4000).allow('', null),
    visibility: Joi.string().valid('internal', 'customer').default('internal'),
  }),
};

module.exports = { validate, schemas };