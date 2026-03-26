'use strict';

/**
 * POST /track/click
 * Body: { impression_token: <JWT> }
 *
 * Verifies the signed impression token returned by /serve and logs a click
 * event tied to the original impression (same creative / contract / placement
 * / publisher context).
 *
 * The token carries all IDs needed to log the click — no extra DB look-up
 * required before writing, so this path is very fast.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const { logClickAsync } = require('../logger/impressionLogger');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'gvimes-dev-secret-replace-in-prod';

const validate = [
  body('impression_token')
    .isString().withMessage('impression_token must be a string')
    .notEmpty().withMessage('impression_token is required'),
];

router.post('/click', validate, (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const { impression_token, session } = req.body;

  let payload;
  try {
    payload = jwt.verify(impression_token, JWT_SECRET);
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Impression token has expired'
      : 'Invalid impression token';
    return res.status(400).json({ error: msg });
  }

  const { creative_id, contract_id, placement_id, publisher_id } = payload;

  // Fire-and-forget — response is sent immediately
  logClickAsync({
    creative_id,
    contract_id,
    placement_id,
    publisher_id,
    session_token: session || null,
  });

  return res.json({ success: true });
});

module.exports = router;
