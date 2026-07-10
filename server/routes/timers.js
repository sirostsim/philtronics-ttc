/**

 * routes/timers.js – timer CRUD (PostgreSQL version)

 */



'use strict';



const express  = require('express');

const { v4: uuidv4 } = require('uuid');

const { query, queryOne } = require('../db');

const { requireAuth, hasRole } = require('../middleware/auth');

const { validate, schemas }    = require('../middleware/validate');

const { pushToRole }           = require('./messages');



const router = express.Router();

router.use(requireAuth);



// ─── Helpers ──────────────────────────────────────────────────────────────────

async function writeAudit(timerId, action, performedBy, reason, details) {

  await query(

    `INSERT INTO audit_log (id, timer_id, action, performed_by, reason, details)

     VALUES ($1, $2, $3, $4, $5, $6)`,

    [uuidv4(), timerId, action, performedBy, reason || null, details ? JSON.stringify(details) : null]

  );

}



function formatTimer(t) {

  // Net elapsed excludes paused time -- used for display on wallboard/timer

  const now       = Date.now();

  const startedMs = new Date(t.started_at).getTime();

  const pausedMs  = t.paused_at ? new Date(t.paused_at).getTime() : now;

  const rawElapsed = Math.floor((pausedMs - startedMs) / 1000);

  const netElapsed = Math.max(0, rawElapsed - (t.total_paused_seconds || 0));



  return {

    id:                 t.id,

    itemNumber:         t.item_number,

    operatorId:         t.operator_id,

    operatorName:       t.operator_name,

    startedAt:          t.started_at,

    completedAt:        t.completed_at,

    durationSeconds:    t.duration_seconds,

    status:             t.status,

    // Pause state

    isPaused:           !!t.paused_at,

    pausedAt:           t.paused_at || null,

    pauseReason:        t.pause_reason || null,

    pauseType:          t.pause_type || null,

    totalPausedSeconds: t.total_paused_seconds || 0,

    netElapsedSeconds:  netElapsed,

    // Other fields

    timeCheck:          !!t.time_check,

    workstation:        t.workstation,

    woNumber:           t.wo_number,

    routeCardNumber:    t.route_card_number,

    quantity:           t.quantity != null ? t.quantity : 1,

    runId:              t.run_id || null,

    timerCategory:      t.timer_category || 'work',

    notes:              t.notes,

    createdAt:          t.created_at,

    targetSeconds:      t.target_hours != null

                          ? (t.target_hours * 3600) + (t.target_minutes * 60)

                          : null,

    targetHours:        t.target_hours   != null ? t.target_hours   : null,

    targetMinutes:      t.target_minutes != null ? t.target_minutes : null,

    handRaised:         !!t.hand_raised,

    department:         t.department || 'Production',

    // Only present when the row was joined against users (the list query).
    // Detail/start/stop rows select from timers alone, so this stays null and
    // the client falls back to initials.
    avatarUrl:          t.avatar_url || null,

  };

}



// ─── POST /api/timers/start ───────────────────────────────────────────────────

