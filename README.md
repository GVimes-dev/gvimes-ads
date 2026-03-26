# Grape Vimes Media — Ad Server

Dynamic ad server for the **Norwood Record** and **Boston Bulletin**, built with Node.js/Express and Supabase (Postgres).

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Project Structure](#project-structure)
3. [Database Migrations](#database-migrations)
4. [Environment Variables](#environment-variables)
5. [Cache Strategy](#cache-strategy)
6. [API Reference](#api-reference)
   - [GET /serve](#get-serve)
   - [POST /track/click](#post-trackclick)
   - [GET /contracts](#get-contracts)
   - [POST /contracts](#post-contracts)
   - [PATCH /contracts/:id](#patch-contractsid)
   - [GET /contracts/:id/stats](#get-contractsidstats)
   - [GET /advertisers](#get-advertisers)
   - [POST /advertisers](#post-advertisers)
   - [PATCH /advertisers/:id](#patch-advertisersid)
7. [Contract Lifecycle](#contract-lifecycle)
8. [Ad Selection Algorithm](#ad-selection-algorithm)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Supabase URL and service-role key

# 3. Run migrations in Supabase SQL editor (in order)
#    migrations/001_publishers.sql … 010_functions_and_views.sql

# 4. Start the server
npm start          # production
npm run dev        # development (auto-restarts on file change)
```

The server starts on `http://localhost:3001` by default (set `PORT` to override).

---

## Project Structure

```
gvimes-ads/
├── migrations/
│   ├── 001_publishers.sql
│   ├── 002_placements.sql
│   ├── 003_advertisers.sql
│   ├── 004_contracts.sql
│   ├── 005_contract_placements.sql
│   ├── 006_creatives.sql
│   ├── 007_impressions.sql
│   ├── 008_clicks.sql
│   ├── 009_daily_stats.sql
│   └── 010_functions_and_views.sql   ← serve_ad() RPC, daily upserts, contracts_with_stats view
├── src/
│   ├── index.js                       ← Express app entry point
│   ├── db/
│   │   └── client.js                  ← Supabase client singleton
│   ├── cache/
│   │   └── index.js                   ← In-memory TTL cache
│   ├── logger/
│   │   └── impressionLogger.js        ← Async impression + click logger
│   └── routes/
│       ├── serve.js                   ← GET /serve
│       ├── track.js                   ← POST /track/click
│       ├── contracts.js               ← Contract CRUD + stats
│       └── advertisers.js             ← Advertiser CRUD
├── .env.example
└── package.json
```

---

## Database Migrations

Run migrations **in order** using the Supabase SQL editor or `psql`.  Each file is idempotent-safe to run once on a fresh schema.

| File | Creates |
|------|---------|
| `001_publishers.sql` | `publishers` table + seeds Norwood Record & Boston Bulletin |
| `002_placements.sql` | `placements` table (per-publisher ad slots) |
| `003_advertisers.sql` | `advertisers` table |
| `004_contracts.sql` | `contracts` table, `contract_status` enum, indexes, `updated_at` trigger |
| `005_contract_placements.sql` | `contract_placements` join table |
| `006_creatives.sql` | `creatives` table |
| `007_impressions.sql` | `impressions` table + indexes |
| `008_clicks.sql` | `clicks` table + indexes |
| `009_daily_stats.sql` | `daily_stats` rollup table |
| `010_functions_and_views.sql` | `serve_ad()` RPC, `upsert_daily_impression()`, `upsert_daily_click()`, `contracts_with_stats` view |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Yes | — | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Service-role key (bypasses RLS) |
| `JWT_SECRET` | Yes | `gvimes-dev-secret-replace-in-prod` | Secret for signing impression tokens |
| `FALLBACK_CREATIVE_URL` | No | `https://placehold.co/728x90?text=House+Ad` | Global house-ad image URL |
| `CACHE_TTL_SECONDS` | No | `60` | Eligible-contract cache TTL |
| `PORT` | No | `3001` | HTTP port |

---

## Cache Strategy

The `/serve` endpoint must respond in under 100 ms under normal load. The bottleneck is the eligibility query — joining contracts, placements, publishers, and checking impression budgets in Postgres.

**Solution: in-memory per-placement cache with configurable TTL.**

- Key: `serve:<publisher-slug>:<placement-slug>`
- Value: the full `serve_ad()` RPC result (eligible creatives + fallback URLs)
- TTL: `CACHE_TTL_SECONDS` (default 60 s)

On a **cache hit** the serve handler does zero Postgres queries — it selects a creative from the in-memory list and signs a JWT.  Only the async impression logger touches the database.

On a **cache miss** (cold start or TTL expiry) a single `serve_ad()` RPC call fetches and caches the eligible list.

**Cache invalidation:**  `PATCH /contracts/:id` and `POST /contracts` call `cache.invalidateAll()` so status/date/budget changes propagate within one TTL window at most, and immediately after a mutation via the API.

The round-robin counter (for contract rotation) lives in process memory alongside the cache but is **never invalidated** — it keeps advancing across cache refreshes to maintain fairness.

---

## API Reference

### GET /serve

Hot-path ad serving.

**Query params:**

| Param | Required | Description |
|-------|----------|-------------|
| `placement` | Yes | Placement slug (e.g. `hero_banner`) |
| `pub` | Yes | Publisher slug (e.g. `norwood-record`) |
| `session` | No | Optional client session token for deduplication |

**Success (paid ad):**

```json
{
  "creative_id": "uuid",
  "image_url": "https://...",
  "click_url": "https://...",
  "headline": "Summer Sale — 20% Off",
  "alt_text": "Acme Co banner",
  "impression_token": "<signed JWT>"
}
```

**Success (house ad — no eligible contract):**

```json
{
  "house_ad": true,
  "image_url": "https://...",
  "click_url": null
}
```

**Errors:** `400` missing params · `404` placement not found · `500` server error

The `impression_token` is a signed JWT encoding `creative_id`, `contract_id`, `placement_id`, and `publisher_id`. It expires after 24 hours. Pass it to `POST /track/click` to register a click.

---

### POST /track/click

Log a click on a served ad.

**Body:**

```json
{
  "impression_token": "<JWT from /serve>"
}
```

**Success:**

```json
{ "success": true }
```

**Errors:** `400` missing/invalid/expired token · `500` server error

The click is logged asynchronously — the response is sent before the database write completes.

---

### GET /contracts

List all contracts with denormalised advertiser name, placement slugs, and live impression count.

**Response:** Array of contract objects from the `contracts_with_stats` view.

```json
[
  {
    "id": "uuid",
    "title": "Acme Spring Campaign",
    "status": "active",
    "start_date": "2026-03-01",
    "end_date": "2026-03-31",
    "impression_budget": 50000,
    "advertiser_name": "Acme Co",
    "impression_count": 12345,
    "placement_slugs": ["hero_banner", "right_rail"],
    ...
  }
]
```

---

### POST /contracts

Create a contract and assign it to one or more placements.

**Body:**

```json
{
  "title": "Acme Spring Campaign",
  "advertiser_id": "uuid",
  "start_date": "2026-03-01",
  "end_date": "2026-03-31",
  "placement_ids": ["uuid-1", "uuid-2"],
  "status": "draft",
  "impression_budget": 50000,
  "pricing_notes": "$5 CPM, invoiced monthly"
}
```

`status` defaults to `draft`. `impression_budget` and `pricing_notes` are optional.

**Response:** `201` with the created contract + `placement_ids`.

---

### PATCH /contracts/:id

Update contract fields.  Only provided fields are changed.

**Body (all optional):**

```json
{
  "title": "...",
  "status": "active",
  "start_date": "2026-03-01",
  "end_date": "2026-04-30",
  "impression_budget": 75000,
  "pricing_notes": "...",
  "placement_ids": ["uuid-1"]
}
```

Supplying `placement_ids` **replaces** the full placement assignment list.

Triggers a full cache flush so changes take effect on the next `/serve` request.

---

### GET /contracts/:id/stats

Detailed performance stats and pacing for a single contract.

**Response:**

```json
{
  "contract_id": "uuid",
  "title": "Acme Spring Campaign",
  "status": "active",
  "start_date": "2026-03-01",
  "end_date": "2026-03-31",
  "impression_budget": 50000,
  "impression_count": 12345,
  "click_count": 234,
  "ctr_pct": 1.8964,
  "days_elapsed": 22,
  "days_remaining": 9,
  "pacing": {
    "actual_per_day": 561.14,
    "needed_per_day": 4184.0,
    "on_pace": false
  }
}
```

- `ctr_pct` — click-through rate as a percentage.
- `pacing.actual_per_day` — average daily impressions delivered so far.
- `pacing.needed_per_day` — impressions per day needed to exhaust the budget by `end_date`.  `null` when no `impression_budget` is set.
- `pacing.on_pace` — `true` if actual ≥ needed, `null` when no budget.

---

### GET /advertisers

List all advertisers ordered by name.

---

### POST /advertisers

Create an advertiser.

**Body:**

```json
{
  "name": "Acme Co",
  "contact_name": "Jane Smith",
  "contact_email": "jane@acme.com",
  "phone": "617-555-0100",
  "notes": "Prefers invoice by email"
}
```

Only `name` is required.  **Response:** `201` with the created record.

---

### PATCH /advertisers/:id

Update advertiser fields. Only provided fields are changed.

---

## Contract Lifecycle

Contracts move through these statuses:

```
draft → active → paused → active
                       → completed  (manual or auto on budget exhaustion)
                       → cancelled
```

Rules enforced at serve time:

1. Only `status = active` contracts are eligible.
2. `CURRENT_DATE` must be between `start_date` and `end_date` (inclusive). Past-`end_date` contracts are **never** served even if `status` is still `active`.
3. When `impression_budget` is set, a contract whose total impression count meets or exceeds the budget is excluded from eligibility.
4. When the impression logger detects that budget has been reached it atomically sets `status = 'completed'` (using a guarded `WHERE status = 'active'` update to prevent races).

---

## Ad Selection Algorithm

**Within a placement:**

1. All eligible contracts are fetched (or served from cache).
2. Creatives are grouped by `contract_id`.
3. A **round-robin counter** (per placement, in process memory) selects which contract's creative group to draw from on this request. This ensures fair rotation across advertisers regardless of how many creatives each contract has.
4. Within the selected contract's active creatives, **one is chosen at random**.

**Why round-robin at the contract level?**  Pure random selection would statistically favor contracts with more creatives.  Round-robin at the contract level gives each advertiser equal opportunity while still allowing multiple creative variants per contract.

The counter resets to zero on server restart; this is acceptable because it only affects short-term fairness and corrects itself quickly.
