'use strict';

/**
 * Advertiser routes
 *
 * GET   /advertisers      — list all advertisers
 * POST  /advertisers      — create an advertiser
 * PATCH /advertisers/:id  — update an advertiser
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');

const supabase = require('../db/client');

const router = express.Router();

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ errors: errors.array() });
    return true;
  }
  return false;
}

// ─── GET /advertisers ─────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const { data, error } = await supabase
    .from('advertisers')
    .select('*')
    .order('name');

  if (error) {
    console.error('[advertisers] list error:', error.message);
    return res.status(500).json({ error: 'Failed to fetch advertisers' });
  }

  return res.json(data);
});

// ─── POST /advertisers ────────────────────────────────────────────────────────

const createValidators = [
  body('name').isString().trim().notEmpty().withMessage('name is required'),
  body('contact_name').optional({ nullable: true }).isString().trim(),
  body('contact_email').optional({ nullable: true }).isEmail().withMessage('contact_email must be a valid email'),
  body('phone').optional({ nullable: true }).isString().trim(),
  body('notes').optional({ nullable: true }).isString(),
];

router.post('/', createValidators, async (req, res) => {
  if (validationErrors(req, res)) return;

  const { name, contact_name = null, contact_email = null, phone = null, notes = null } = req.body;

  const { data, error } = await supabase
    .from('advertisers')
    .insert({ name, contact_name, contact_email, phone, notes })
    .select()
    .single();

  if (error) {
    console.error('[advertisers] create error:', error.message);
    return res.status(500).json({ error: 'Failed to create advertiser' });
  }

  return res.status(201).json(data);
});

// ─── PATCH /advertisers/:id ───────────────────────────────────────────────────

const updateValidators = [
  param('id').isUUID().withMessage('id must be a valid UUID'),
  body('name').optional().isString().trim().notEmpty(),
  body('contact_name').optional({ nullable: true }).isString().trim(),
  body('contact_email').optional({ nullable: true }).isEmail().withMessage('contact_email must be a valid email'),
  body('phone').optional({ nullable: true }).isString().trim(),
  body('notes').optional({ nullable: true }).isString(),
];

router.patch('/:id', updateValidators, async (req, res) => {
  if (validationErrors(req, res)) return;

  const { id } = req.params;

  const allowed = ['name', 'contact_name', 'contact_email', 'phone', 'notes'];
  const updates = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      updates[key] = req.body[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  const { data, error } = await supabase
    .from('advertisers')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Advertiser not found' });
    console.error('[advertisers] update error:', error.message);
    return res.status(500).json({ error: 'Failed to update advertiser' });
  }

  return res.json(data);
});

module.exports = router;