router.post('/start', validate(schemas.startTimer), async (req, res) => {

  try {

    const { itemNumber, timeCheck, workstation, woNumber, routeCardNumber, timerCategory } = req.body;

    const user = req.user;



    // Quantity: how many contiguous route cards this single run covers.

    // Server-enforced (never trust the client): positive integer, default 1,

    // and only permitted above 1 when the route card is all-numeric, since on

    // completion the run expands into that many contiguous route cards.

    let quantity = parseInt(req.body.quantity, 10);

    if (isNaN(quantity) || quantity < 1) quantity = 1;

    if (quantity > 999) quantity = 999;

    const rcTrim = String(routeCardNumber || '').trim();

    if (quantity > 1 && !/^[0-9]+$/.test(rcTrim)) {

      return res.status(400).json({

        error: 'A multi-quantity run needs a numeric starting Route Card number (the run covers contiguous cards from that number).',

      });

    }



    const existing = await queryOne(

      `SELECT id FROM timers WHERE operator_id = $1 AND status = 'active' LIMIT 1`,

      [user.id]

    );

    if (existing) {

      return res.status(409).json({

        error: 'You already have an active timer running. Stop it before starting a new one.',

        activeTimerId: existing.id,

      });

    }



    const id        = uuidv4();

    const startedAt = new Date().toISOString();

    // Look up operator's full record to get department

    const operatorRecord = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);

    const department = operatorRecord?.department || 'Production';



    await query(

      `INSERT INTO timers (id, item_number, operator_id, operator_name, started_at, status, time_check, workstation, wo_number, route_card_number, quantity, timer_category, department, created_by)

       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13)`,

      [id, itemNumber, user.id, user.full_name, startedAt, timeCheck || false, workstation || null, woNumber || null, routeCardNumber || null, quantity, timerCategory || 'work', department, user.id]

    );



    // If the operator had a standalone hand raised, carry it onto this job and

    // close the standalone record (so the hand stays raised seamlessly).

    try {

      const carried = await query(

        `UPDATE standalone_hands SET lowered_at = NOW(), transferred = TRUE

         WHERE operator_id = $1 AND lowered_at IS NULL RETURNING id`,

        [user.id]

      );

      if (carried.length) {

        await query('UPDATE timers SET hand_raised = TRUE WHERE id = $1', [id]);

        pushToRole('supervisor', { type: 'hands_changed' });

      }

    } catch (_) { /* table not present yet */ }



    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [id]);

    res.status(201).json(formatTimer(timer));

  } catch (err) {

    // Unique constraint violation = race condition, two starts at same time

    if (err.code === '23505') {

      return res.status(409).json({ error: 'You already have an active timer running.' });

    }

    console.error('Start timer error:', err.message);

    res.status(500).json({ error: 'Could not start timer. Please try again.' });

  }

});



// ─── POST /api/timers/:id/stop ────────────────────────────────────────────────

