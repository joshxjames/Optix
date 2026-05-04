#!/usr/bin/env node
// Cost report for Optix audit logs.
//
// Walks `<userData>/@optix/desktop/audit/loops/*.json`, computes per-run
// cost using the same Anthropic rate table the in-app audit viewer uses,
// and prints overview + distribution + per-model + per-outcome + per-day
// + per-run breakdowns to stdout.
//
// Use this to ground subscription pricing in real usage: run a handful
// of representative tasks, then re-run the script and look at the median
// vs p90 cost-per-run to set tier allowances.
//
// Usage:
//   pnpm --filter @optix/desktop cost-report
//   pnpm --filter @optix/desktop cost-report -- --dir <path>     # custom audit dir
//   pnpm --filter @optix/desktop cost-report -- --top 30          # show 30 newest runs
//   pnpm --filter @optix/desktop cost-report -- --since 2026-04-01

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Pricing — kept in sync with src/shared/pricing.ts. Duplicated here so the
// script is self-contained (no TypeScript / bundler step needed). Rates are
// USD per million tokens; cache rates default to input × 1.25 (write) and
// input × 0.10 (read) when not explicit.
// ---------------------------------------------------------------------------

const PRICING = {
  'claude-opus-4-7': {
    inputUsdPerMtok: 15,
    outputUsdPerMtok: 75,
    cacheWriteUsdPerMtok: 18.75,
    cacheReadUsdPerMtok: 1.5,
    longContext: {
      thresholdTokens: 200_000,
      inputUsdPerMtok: 30,
      outputUsdPerMtok: 150,
      cacheWriteUsdPerMtok: 37.5,
      cacheReadUsdPerMtok: 3,
    },
  },
  'claude-sonnet-4-6': {
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheWriteUsdPerMtok: 3.75,
    cacheReadUsdPerMtok: 0.3,
    longContext: {
      thresholdTokens: 200_000,
      inputUsdPerMtok: 6,
      outputUsdPerMtok: 22.5,
      cacheWriteUsdPerMtok: 7.5,
      cacheReadUsdPerMtok: 0.6,
    },
  },
  'claude-haiku-4-5': {
    inputUsdPerMtok: 1,
    outputUsdPerMtok: 5,
    cacheWriteUsdPerMtok: 1.25,
    cacheReadUsdPerMtok: 0.1,
  },
};

function resolvePricing(modelId) {
  if (PRICING[modelId]) return PRICING[modelId];
  let best = null;
  for (const [key, price] of Object.entries(PRICING)) {
    if (modelId.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, price };
    }
  }
  return best?.price ?? null;
}

function costForTurn(modelId, usage) {
  if (!usage) return 0;
  const price = resolvePricing(modelId);
  if (!price) return 0;
  const inputTok = usage.inputTokens ?? 0;
  const outputTok = usage.outputTokens ?? 0;
  const cwTok = usage.cacheCreationInputTokens ?? 0;
  const crTok = usage.cacheReadInputTokens ?? 0;
  const totalContextTokens = inputTok + crTok + cwTok;
  const long =
    price.longContext && totalContextTokens > price.longContext.thresholdTokens
      ? price.longContext
      : null;
  const ir = long?.inputUsdPerMtok ?? price.inputUsdPerMtok;
  const or = long?.outputUsdPerMtok ?? price.outputUsdPerMtok;
  const cwr =
    long?.cacheWriteUsdPerMtok ?? price.cacheWriteUsdPerMtok ?? ir * 1.25;
  const crr =
    long?.cacheReadUsdPerMtok ?? price.cacheReadUsdPerMtok ?? ir * 0.1;
  let usd = 0;
  usd += (inputTok / 1_000_000) * ir;
  usd += (outputTok / 1_000_000) * or;
  usd += (cwTok / 1_000_000) * cwr;
  usd += (crTok / 1_000_000) * crr;
  return usd;
}

// ---------------------------------------------------------------------------
// Audit-dir resolution. Mirrors Electron's `app.getPath('userData')` for the
// `@optix/desktop` product across the three OSes the app supports.
// ---------------------------------------------------------------------------

function defaultAuditDir() {
  const productPath = '@optix/desktop/audit/loops';
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData/Roaming');
    return join(appData, productPath);
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library/Application Support', productPath);
  }
  // Linux + everything else → XDG default.
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, productPath);
}

// ---------------------------------------------------------------------------
// CLI args. Tiny manual parser — no dep needed.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dir: defaultAuditDir(),
    top: 20,
    since: null, // ISO date string, inclusive
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--top') opts.top = Math.max(1, parseInt(argv[++i] ?? '20', 10));
    else if (a === '--since') opts.since = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: cost-report [--dir <path>] [--top N] [--since YYYY-MM-DD]',
      );
      process.exit(0);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Read + parse audit logs.
