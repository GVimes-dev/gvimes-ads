'use strict';

/**
 * GET /serve?placement=<slug>&pub=<publisher-slug>[&session=<token>]
 *
 * Hot-path ad serving endpoint. Target: < 100 ms P99.
 *
 * Selection algorithm — round-robin at the contract level, random within
 * a contract's active creatives:
 *   1. Eligible contracts are fetched via the serve_ad() Postgres RPC and
 *      cached in memory for CACHE_TTL_SECONDS (default 60 s).
 *   2. The flat list of eligible creatives is grouped by contract_id.
 *   3. A per-placement round-robin counter (in process memory) selects which
 *      contract to serve next, ensuring fair rotation across advertisers even
 *      when one contract has more creatives than another.
 *   4. Within the selected contract, one active creative is picked at random.
 *
 * Impression token — a signed JWT (HS256, 24 h TTL) encoding:
 *   { creative_id, contract_id, placement_id, publisher_id }
 * POST /track/click verifies this token to associate a click with the
 * original impression without a round-trip to the database.
 *
 * Impression logging is fire-and-forget (non-blocking).
 */

const express = require('express');
const jwt = require('jsonwebtoken');

const supabase = require('../db/client');
const cache = require('../cache');
const { logImpressionAsync } = require('../logger/impressionLogger');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'gvimes-dev-secret-replace-in-prod';
const GLOBAL_FALLBACK_URL = process.env.FALLBACK_CREATIVE_URL || 'https://placehold.co/728x90?text=House+Ad';

// Per-placement round-robin counters — never reset, always mod by list length.
// Lives in process memory; resets on restart (acceptable for load balancing).
const rrCounters = new Map();

router.get('/', async (req, res) => {
  const { placement: placementSlug, pub: publisherSlug, session } = req.query;

  if (!placementSlug || !publisherSlug) {
    return res.status(400).json({ error: 'placement and pub query params are required' });
  }

  const cacheKey = `serve:${publisherSlug}:${placementSlug}`;

  try {
    // ── 1. Fetch eligible creatives (cache-first) ─────────────────────────
    let adData = cache.get(cacheKey);

    if (!adData) {
      const { data, error } = await supabase.rpc('serve_ad', {
        p_placement_slug: placementSlug,
        p_publisher_slug: publisherSlug,
      });

      if (error) {
        console.error('[serve] serve_ad RPC error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (data && data.error === 'placement_not_found') {
        return res.status(404).json({ error: 'Placement not found' });
      }

      adData = data;
      cache.set(cacheKey, adData);
    }

    const { creatives, fallback_image_url, fallback_click_url } = adData;

    // ── 2. House ad when no paid creative is eligible ─────────────────────
    if (!creatives || creatives.length === 0) {
      return res.json({
        house_ad: true,
        image_url: fallback_image_url || GLOBAL_FALLBACK_URL,
        click_url: fallback_click_url || null,
      });
    }

    // ── 3. Group creatives by contract for round-robin ────────────────────
    /** @type {Map<string, Array>} */
    const contractMap = new Map();
    for (const c of creatives) {
      if (!contractMap.has(c.contract_id)) contractMap.set(c.contract_id, []);
      contractMap.get(c.contract_id).push(c);
    }
    const contractEntries = [...contractMap.values()]; // [ [creative, ...], ... ]

    // ── 4. Round-robin contract selection ─────────────────────────────────
    const rrKey = `${publisherSlug}:${placementSlug}`;
    const counter = rrCounters.get(rrKey) || 0;
    const idx = counter % contractEntries.length;
    rrCounters.set(rrKey, counter + 1);

    const contractCreatives = contractEntries[idx];

    // ── 5. Random creative within the selected contract ───────────────────
    const creative = contractCreatives[Math.floor(Math.random() * contractCreatives.length)];

    // ── 6. Sign impression token ─────────────────────────────────────────
    const tokenPayload = {
      creative_id:  creative.creative_id,
      contract_id:  creative.contract_id,
      placement_id: creative.placement_id,
      publisher_id: creative.publisher_id,
    };

    const impression_token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '24h' });

    // ── 7. Fire-and-forget impression log ─────────────────────────────────
    logImpressionAsync({ ...tokenPayload, session_token: session || null });

    // ── 8. Respond ────────────────────────────────────────────────────────
    return res.json({
      creative_id:      creative.creative_id,
      image_url:        creative.image_url,
      click_url:        creative.click_url,
      headline:         creative.headline  || null,
      alt_text:         creative.alt_text  || null,
      impression_token,
    });
  } catch (err) {
    console.error('[serve] unexpected error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