router.post('/:id/stop', validate(schemas.stopTimer), async (req, res) => {

  try {

    const user  = req.user;

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);



    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });

    if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {

      return res.status(403).json({ error: "You cannot stop another operator's timer." });

    }



    const { notes } = req.body;



    // If paused, accumulate final pause period before stopping

    if (timer.paused_at) {

      await query(

        `UPDATE timers SET

           total_paused_seconds = total_paused_seconds +

             EXTRACT(EPOCH FROM (NOW() - paused_at))::int,

           paused_at = NULL, pause_reason = NULL, pause_type = NULL

         WHERE id = $1`,

        [timer.id]

      );

      // Reload to get updated total_paused_seconds

      const refreshed = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);

      Object.assign(timer, refreshed);

    }



    // Net duration = total elapsed minus all paused time

    const completedAt     = new Date().toISOString();

    const rawSeconds      = Math.round((Date.now() - new Date(timer.started_at).getTime()) / 1000);

    const durationSeconds = Math.max(0, rawSeconds - (timer.total_paused_seconds || 0));



    await query(

      `UPDATE timers

       SET completed_at = $1, duration_seconds = $2, status = 'completed',

           notes = COALESCE($3, notes), updated_at = NOW(), updated_by = $4

       WHERE id = $5`,

      [completedAt, durationSeconds, notes || null, user.id, timer.id]

    );



    // ── Multi-card run expansion ──────────────────────────────────────────────

    // If this run covered several contiguous route cards (quantity > 1 with a

    // numeric starting card), expand it into one completed row per card so each

    // card is individually traceable and independently reworkable. The time is

    // divided as evenly as possible; any remainder stays on the first card so the

    // per-card durations sum back to the full run duration exactly (this keeps

    // productivity — which sums duration per operator — correct, while each card

    // carries its own per-item build time).

    const runQty   = timer.quantity || 1;

    const startCard = /^[0-9]+$/.test(String(timer.route_card_number || '').trim())

                      ? parseInt(timer.route_card_number, 10) : NaN;

    if (runQty > 1 && !isNaN(startCard)) {

      const base      = Math.floor(durationSeconds / runQty);

      const remainder = durationSeconds - base * runQty;

      const runId     = uuidv4();

      try {

        // First card = the original row: keep it, set its share + run linkage,

        // and mark it as a single card now (quantity 1).

        await query(

          `UPDATE timers

             SET route_card_number = $1, duration_seconds = $2, quantity = 1, run_id = $3,

                 updated_at = NOW()

           WHERE id = $4`,

          [String(startCard), base + remainder, runId, timer.id]

        );

        // Remaining cards = new completed rows, cloned from the original.

        for (let i = 1; i < runQty; i++) {

          await query(

            `INSERT INTO timers

               (id, item_number, operator_id, operator_name, started_at, completed_at,

                duration_seconds, status, time_check, workstation, wo_number,

                route_card_number, quantity, run_id, timer_category, department,

                total_paused_seconds, created_by, updated_by)

             VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',$8,$9,$10,$11,1,$12,$13,$14,0,$15,$15)`,

            [

              uuidv4(), timer.item_number, timer.operator_id, timer.operator_name,

              timer.started_at, completedAt, base, timer.time_check || false,

              timer.workstation || null, timer.wo_number || null,

              String(startCard + i), runId, timer.timer_category || 'work',

              timer.department || 'Production', user.id,

            ]

          );

        }

      } catch (expandErr) {

        // If expansion fails, the original single completed row still stands —

        // the run is recorded, just not split. Log for follow-up.

        console.error('Run expansion error (run recorded as single row):', expandErr.message);

      }

    }



    // Close any open unavailability period for this timer (e.g. stopped while

    // paused under a non-available reason).

    try {

      await query(

        `UPDATE unavailability_periods SET ended_at = NOW()

         WHERE timer_id = $1 AND ended_at IS NULL`,

        [timer.id]

      );

    } catch (e) { /* table may not exist yet — non-fatal */ }



    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);



    // Time Check jobs become a pending target review for managers.

    if (updated.time_check) {

      await query(

        `UPDATE timers SET tc_review_status = 'pending' WHERE id = $1`,

        [updated.id]

      );

      const tgt = await queryOne(

        'SELECT hours, minutes FROM target_times WHERE item_number = $1',

        [updated.item_number]

      );

      // Live nudge to any connected managers; the homepage queue is the durable copy.

      pushToRole('manager', {

        type:                 'time_check_review',

        timerId:              updated.id,

        itemNumber:           updated.item_number,

        operatorName:         updated.operator_name,

        measuredSeconds:      updated.duration_seconds,

        currentTargetSeconds: tgt ? (tgt.hours * 3600) + (tgt.minutes * 60) : null,

        completedAt:          updated.completed_at,

      });

    }



    res.json(formatTimer(updated));

  } catch (err) {

    console.error('Stop timer error:', err.message);

    res.status(500).json({ error: 'Could not stop timer. Please try again.' });

  }

});



// ─── POST /api/timers/:id/cancel ──────────────────────────────────────────────

router.post('/:id/cancel', validate(schemas.cancelTimer), async (req, res) => {

  try {

    const user  = req.user;

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);



    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });



    const { reason } = req.body;

    const ageSeconds = Math.round((Date.now() - new Date(timer.started_at).getTime()) / 1000);



    if (ageSeconds > 60) {

      if (!hasRole(user, 'supervisor')) {

        return res.status(403).json({

          error: 'Timer is older than 60 seconds. Only a Supervisor or above can cancel it.',

        });

      }

    } else {

      if (timer.operator_id !== user.id && !hasRole(user, 'supervisor')) {

        return res.status(403).json({ error: "You cannot cancel another operator's timer." });

      }

    }



    await query(

      `UPDATE timers SET status = 'cancelled', updated_at = NOW(), updated_by = $1 WHERE id = $2`,

      [user.id, timer.id]

    );

    try {

      await query(

        `UPDATE unavailability_periods SET ended_at = NOW()

         WHERE timer_id = $1 AND ended_at IS NULL`,

        [timer.id]

      );

    } catch (e) { /* table may not exist yet — non-fatal */ }

    await writeAudit(timer.id, 'cancel', user.id, reason, { ageSeconds });



    res.json({ ok: true, timerId: timer.id });

  } catch (err) {

    console.error('Cancel timer error:', err.message);

    res.status(500).json({ error: 'Could not cancel timer. Please try again.' });

  }

});



