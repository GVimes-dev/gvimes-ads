-- Migration 010: SQL Functions and Views
-- ============================================================

-- ------------------------------------------------------------
-- FUNCTION: serve_ad(placement_slug, publisher_slug)
--
-- Called by the /serve hot path (via supabase.rpc).
-- Returns a JSON object with:
--   creatives        – array of eligible {contract_id, creative_id,
--                      image_url, click_url, headline, alt_text,
--                      placement_id, publisher_id}
--   fallback_image_url / fallback_click_url – from the placement row
--   placement_id / publisher_id             – UUIDs for impression logging
--   error            – 'placement_not_found' when slug combo is unknown
--
-- Eligibility rules enforced here (not in application layer):
--   • contract.status = 'active'
--   • CURRENT_DATE BETWEEN start_date AND end_date
--   • impression_budget IS NULL  OR  total_impressions < impression_budget
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION serve_ad(
  p_placement_slug  TEXT,
  p_publisher_slug  TEXT
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_placement_id        UUID;
  v_publisher_id        UUID;
  v_fallback_image_url  TEXT;
  v_fallback_click_url  TEXT;
  v_creatives           JSON;
BEGIN
  -- Resolve placement + publisher in one join
  SELECT pl.id, pub.id, pl.fallback_image_url, pl.fallback_click_url
  INTO   v_placement_id, v_publisher_id, v_fallback_image_url, v_fallback_click_url
  FROM   placements pl
  JOIN   publishers pub ON pub.id = pl.publisher_id
  WHERE  pl.slug  = p_placement_slug
    AND  pub.slug = p_publisher_slug;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'placement_not_found');
  END IF;

  -- Collect all eligible creatives for this placement
  SELECT json_agg(t)
  INTO   v_creatives
  FROM (
    SELECT
      c.id  AS contract_id,
      cr.id AS creative_id,
      cr.image_url,
      cr.mobile_image_url,
      cr.click_url,
      cr.headline,
      cr.alt_text,
      v_placement_id  AS placement_id,
      v_publisher_id  AS publisher_id
    FROM   contracts c
    JOIN   contract_placements cp
             ON  cp.contract_id  = c.id
             AND cp.placement_id = v_placement_id
    JOIN   creatives cr
             ON  cr.contract_id = c.id
             AND cr.is_active   = true
    WHERE  c.status = 'active'
      AND  CURRENT_DATE BETWEEN c.start_date AND c.end_date
      AND  (
             c.impression_budget IS NULL
             OR (
               SELECT COUNT(*)
               FROM   impressions i
               WHERE  i.contract_id = c.id
             ) < c.impression_budget
           )
  ) t;

  RETURN json_build_object(
    'creatives',           COALESCE(v_creatives, '[]'::JSON),
    'fallback_image_url',  v_fallback_image_url,
    'fallback_click_url',  v_fallback_click_url,
    'placement_id',        v_placement_id,
    'publisher_id',        v_publisher_id
  );
END;
$$;


-- ------------------------------------------------------------
-- FUNCTION: upsert_daily_impression
-- Atomically increments the impression counter for a given
-- (date, creative, contract, placement, publisher) bucket.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_daily_impression(
  p_date         DATE,
  p_creative_id  UUID,
  p_contract_id  UUID,
  p_placement_id UUID,
  p_publisher_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO daily_stats
    (date, creative_id, contract_id, placement_id, publisher_id,
     impression_count, click_count)
  VALUES
    (p_date, p_creative_id, p_contract_id, p_placement_id, p_publisher_id, 1, 0)
  ON CONFLICT (date, creative_id, contract_id, placement_id, publisher_id)
  DO UPDATE SET impression_count = daily_stats.impression_count + 1;
END;
$$;


-- ------------------------------------------------------------
-- FUNCTION: upsert_daily_click
-- Atomically increments the click counter for a given bucket.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_daily_click(
  p_date         DATE,
  p_creative_id  UUID,
  p_contract_id  UUID,
  p_placement_id UUID,
  p_publisher_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO daily_stats
    (date, creative_id, contract_id, placement_id, publisher_id,
     impression_count, click_count)
  VALUES
    (p_date, p_creative_id, p_contract_id, p_placement_id, p_publisher_id, 0, 1)
  ON CONFLICT (date, creative_id, contract_id, placement_id, publisher_id)
  DO UPDATE SET click_count = daily_stats.click_count + 1;
END;
$$;


-- ------------------------------------------------------------
-- VIEW: contracts_with_stats
-- Efficient list view used by GET /contracts.
-- Denormalises advertiser name, placement slugs, and live
-- impression count so the route handler needs one query.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW contracts_with_stats AS
SELECT
  c.id,
  c.title,
  c.status,
  c.start_date,
  c.end_date,
  c.impression_budget,
  c.pricing_notes,
  c.advertiser_id,
  c.created_at,
  c.updated_at,
  a.name                                                             AS advertiser_name,
  COALESCE(imp.impression_count, 0)::INTEGER                        AS impression_count,
  ARRAY_AGG(DISTINCT pl.slug) FILTER (WHERE pl.slug IS NOT NULL)    AS placement_slugs
FROM      contracts c
JOIN      advertisers a   ON a.id  = c.advertiser_id
LEFT JOIN (
  SELECT   contract_id, COUNT(*)::INTEGER AS impression_count
  FROM     impressions
  GROUP BY contract_id
)          imp            ON imp.contract_id = c.id
LEFT JOIN  contract_placements cp ON cp.contract_id = c.id
LEFT JOIN  placements          pl ON pl.id = cp.placement_id
GROUP BY c.id, a.name, imp.impression_count;
