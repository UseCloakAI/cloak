// The public ledger: one Durable Object (SQLite) that counts every reply's
// estimated energy and carbon, every sponsor view and click, and every carbon
// credit actually retired. GET /v1/impact reads it; the Impact page draws it.
//
// Three kinds of numbers, never mixed:
//   emitted   — modelled from tokens (carbon.js). Always labelled "estimated".
//   funded    — the pledge (10x emitted) as far as sponsor revenue covers it.
//               Revenue is estimated from views until an admin books real
//               figures (POST /admin/revenue).
//   retired   — credits actually bought and retired, each with a registry
//               receipt (POST /admin/offsets). Only this counts as "offset".

import { DurableObject } from "cloudflare:workers";
import { METHOD, EST_USD_PER_1K_VIEWS, EST_USD_PER_CLICK, CLIMATE_SHARE, USD_PER_TONNE, OFFSET_MULTIPLE } from "./carbon.js";

const today = () => new Date().toISOString().slice(0, 10);

export class Ledger extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS day (
        day TEXT PRIMARY KEY,
        replies INTEGER NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        wh REAL NOT NULL DEFAULT 0,
        g REAL NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0,
        usd_booked REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS lane (
        day TEXT NOT NULL, lane TEXT NOT NULL,
        replies INTEGER NOT NULL DEFAULT 0, wh REAL NOT NULL DEFAULT 0, g REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (day, lane)
      );
      CREATE TABLE IF NOT EXISTS sponsor (
        day TEXT NOT NULL, sponsor TEXT NOT NULL,
        views INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, sponsor)
      );
      CREATE TABLE IF NOT EXISTS offsets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        day TEXT NOT NULL, kg REAL NOT NULL, usd REAL NOT NULL,
        project TEXT NOT NULL, registry TEXT NOT NULL, receipt TEXT NOT NULL
      );
    `);
  }

  // The home-PC brain: up or down, as last seen by the cron check or a turn.
  brainStatus() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS brain (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    const row = this.sql.exec(`SELECT v FROM brain WHERE k = 'status'`).toArray()[0];
    try { return row ? JSON.parse(row.v) : { up: false, checked: 0, since: 0 }; } catch { return { up: false, checked: 0, since: 0 }; }
  }
  setBrain(next) {
    const prev = this.brainStatus();
    const up = !!next.up && !next.paused;
    const s = { up, paused: !!next.paused, checked: Date.now(), since: up === prev.up ? prev.since || Date.now() : Date.now(), version: next.version || prev.version || null, reason: next.reason || "" };
    this.sql.exec(`INSERT INTO brain (k, v) VALUES ('status', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(s));
    return s;
  }

  // One-time pairing codes for the brain installer: short to type, used
  // once, gone after an hour.
  putPair(code, payload, ttlMs = 3600_000) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pair (code TEXT PRIMARY KEY, payload TEXT NOT NULL, until INTEGER NOT NULL)`);
    this.sql.exec(`DELETE FROM pair WHERE until < ?`, Date.now());
    this.sql.exec(`INSERT OR REPLACE INTO pair (code, payload, until) VALUES (?, ?, ?)`, code, JSON.stringify(payload), Date.now() + ttlMs);
    return { code, until: new Date(Date.now() + ttlMs).toISOString() };
  }
  takePair(code) {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pair (code TEXT PRIMARY KEY, payload TEXT NOT NULL, until INTEGER NOT NULL)`);
    const row = this.sql.exec(`SELECT payload, until FROM pair WHERE code = ?`, code).toArray()[0];
    this.sql.exec(`DELETE FROM pair WHERE code = ? OR until < ?`, code, Date.now());
    return row && row.until > Date.now() ? JSON.parse(row.payload) : null;
  }

  recordReply({ lane = "smart", tokensIn = 0, tokensOut = 0, wh = 0, g = 0 }) {
    const d = today();
    this.sql.exec(
      `INSERT INTO day (day, replies, tokens_in, tokens_out, wh, g) VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET replies = replies + 1, tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out, wh = wh + excluded.wh, g = g + excluded.g`,
      d, tokensIn | 0, tokensOut | 0, +wh || 0, +g || 0,
    );
    this.sql.exec(
      `INSERT INTO lane (day, lane, replies, wh, g) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(day, lane) DO UPDATE SET replies = replies + 1, wh = wh + excluded.wh, g = g + excluded.g`,
      d, String(lane).slice(0, 20), +wh || 0, +g || 0,
    );
  }

  recordAd({ sponsor = "house", kind = "view" }) {
    const d = today();
    const v = kind === "view" ? 1 : 0;
    const c = kind === "click" ? 1 : 0;
    if (!v && !c) return;
    this.sql.exec(`INSERT INTO day (day, views, clicks) VALUES (?, ?, ?) ON CONFLICT(day) DO UPDATE SET views = views + excluded.views, clicks = clicks + excluded.clicks`, d, v, c);
    this.sql.exec(
      `INSERT INTO sponsor (day, sponsor, views, clicks) VALUES (?, ?, ?, ?) ON CONFLICT(day, sponsor) DO UPDATE SET views = views + excluded.views, clicks = clicks + excluded.clicks`,
      d, String(sponsor).slice(0, 40), v, c,
    );
  }

  bookRevenue({ day, usd }) {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? day : today();
    this.sql.exec(`INSERT INTO day (day, usd_booked) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET usd_booked = usd_booked + excluded.usd_booked`, d, +usd || 0);
    return { ok: true, day: d };
  }

  addOffset({ day, kg, usd, project, registry, receipt }) {
    if (!(kg > 0) || !project || !registry || !/^https:\/\//.test(receipt || "")) return { ok: false, error: "kg, project, registry and an https receipt URL are required" };
    const d = /^\d{4}-\d{2}-\d{2}$/.test(day || "") ? day : today();
    this.sql.exec(`INSERT INTO offsets (day, kg, usd, project, registry, receipt) VALUES (?, ?, ?, ?, ?, ?)`, d, +kg, +usd || 0, String(project).slice(0, 120), String(registry).slice(0, 60), String(receipt).slice(0, 400));
    return { ok: true, day: d };
  }

  summary(days = 90) {
    const n = Math.min(365, Math.max(7, days | 0));
    const rows = this.sql.exec(`SELECT * FROM day ORDER BY day DESC LIMIT ?`, n).toArray().reverse();
    const tot = this.sql.exec(`SELECT COALESCE(SUM(replies),0) replies, COALESCE(SUM(tokens_in),0) tokens_in, COALESCE(SUM(tokens_out),0) tokens_out, COALESCE(SUM(wh),0) wh, COALESCE(SUM(g),0) g, COALESCE(SUM(views),0) views, COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(usd_booked),0) usd_booked FROM day`).one();
    const offsets = this.sql.exec(`SELECT day, kg, usd, project, registry, receipt FROM offsets ORDER BY day DESC, id DESC LIMIT 50`).toArray();
    const retired = this.sql.exec(`SELECT COALESCE(SUM(kg),0) kg, COALESCE(SUM(usd),0) usd FROM offsets`).one();
    const lanes = this.sql.exec(`SELECT lane, SUM(replies) replies, SUM(wh) wh, SUM(g) g FROM lane GROUP BY lane ORDER BY g DESC`).toArray();
    const sponsors = this.sql.exec(`SELECT sponsor, SUM(views) views, SUM(clicks) clicks FROM sponsor GROUP BY sponsor ORDER BY views DESC LIMIT 20`).toArray();

    const estUsd = (views, clicks) => (views / 1000) * EST_USD_PER_1K_VIEWS + clicks * EST_USD_PER_CLICK;
    const revenue = tot.usd_booked > 0 ? tot.usd_booked : estUsd(tot.views, tot.clicks);
    // Pledge = 10x emitted, capped by what the climate share of revenue can buy.
    const afford = (usd) => ((usd * CLIMATE_SHARE) / USD_PER_TONNE) * 1000;
    const pledgeKg = (tot.g / 1000) * OFFSET_MULTIPLE;
    const fundedKg = Math.min(pledgeKg, afford(revenue));
    return {
      sample: false,
      updated: new Date().toISOString(),
      totals: {
        replies: tot.replies,
        tokens: tot.tokens_in + tot.tokens_out,
        wh: tot.wh,
        emitted_kg: tot.g / 1000,
        views: tot.views,
        clicks: tot.clicks,
        revenue_usd: revenue,
        revenue_is_estimate: !(tot.usd_booked > 0),
        pledge_kg: pledgeKg,
        funded_kg: fundedKg,
        retired_kg: retired.kg,
        retired_usd: retired.usd,
      },
      days: rows.map((r) => ({ day: r.day, replies: r.replies, wh: r.wh, emitted_kg: r.g / 1000, views: r.views, clicks: r.clicks, funded_kg: Math.min((r.g / 1000) * OFFSET_MULTIPLE, afford(r.usd_booked > 0 ? r.usd_booked : estUsd(r.views, r.clicks))) })),
      offsets,
      lanes,
      sponsors,
      method: METHOD,
    };
  }
}