// ─── PATCH /api/timers/:id ────────────────────────────────────────────────────

router.patch('/:id', validate(schemas.adjustTimer), async (req, res) => {

  if (!hasRole(req.user, 'supervisor')) {

    return res.status(403).json({ error: 'Only Supervisors and above can adjust timers.' });

  }

  try {

    const timer = await queryOne(

      `SELECT t.*, tt.hours AS target_hours, tt.minutes AS target_minutes

       FROM timers t

       LEFT JOIN target_times tt ON tt.item_number = t.item_number

       WHERE t.id = $1`,

      [req.params.id]

    );

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });



    const { startedAt, completedAt, reason, notes } = req.body;

    const newStart = startedAt   ? new Date(startedAt).toISOString()   : timer.started_at;

    const newEnd   = completedAt ? new Date(completedAt).toISOString() : timer.completed_at;



    let durationSeconds = timer.duration_seconds;

    if (newStart && newEnd) {

      durationSeconds = Math.round((new Date(newEnd) - new Date(newStart)) / 1000);

      if (durationSeconds < 0) {

        return res.status(400).json({ error: 'Adjusted times would produce a negative duration.' });

      }

    }



    const changes = {};

    if (startedAt)   changes.started_at   = { from: timer.started_at,   to: newStart };

    if (completedAt) changes.completed_at = { from: timer.completed_at, to: newEnd   };

    if (notes)       changes.notes        = { from: timer.notes,        to: notes    };



    await query(

      `UPDATE timers

       SET started_at = $1, completed_at = $2, duration_seconds = $3,

           notes = COALESCE($4, notes), updated_at = NOW(), updated_by = $5

       WHERE id = $6`,

      [newStart, newEnd, durationSeconds, notes || null, req.user.id, timer.id]

    );

    await writeAudit(timer.id, 'adjust', req.user.id, reason, changes);



    const updated = await queryOne('SELECT * FROM timers WHERE id = $1', [timer.id]);

    res.json(formatTimer(updated));

  } catch (err) {

    console.error('Adjust timer error:', err.message);

    res.status(500).json({ error: 'Could not adjust timer.' });

  }

});



// ─── GET /api/timers ──────────────────────────────────────────────────────────

