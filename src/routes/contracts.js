'use strict';

/**
 * Contract routes
 *
 * GET  /contracts              — list all contracts (with stats)
 * POST /contracts              — create a contract + placement assignments
 * PATCH /contracts/:id         — update contract fields
 * GET  /contracts/:id/stats    — detailed stats + pacing
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const supabase = require('../db/client');
const cache = require('../cache');

const router = express.Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

const VALID_STATUSES = ['draft', 'active', 'paused', 'completed', 'cancelled'];

// ─── GET /contracts ───────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('contracts_with_stats')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[contracts] list error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch contracts' });
  }

  return res.json(data);
});

// ─── POST /contracts ──────────────────────────────────────────────────────────

const createValidators = [
  body('title').isString().trim().notEmpty().withMessage('title is required'),
  body('advertiser_id').isUUID().withMessage('advertiser_id must be a valid UUID'),
  body('start_date').isDate({ format: 'YYYY-MM-DD' }).withMessage('start_date must be YYYY-MM-DD'),
  body('end_date').isDate({ format: 'YYYY-MM-DD' }).withMessage('end_date must be YYYY-MM-DD'),
  body('placement_ids')
    .isArray({ min: 1 }).withMessage('placement_ids must be a non-empty array')
    .custom(ids => ids.every(id => typeof id === 'string' && id.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    ))).withMessage('each placement_ids entry must be a valid UUID'),
  body('status').optional().isIn(VALID_STATUSES).withMessage(`status must be one of: ${VALID_STATUSES.join(', ')}`),
  body('impression_budget').optional({ nullable: true }).isInt({ min: 1 }).withMessage('impression_budget must be a positive integer'),
  body('pricing_notes').optional({ nullable: true }).isString(),
];

router.post('/', createValidators, async (req, res) => {
  if (validationErrors(req, res)) return;

  const {
    title,
    advertiser_id,
    start_date,
    end_date,
    placement_ids,
    status = 'draft',
    impression_budget = null,
    pricing_notes = null,
  } = req.body;

  if (new Date(end_date) < new Date(start_date)) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }

  // Insert contract
  const { data: contract, error: contractErr } = await supabase
    .from('contracts')
    .insert({ title, advertiser_id, start_date, end_date, status, impression_budget, pricing_notes })
    .select()
    .single();

  if (contractErr) {
    console.error('[contracts] create error:', contractErr.message);
    // Surface FK violations as 400
    if (contractErr.code === '23503') {
      return res.status(400).json({ error: 'advertiser_id does not exist' });
    }
    return res.status(500).json({ error: 'Failed to create contract' });
  }

  // Insert placement assignments
  const cpRows = placement_ids.map(pid => ({
    contract_id:  contract.id,
    placement_id: pid,
  }));

  const { error: cpErr } = await supabase.from('contract_placements').insert(cpRows);

  if (cpErr) {
    console.error('[contracts] placement link error:', cpErr.message);
    // Attempt cleanup
    await supabase.from('contracts').delete().eq('id', contract.id);
    if (cpErr.code === '23503') {
      return res.status(400).json({ error: 'One or more placement_ids do not exist' });
    }
    return res.status(500).json({ error: 'Failed to assign placements' });
  }

  cache.invalidateAll(); // bust cached serve results

  return res.status(201).json({ ...contract, placement_ids });
});

// ─── PATCH /contracts/:id ─────────────────────────────────────────────────────

const updateValidators = [
  param('id').isUUID().withMessage('id must be a valid UUID'),
  body('title').optional().isString().trim().notEmpty(),
  body('status').optional().isIn(VALID_STATUSES).withMessage(`status must be one of: ${VALID_STATUSES.join(', ')}`),
  body('start_date').optional().isDate({ format: 'YYYY-MM-DD' }),
  body('end_date').optional().isDate({ format: 'YYYY-MM-DD' }),
  body('impression_budget').optional({ nullable: true }).isInt({ min: 1 }),
  body('pricing_notes').optional({ nullable: true }).isString(),
  body('placement_ids')
    .optional()
    .isArray({ min: 1 })
    .custom(ids => ids.every(id => typeof id === 'string' && id.match(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    ))).withMessage('each placement_ids entry must be a valid UUID'),
];

router.patch('/:id', updateValidators, async (req, res) => {
  if (validationErrors(req, res)) return;

  const { id } = req.params;
  const { placement_ids, ...fields } = req.body;

  // Build the update object — only include fields that were sent
  const allowed = ['title', 'status', 'start_date', 'end_date', 'impression_budget', 'pricing_notes'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      updates[key] = fields[key];
    }
  }

  if (updates.start_date && updates.end_date && new Date(updates.end_date) < new Date(updates.start_date)) {
    return res.status(400).json({ error: 'end_date must be on or after start_date' });
  }

  let contract;

  if (Object.keys(updates).length > 0) {
    const { data, error } = await supabase
      .from('contracts')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Contract not found' });
      console.error('[contracts] update error:', error.message);
      return res.status(500).json({ error: 'Failed to update contract' });
    }

    contract = data;
  }

  // Replace placement assignments if provided
  if (placement_ids) {
    // Delete existing, then re-insert
    const { error: delErr } = await supabase
      .from('contract_placements')
      .delete()
      .eq('contract_id', id);

    if (delErr) {
      console.error('[contracts] placement delete error:', delErr.message);
      return res.status(500).json({ error: 'Failed to update placements' });
    }

    const cpRows = placement_ids.map(pid => ({ contract_id: id, placement_id: pid }));
    const { error: insErr } = await supabase.from('contract_placements').insert(cpRows);

    if (insErr) {
      console.error('[contracts] placement insert error:', insErr.message);
      if (insErr.code === '23503') return res.status(400).json({ error: 'One or more placement_ids do not exist' });
      return res.status(500).json({ error: 'Failed to update placements' });
    }
  }

  cache.invalidateAll(); // bust cached serve results

  // Return fresh contract if we didn't update fields above
  if (!contract) {
    const { data, error } = await supabase.from('contracts').select().eq('id', id).single();
    if (error) return res.status(404).json({ error: 'Contract not found' });
    contract = data;
  }

  return res.json(contract);
});

// ─── GET /contracts/:id/stats ─────────────────────────────────────────────────

router.get('/:id/stats', [
  param('id').isUUID().withMessage('id must be a valid UUID'),
], async (req, res) => {
  if (validationErrors(req, res)) return;

  const { id } = req.params;

  // Fetch contract
  const { data: contract, error: contractErr } = await supabase
    .from('contracts')
    .select('id, title, status, start_date, end_date, impression_budget, advertiser_id')
    .eq('id', id)
    .single();

  if (contractErr || !contract) {
    return res.status(404).json({ error: 'Contract not found' });
  }

  // Fetch impression count and click count in parallel
  const [{ count: impressionCount }, { count: clickCount }] = await Promise.all([
    supabase.from('impressions').select('*', { count: 'exact', head: true }).eq('contract_id', id),
    supabase.from('clicks').select('*', { count: 'exact', head: true }).eq('contract_id', id),
  ]);

  const imp = impressionCount || 0;
  const clk = clickCount    || 0;
  const ctr = imp > 0 ? parseFloat(((clk / imp) * 100).toFixed(4)) : 0;

  // Pacing
  const today     = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const startDate = new Date(contract.start_date);
  const endDate   = new Date(contract.end_date);

  // Days elapsed since start (0 if campaign hasn't started yet)
  const msPerDay    = 86_400_000;
  const daysElapsed = Math.max(0, Math.floor((today - startDate) / msPerDay) + 1);

  // Days remaining including today
  const daysRemaining = Math.max(0, Math.floor((endDate - today) / msPerDay) + 1);

  const pacingActual = daysElapsed > 0
    ? parseFloat((imp / daysElapsed).toFixed(2))
    : 0;

  let pacingNeeded = null;
  if (contract.impression_budget && daysRemaining > 0) {
    const remaining = Math.max(0, contract.impression_budget - imp);
    pacingNeeded = parseFloat((remaining / daysRemaining).toFixed(2));
  }

  return res.json({
    contract_id:       id,
    title:             contract.title,
    status:            contract.status,
    start_date:        contract.start_date,
    end_date:          contract.end_date,
    impression_budget: contract.impression_budget,
    impression_count:  imp,
    click_count:       clk,
    ctr_pct:           ctr,
    days_elapsed:      daysElapsed,
    days_remaining:    daysRemaining,
    pacing: {
      actual_per_day: pacingActual,
      needed_per_day: pacingNeeded,
      on_pace:        pacingNeeded !== null ? pacingActual >= pacingNeeded : null,
    },
  });
});

module.exports = router;
