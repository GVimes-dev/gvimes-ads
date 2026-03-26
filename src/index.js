'use strict';

// Load .env.local first (local overrides), then fall back to .env
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

const express = require('express');

const serveRouter      = require('./routes/serve');
const trackRouter      = require('./routes/track');
const contractsRouter  = require('./routes/contracts');
const advertisersRouter = require('./routes/advertisers');

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());

// Lightweight request logger
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/serve',       serveRouter);
app.use('/track',       trackRouter);
app.use('/contracts',   contractsRouter);
app.use('/advertisers', advertisersRouter);

// ─── 404 catch-all ───────────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Global error handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[app] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, () => {
  console.log(`Grape Vimes Ad Server listening on port ${PORT}`);
});

module.exports = app; // exported for testing