router.get('/', async (req, res) => {

  try {

    const user = req.user;

    const { from, to, operatorId, itemNumber, status, limit = 200, department } = req.query;

    const isSupervisorPlus = hasRole(user, 'supervisor');

    const isManagerPlus    = hasRole(user, 'manager');



    const conditions = [];

    const params     = [];

    let   p          = 1;



    if (!isSupervisorPlus) {

      // Operators see only their own timers

      conditions.push(`t.operator_id = $${p++}`);

      params.push(user.id);

    } else if (operatorId) {

      conditions.push(`t.operator_id = $${p++}`);

      params.push(operatorId);

    }



    // Supervisors are restricted to their own department unless overridden by explicit dept param

    if (isSupervisorPlus && !isManagerPlus) {

      // Supervisor: always filter to their own department

      conditions.push(`t.department = $${p++}`);

      params.push(user.department || 'Production');

    } else if (department) {

      // Manager/admin with explicit department filter

      conditions.push(`t.department = $${p++}`);

      params.push(department);

    }



    if (from) { conditions.push(`t.started_at >= $${p++}`); params.push(new Date(from).toISOString()); }

    if (to)   { conditions.push(`t.started_at <= $${p++}`); params.push(new Date(to).toISOString()); }

    if (itemNumber) {

      conditions.push(`t.item_number ILIKE $${p++}`);

      params.push(`%${itemNumber}%`);

    }

    if (status) { conditions.push(`t.status = $${p++}`); params.push(status); }



    const where    = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rowLimit = Math.min(parseInt(limit, 10) || 200, 1000);

    params.push(rowLimit);



    const rows = await query(

      `SELECT t.*, u.username, u.avatar_url,

              tt.hours AS target_hours, tt.minutes AS target_minutes

       FROM timers t

       LEFT JOIN users u ON u.id = t.operator_id

       LEFT JOIN target_times tt ON tt.item_number = t.item_number

       ${where}

       ORDER BY t.started_at DESC

       LIMIT $${p}`,

      params

    );



    res.json(rows.map(formatTimer));

  } catch (err) {

    console.error('List timers error:', err.message);

    res.status(500).json({ error: 'Could not load timers.' });

  }

});



// ─── GET /api/timers/raised-hands ────────────────────────────────────────────

// Supervisor+ : current raised-hand jobs (for the homepage tile + modal list).

// Defined BEFORE GET /:id so "raised-hands" isn't captured as an :id param.

// Supervisors are scoped to their own department; manager+ see all.

router.get('/raised-hands', async (req, res) => {

  try {

    if (!hasRole(req.user, 'supervisor')) {

      return res.status(403).json({ error: 'Supervisors and above only.' });

    }

    const isManagerPlus = hasRole(req.user, 'manager');

    const conditions = [`t.status = 'active'`, `t.hand_raised = TRUE`];

    const params = [];

    if (!isManagerPlus) {

      conditions.push(`t.department = $1`);

      params.push(req.user.department || 'Production');

    }

    const rows = await query(

      `SELECT t.id, t.item_number, t.operator_id, t.operator_name, t.workstation, t.department, t.started_at

       FROM timers t

       WHERE ${conditions.join(' AND ')}

       ORDER BY t.started_at ASC`,

      params

    );

    const timerHands = rows.map(r => ({

      timerId:      r.id,

      itemNumber:   r.item_number,

      operatorId:   r.operator_id,

      operatorName: r.operator_name,

      workstation:  r.workstation || null,

      department:   r.department || null,

      startedAt:    r.started_at,

      standalone:   false,

    }));



    // Union in standalone hands (raised with no active job). Same department scope.

    let standaloneHands = [];

    try {

      const sConds = [`lowered_at IS NULL`];

      const sParams = [];

      if (!isManagerPlus) { sConds.push(`department = $1`); sParams.push(req.user.department || 'Production'); }

      const sRows = await query(

        `SELECT id, operator_id, operator_name, department, raised_at

         FROM standalone_hands WHERE ${sConds.join(' AND ')} ORDER BY raised_at ASC`,

        sParams

      );

      standaloneHands = sRows.map(r => ({

        timerId:      null,

        standaloneId: r.id,

        itemNumber:   null,

        operatorId:   r.operator_id,

        operatorName: r.operator_name,

        workstation:  null,

        department:   r.department || null,

        startedAt:    r.raised_at,

        standalone:   true,

      }));

    } catch (_) { /* table not present yet */ }



    res.json([...standaloneHands, ...timerHands]);

  } catch (err) {

    console.error('GET /timers/raised-hands error:', err.message);

    res.status(500).json({ error: 'Could not load raised hands.' });

  }

});



// ─── Standalone hands (raised with no active timer) ──────────────────────────

// GET  /api/timers/my-hand     – operator's own standalone hand status

// POST /api/timers/raise-hand-standalone

// POST /api/timers/lower-hand-standalone

// Defined before GET /:id so the literal paths aren't captured as :id.