// ---------------------------------------------------------------------------

function readLogs(dir, since) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`No audit dir found at ${dir}`);
    console.error(`(Run Optix at least once, or pass --dir <path> to override.)`);
    process.exit(1);
  }
  const sinceTs = since ? Date.parse(since) : null;
  if (since && Number.isNaN(sinceTs)) {
    console.error(`--since "${since}" is not a valid date.`);
    process.exit(1);
  }
  const logs = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const fullPath = join(dir, name);
    try {
      const raw = readFileSync(fullPath, 'utf8');
      const log = JSON.parse(raw);
      if (sinceTs !== null) {
        const startedTs = Date.parse(log.startedAt ?? '');
        if (Number.isNaN(startedTs) || startedTs < sinceTs) continue;
      }
      logs.push(log);
    } catch {
      // Skip unreadable / malformed files silently — they're not data we
      // can trust to bill against.
    }
  }
  logs.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
  return logs;
}

// ---------------------------------------------------------------------------
// Aggregations.
// ---------------------------------------------------------------------------

function summariseLog(log) {
  const turns = Array.isArray(log.turns) ? log.turns : [];
  let inputTok = 0;
  let outputTok = 0;
  let cwTok = 0;
  let crTok = 0;
  let cost = 0;
  let actionCount = 0;
  let unknownModel = false;
  for (const t of turns) {
    inputTok += t.inputTokens ?? 0;
    outputTok += t.outputTokens ?? 0;
    cwTok += t.cacheCreationInputTokens ?? 0;
    crTok += t.cacheReadInputTokens ?? 0;
    actionCount += Array.isArray(t.actions) ? t.actions.length : 0;
    const turnCost = costForTurn(log.modelId, {
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheCreationInputTokens: t.cacheCreationInputTokens,
      cacheReadInputTokens: t.cacheReadInputTokens,
    });
    cost += turnCost;
    if (turnCost === 0 && (t.inputTokens || t.outputTokens) && !resolvePricing(log.modelId)) {
      unknownModel = true;
    }
  }
  return {
    startedAt: log.startedAt ?? '',
    endedAt: log.endedAt ?? '',
    modelId: log.modelId ?? '(unknown)',
    providerId: log.providerId ?? '',
    outcome: log.outcome ?? 'unknown',
    turnCount: turns.length,
    actionCount,
    inputTok,
    outputTok,
    cwTok,
    crTok,
    cost,
    unknownModel,
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function fmtUsd(n) {
  return `$${n.toFixed(4)}`;
}
function fmtTok(n) {
  return n.toLocaleString();
}

// ---------------------------------------------------------------------------
// Render report.
// ---------------------------------------------------------------------------

function pad(s, w, align = 'left') {
  const str = String(s);
  if (str.length >= w) return str;
  const padding = ' '.repeat(w - str.length);
  return align === 'right' ? padding + str : str + padding;
}

function renderReport(rows, opts) {
  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalInput = rows.reduce((s, r) => s + r.inputTok, 0);
  const totalOutput = rows.reduce((s, r) => s + r.outputTok, 0);
  const totalCacheRead = rows.reduce((s, r) => s + r.crTok, 0);
  const totalCacheWrite = rows.reduce((s, r) => s + r.cwTok, 0);
  const sortedCosts = [...rows.map((r) => r.cost)].sort((a, b) => a - b);

  console.log('');
  console.log('Optix cost report');
  console.log('═════════════════');
  console.log(`Audit dir : ${opts.dir}`);
  if (opts.since) console.log(`Since     : ${opts.since}`);
  if (rows.length === 0) {
    console.log('\nNo runs to report.\n');
    return;
  }

  // Day span.
  const earliest = rows[rows.length - 1].startedAt;
  const latest = rows[0].startedAt;
  console.log(`Range     : ${earliest.slice(0, 10)} → ${latest.slice(0, 10)}`);

  console.log('');
  console.log('OVERVIEW');
  console.log('────────');
  console.log(`Runs        : ${rows.length}`);
  console.log(`Total cost  : ${fmtUsd(totalCost)}`);
  console.log(`Avg / run   : ${fmtUsd(totalCost / rows.length)}`);
  console.log(
    `Tokens      : in ${fmtTok(totalInput)}  out ${fmtTok(totalOutput)}  ` +
      `cache-read ${fmtTok(totalCacheRead)}  cache-write ${fmtTok(totalCacheWrite)}`,
  );

  console.log('');
  console.log('DISTRIBUTION (USD / run)');
  console.log('────────────────────────');
  console.log(`Min      ${fmtUsd(sortedCosts[0])}`);
  console.log(`P25      ${fmtUsd(quantile(sortedCosts, 0.25))}`);
  console.log(`Median   ${fmtUsd(quantile(sortedCosts, 0.5))}`);
  console.log(`P75      ${fmtUsd(quantile(sortedCosts, 0.75))}`);
  console.log(`P90      ${fmtUsd(quantile(sortedCosts, 0.9))}`);
  console.log(`P99      ${fmtUsd(quantile(sortedCosts, 0.99))}`);
  console.log(`Max      ${fmtUsd(sortedCosts[sortedCosts.length - 1])}`);

  // By model.
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.modelId))
      byModel.set(r.modelId, { count: 0, cost: 0, unknown: r.unknownModel });
    const e = byModel.get(r.modelId);
    e.count += 1;
    e.cost += r.cost;
  }
  console.log('');
  console.log('BY MODEL');
  console.log('────────');
  console.log(
    `${pad('model', 28)}  ${pad('runs', 6, 'right')}  ${pad('cost', 12, 'right')}  ${pad('avg', 12, 'right')}  note`,
  );
  for (const [model, e] of [...byModel.entries()].sort(
    (a, b) => b[1].cost - a[1].cost,
  )) {
    const note = e.unknown ? '(no pricing — $0)' : '';
    console.log(
      `${pad(model.slice(0, 28), 28)}  ${pad(e.count, 6, 'right')}  ${pad(fmtUsd(e.cost), 12, 'right')}  ${pad(fmtUsd(e.cost / e.count), 12, 'right')}  ${note}`,
    );
  }

  // By outcome.
  const byOutcome = new Map();
  for (const r of rows) {
    if (!byOutcome.has(r.outcome)) byOutcome.set(r.outcome, { count: 0, cost: 0 });
    const e = byOutcome.get(r.outcome);
    e.count += 1;
    e.cost += r.cost;
  }
  console.log('');
  console.log('BY OUTCOME');
  console.log('──────────');
  console.log(
    `${pad('outcome', 16)}  ${pad('runs', 6, 'right')}  ${pad('cost', 12, 'right')}  ${pad('avg', 12, 'right')}`,
  );
  for (const [outcome, e] of [...byOutcome.entries()].sort(
    (a, b) => b[1].cost - a[1].cost,
  )) {
    console.log(
      `${pad(outcome, 16)}  ${pad(e.count, 6, 'right')}  ${pad(fmtUsd(e.cost), 12, 'right')}  ${pad(fmtUsd(e.cost / e.count), 12, 'right')}`,
    );
  }

  // By day (last 14 entries).
  const byDay = new Map();
  for (const r of rows) {
    const day = r.startedAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, { count: 0, cost: 0 });
    const e = byDay.get(day);
    e.count += 1;
    e.cost += r.cost;
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  if (days.length > 1) {
    console.log('');
    console.log('BY DAY (most recent 14)');
    console.log('───────────────────────');
    console.log(
      `${pad('date', 12)}  ${pad('runs', 6, 'right')}  ${pad('cost', 12, 'right')}`,
    );
    for (const [day, e] of days) {
      console.log(
        `${pad(day, 12)}  ${pad(e.count, 6, 'right')}  ${pad(fmtUsd(e.cost), 12, 'right')}`,
      );
    }
  }

  // Per-run table.
  console.log('');
  console.log(`PER-RUN (newest ${Math.min(opts.top, rows.length)})`);
  console.log('─────────────────');
  console.log(
    `${pad('started', 19)}  ${pad('model', 22)}  ${pad('turns', 5, 'right')}  ${pad('acts', 5, 'right')}  ${pad('cost', 10, 'right')}  outcome`,
  );
  for (const r of rows.slice(0, opts.top)) {
    const started = r.startedAt.replace('T', ' ').slice(0, 19);
    console.log(
      `${pad(started, 19)}  ${pad(r.modelId.slice(0, 22), 22)}  ${pad(r.turnCount, 5, 'right')}  ${pad(r.actionCount, 5, 'right')}  ${pad(fmtUsd(r.cost), 10, 'right')}  ${r.outcome}`,
    );
  }

  // Footer hints.
  const unpricedRuns = rows.filter((r) => r.unknownModel).length;
  if (unpricedRuns > 0) {
    console.log('');
    console.log(
      `note: ${unpricedRuns} run(s) used a model without a pricing entry — those rows show $0.`,
    );
    console.log('      Add their rates to src/shared/pricing.ts to include them.');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const logs = readLogs(opts.dir, opts.since);
const rows = logs.map(summariseLog);
renderReport(rows, opts);
