'use strict';

/**
 * Async impression / click logger.
 *
 * All public functions are fire-and-forget: they return immediately and
 * perform database writes on a detached promise chain so the HTTP response
 * is never delayed.
 *
 * Each successful impression write is followed by:
 *   1. An upsert into daily_stats via the upsert_daily_impression() RPC.
 *   2. A budget check — if the contract has an impression_budget and the
 *      total impression count now meets or exceeds it, the contract is
 *      atomically transitioned to status = 'completed'. The `.eq('status',
 *      'active')` guard on the UPDATE prevents double-completion races.
 *
 * Each successful click write is followed by an upsert into daily_stats
 * via upsert_daily_click().
 */

const supabase = require('../db/client');

// ─── Impression ──────────────────────────────────────────────────────────────

async function _logImpression({ creative_id, contract_id, placement_id, publisher_id, session_token }) {
  const now = new Date();

  const { error: impErr } = await supabase.from('impressions').insert({
    creative_id,
    contract_id,
    placement_id,
    publisher_id,
    served_at: now.toISOString(),
    session_token: session_token || null,
  });

  if (impErr) {
    console.error('[logger] impression insert failed:', impErr.message);
    return;
  }

  // Upsert daily rollup
  const { error: dsErr } = await supabase.rpc('upsert_daily_impression', {
    p_date:         now.toISOString().slice(0, 10),
    p_creative_id:  creative_id,
    p_contract_id:  contract_id,
    p_placement_id: placement_id,
    p_publisher_id: publisher_id,
  });

  if (dsErr) console.error('[logger] daily_stats impression upsert failed:', dsErr.message);

  // Auto-complete contract when impression budget is reached
  await _checkAndAutoComplete(contract_id);
}

async function _checkAndAutoComplete(contract_id) {
  const { data: contract, error: fetchErr } = await supabase
    .from('contracts')
    .select('id, impression_budget, status')
    .eq('id', contract_id)
    .single();

  if (fetchErr || !contract || !contract.impression_budget || contract.status !== 'active') return;

  const { count, error: countErr } = await supabase
    .from('impressions')
    .select('*', { count: 'exact', head: true })
    .eq('contract_id', contract_id);

  if (countErr || count === null) return;

  if (count >= contract.impression_budget) {
    const { error: updateErr } = await supabase
      .from('contracts')
      .update({ status: 'completed' })
      .eq('id', contract_id)
      .eq('status', 'active'); // guard against races

    if (!updateErr) {
      console.log(`[logger] Contract ${contract_id} auto-completed (budget: ${contract.impression_budget}, served: ${count})`);
    }
  }
}

// ─── Click ────────────────────────────────────────────────────────────────────

async function _logClick({ creative_id, contract_id, placement_id, publisher_id, session_token }) {
  const now = new Date();

  const { error: clickErr } = await supabase.from('clicks').insert({
    creative_id,
    contract_id,
    placement_id,
    publisher_id,
    clicked_at: now.toISOString(),
    session_token: session_token || null,
  });

  if (clickErr) {
    console.error('[logger] click insert failed:', clickErr.message);
    return;
  }

  const { error: dsErr } = await supabase.rpc('upsert_daily_click', {
    p_date:         now.toISOString().slice(0, 10),
    p_creative_id:  creative_id,
    p_contract_id:  contract_id,
    p_placement_id: placement_id,
    p_publisher_id: publisher_id,
  });

  if (dsErr) console.error('[logger] daily_stats click upsert failed:', dsErr.message);
}

// ─── Public fire-and-forget wrappers ─────────────────────────────────────────

function logImpressionAsync(data) {
  _logImpression(data).catch(err => console.error('[logger] unhandled impression error:', err));
}

function logClickAsync(data) {
  _logClick(data).catch(err => console.error('[logger] unhandled click error:', err));
}

module.exports = { logImpressionAsync, logClickAsync };