router.get('/my-hand', async (req, res) => {

  try {

    const row = await queryOne(

      `SELECT id, raised_at FROM standalone_hands

       WHERE operator_id = $1 AND lowered_at IS NULL

       ORDER BY raised_at DESC LIMIT 1`,

      [req.user.id]

    );

    res.json(row ? { raised: true, id: row.id, raisedAt: row.raised_at } : { raised: false });

  } catch (e) {

    res.json({ raised: false });

  }

});



router.post('/raise-hand-standalone', async (req, res) => {

  try {

    // Don't allow a standalone hand if the operator already has an active timer —

    // they should raise it on the job instead.

    const active = await queryOne(

      `SELECT id FROM timers WHERE operator_id = $1 AND status = 'active'`,

      [req.user.id]

    );

    if (active) {

      return res.status(409).json({ error: 'You have an active job — raise your hand on the job instead.' });

    }



    const existing = await queryOne(

      `SELECT id FROM standalone_hands WHERE operator_id = $1 AND lowered_at IS NULL`,

      [req.user.id]

    );

    if (existing) return res.json({ ok: true, handRaised: true }); // already raised — idempotent



    const id = uuidv4();

    await query(

      `INSERT INTO standalone_hands (id, operator_id, operator_name, department, raised_at)

       VALUES ($1, $2, $3, $4, NOW())`,

      [id, req.user.id, req.user.full_name, req.user.department || null]

    );



    pushToRole('supervisor', {

      type:         'hand_raised',

      timerId:      null,

      standaloneId: id,

      operatorName: req.user.full_name,

      itemNumber:   null,

      workstation:  null,

      raisedAt:     new Date().toISOString(),

    });



    res.json({ ok: true, handRaised: true });

  } catch (err) {

    console.error('Raise standalone hand error:', err.message);

    res.status(500).json({ error: 'Could not raise hand.' });

  }

});



router.post('/lower-hand-standalone', async (req, res) => {

  try {

    // Supervisors+ may lower a specific standalone hand by id; operators lower

    // their own (no id needed).

    const byId = req.body && req.body.standaloneId;

    if (byId) {

      if (!hasRole(req.user, 'supervisor')) {

        return res.status(403).json({ error: 'Supervisors and above only.' });

      }

      await query(

        `UPDATE standalone_hands SET lowered_at = NOW() WHERE id = $1 AND lowered_at IS NULL`,

        [byId]

      );

    } else {

      await query(

        `UPDATE standalone_hands SET lowered_at = NOW()

         WHERE operator_id = $1 AND lowered_at IS NULL`,

        [req.user.id]

      );

    }

    pushToRole('supervisor', { type: 'hands_changed' });

    res.json({ ok: true, handRaised: false });

  } catch (err) {

    console.error('Lower standalone hand error:', err.message);

    res.status(500).json({ error: 'Could not lower hand.' });

  }

});



// ─── GET /api/timers/:id ──────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {

  try {

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    if (!hasRole(req.user, 'supervisor') && timer.operator_id !== req.user.id) {

      return res.status(403).json({ error: 'Access denied.' });

    }



    let auditTrail = [];

    if (hasRole(req.user, 'supervisor')) {

      auditTrail = await query(

        `SELECT a.*, u.full_name AS actor_name FROM audit_log a

         LEFT JOIN users u ON u.id = a.performed_by

         WHERE a.timer_id = $1 ORDER BY a.created_at DESC`,

        [timer.id]

      );

    }

    res.json({ ...formatTimer(timer), auditTrail });

  } catch (err) {

    res.status(500).json({ error: 'Could not load timer.' });

  }

});





// ─── DELETE /api/timers/:id ── Administrator only ─────────────────────────────

router.delete('/:id', async (req, res) => {

  if (!hasRole(req.user, 'administrator')) {

    return res.status(403).json({ error: 'Only Administrators can delete timer records.' });

  }

  try {

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });



    // Delete audit log entries for this timer first (foreign key)

    await query('DELETE FROM audit_log WHERE timer_id = $1', [timer.id]);

    // Delete the timer

    await query('DELETE FROM timers WHERE id = $1', [timer.id]);



    res.json({ ok: true, message: 'Timer record deleted.' });

  } catch (err) {

    console.error('Delete timer error:', err.message);

    res.status(500).json({ error: 'Could not delete timer.' });

  }

});





// ─── POST /api/timers/lower-all-hands ────────────────────────────────────────

// Supervisor+ lowers all raised hands in one action.

router.post('/lower-all-hands', async (req, res) => {

  try {

    if (!hasRole(req.user, 'supervisor')) {

      return res.status(403).json({ error: 'Supervisors and above only.' });

    }

    const result = await query(

      `UPDATE timers SET hand_raised = FALSE

       WHERE status = 'active' AND hand_raised = TRUE

       RETURNING id`,

      []

    );

    let count = result.length;

    // Also clear any standalone (no-job) hands.

    try {

      const s = await query(

        `UPDATE standalone_hands SET lowered_at = NOW() WHERE lowered_at IS NULL RETURNING id`,

        []

      );

      count += s.length;

    } catch (_) { /* table not present yet */ }

    // Tell all connected supervisors+ to refresh their raised-hands tile/list.

    pushToRole('supervisor', { type: 'hands_changed' });

    res.json({ ok: true, count, message: `${count} hand${count !== 1 ? 's' : ''} lowered.` });

  } catch (err) {

    console.error('Lower all hands error:', err.message);

    res.status(500).json({ error: 'Could not lower all hands.' });

  }

});

// Operator raises their hand on their active timer. Supervisors+ can also lower

// anyone's hand via the lower-hand route.

router.post('/:id/raise-hand', async (req, res) => {

  try {

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });



    // Only the operator who owns the timer can raise their own hand

    if (timer.operator_id !== req.user.id) {

      return res.status(403).json({ error: 'You can only raise your own hand.' });

    }



    await query('UPDATE timers SET hand_raised = TRUE WHERE id = $1', [timer.id]);

    await writeAudit(timer.id, 'hand_raised', req.user.id, null, null);



    // Notify all connected supervisors, managers and administrators

    pushToRole('supervisor', {

      type:          'hand_raised',

      timerId:       timer.id,

      operatorName:  req.user.full_name,

      itemNumber:    timer.item_number,

      workstation:   timer.workstation || null,

      raisedAt:      new Date().toISOString(),

    });



    res.json({ ok: true, handRaised: true });

  } catch (err) {

    console.error('Raise hand error:', err.message);

    res.status(500).json({ error: 'Could not raise hand.' });

  }

});



// ─── POST /api/timers/:id/lower-hand ─────────────────────────────────────────

// Operator lowers their own hand, or supervisor+ lowers anyone's hand.

router.post('/:id/lower-hand', async (req, res) => {

  try {

    const timer = await queryOne('SELECT * FROM timers WHERE id = $1', [req.params.id]);

    if (!timer) return res.status(404).json({ error: 'Timer not found.' });

    if (timer.status !== 'active') return res.status(409).json({ error: 'Timer is not active.' });



    const isSupervisorPlus = ['supervisor', 'manager', 'administrator'].includes(req.user.role);

    if (timer.operator_id !== req.user.id && !isSupervisorPlus) {

      return res.status(403).json({ error: 'You do not have permission to lower this hand.' });

    }



    await query('UPDATE timers SET hand_raised = FALSE WHERE id = $1', [timer.id]);

    await writeAudit(timer.id, 'hand_lowered', req.user.id, null, null);



    // Refresh supervisors' raised-hands tile/list in real time.

    pushToRole('supervisor', { type: 'hands_changed' });



    res.json({ ok: true, handRaised: false });

  } catch (err) {

    console.error('Lower hand error:', err.message);

    res.status(500).json({ error: 'Could not lower hand.' });

  }

});



module.exports = router;

