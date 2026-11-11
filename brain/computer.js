// Cloak Computer: the two VMs on this PC (brain/vm/setup.sh), managed for
// the agent.
//
//   desktop  cloak-computer, a Linux desktop the agent sees and drives
//   server   cloak-server, a headless machine for packages and scripts
//
// Both are off until needed: the first use wakes one (a cold boot, about a
// minute on this drive) and it goes back to sleep after IDLE_MS unused. One
// person drives the desktop at a time (a lease, renewed by every action);
// anyone else is told it is in use. The server takes everyone at once. Each
// person runs as their own Linux account (cl-<hash>), with their own home.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEASE_MS = 4 * 60_000; // the desktop stays yours this long after your last action
const IDLE_MS = 10 * 60_000; // a machine nobody used for this long goes to sleep
const WAKE_MS = 240_000;

export class Busy extends Error {}

export function makeComputer({ file = "/etc/cloak-brain/computer.json", log = () => {}, isAdmin = () => false, vision }) {
  let conf = null;
  const load = () => { try { conf = JSON.parse(fs.readFileSync(file, "utf8")); } catch { conf = null; } return conf; };
  load();
  const agentCode = (() => { try { return fs.readFileSync(path.join(HERE, "vm", "agent.py")); } catch { return null; } })();
  const agentVersion = agentCode ? crypto.createHash("sha256").update(agentCode).digest("hex").slice(0, 16) : null;

  const vm = {
    desktop: { kind: "desktop", state: "asleep", lastUse: 0, waking: null },
    server: { kind: "server", state: "asleep", lastUse: 0, waking: null },
  };
  let lease = { user: null, until: 0 };
  let frame = null; // the latest screen, for the person driving: { user, jpg, at }

  const virsh = (...args) => new Promise((resolve) => execFile("virsh", ["-c", "qemu:///system", ...args], { timeout: 120_000 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || err?.message || "").trim() })));
  const userOf = (key) => "cl-" + crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16);

  async function agent(kind, p, body, ms = 60_000) {
    const c = conf[kind];
    const res = await fetch(`http://${c.ip}:8765${p}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Agent-Token": c.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `the ${kind} answered ${res.status}`);
    return out;
  }
  const healthy = (kind) => agent(kind, "/health", null, 4_000).catch(() => null);

  async function wake(kind) {
    const v = vm[kind];
    if (v.waking) return v.waking;
    if (v.state === "ready" && (await healthy(kind))) return true;
    v.waking = (async () => {
      v.state = "waking";
      log("info", `waking the ${kind}`);
      const st = await virsh("domstate", conf[kind].name);
      if (!/running/.test(st.out)) {
        const r = await virsh("start", conf[kind].name);
        if (!r.ok && !/already active/i.test(r.err)) throw new Error(`could not start the ${kind}: ${r.err.slice(0, 200)}`);
      }
      const until = Date.now() + WAKE_MS;
      let tries = 0;
      while (Date.now() < until) {
        const h = await healthy(kind);
        if (h) {
          // Keep the agent inside the VM in step with this brain (twice at most).
          if (agentVersion && h.version !== agentVersion && tries++ < 2) {
            await agent(kind, "/update", { code: agentCode.toString("base64") }, 15_000).catch(() => {});
            await new Promise((r) => setTimeout(r, 2500));
            continue;
          }
          if (kind === "desktop") await new Promise((r) => setTimeout(r, 1500)); // the desktop finishes drawing
          v.state = "ready";
          v.lastUse = Date.now();
          return true;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`the ${kind} did not wake up in time`);
    })();
    try { return await v.waking; } catch (e) { v.state = "asleep"; throw e; } finally { v.waking = null; }
  }
  async function sleep(kind) {
    const v = vm[kind];
    if (v.waking) return;
    log("info", `putting the ${kind} to sleep`);
    v.state = "sleeping";
    await virsh("shutdown", conf[kind].name);
    for (let i = 0; i < 45; i++) {
      if (!/running/.test((await virsh("domstate", conf[kind].name)).out)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (/running/.test((await virsh("domstate", conf[kind].name)).out)) await virsh("destroy", conf[kind].name);
    v.state = "asleep";
    if (kind === "desktop") { lease = { user: null, until: 0 }; frame = null; }
  }
  // Wake up once at start: learn what is actually running.
  async function sync() {
    if (!load()) return;
    for (const kind of ["desktop", "server"]) {
      const st = await virsh("domstate", conf[kind].name);
      if (/running/.test(st.out) && (await healthy(kind))) { vm[kind].state = "ready"; vm[kind].lastUse = Date.now(); }
    }
  }
  sync().catch(() => {});
  setInterval(() => {
    if (!conf) return;
    for (const kind of ["desktop", "server"]) {
      const v = vm[kind];
      const held = kind === "desktop" && lease.user && lease.until > Date.now();
      if (v.state === "ready" && !held && Date.now() - v.lastUse > IDLE_MS) sleep(kind).catch((e) => log("error", `sleep failed: ${e.message}`));
    }
  }, 60_000).unref?.();

  function claim(user) {
    const now = Date.now();
    if (lease.user && lease.user !== user && lease.until > now) throw new Busy("The computer is being used by someone else right now.");
    if (lease.user !== user) frame = null;
    lease = { user, until: now + LEASE_MS };
  }
  const touch = (kind) => { vm[kind].lastUse = Date.now(); };

  async function screen(user) {
    claim(user);
    await wake("desktop");
    const s = await agent("desktop", "/screen", {}, 40_000);
    touch("desktop");
    frame = { user, png: s.png, at: Date.now() };
    return s;
  }

  const api = {
    get available() { return !!(conf || load()); },
    allowed(email) { return !!conf && (conf.access === "everyone" || isAdmin(email)); },
    status(user, email) {
      if (!conf && !load()) return { available: false };
      const now = Date.now();
      const holder = lease.user && lease.until > now ? (lease.user === user ? "you" : "someone") : null;
      return { available: true, allowed: api.allowed(email), access: conf.access || "admins", desktop: { state: vm.desktop.state, holder }, server: { state: vm.server.state } };
    },
    async wakeFor(user, kind = "desktop") { if (kind === "desktop") claim(user); return wake(kind); },
    release(user) { if (lease.user === user) { lease = { user: null, until: 0 }; frame = null; } return true; },
    sleep,
    // The latest view of the screen, only for the person driving. Refreshed
    // when older than a second and a half.
    async frameFor(user) {
      if (lease.user !== user || lease.until < Date.now() || vm.desktop.state !== "ready") return null;
      if (!frame || frame.user !== user || Date.now() - frame.at > 1500) {
        const s = await agent("desktop", "/screen", {}, 30_000).catch(() => null);
        if (s) frame = { user, png: s.png, at: Date.now() };
      }
      return frame ? Buffer.from(frame.png, "base64") : null;
    },
    setAccess(access) {
      if (!conf) return false;
      conf.access = access === "everyone" ? "everyone" : "admins";
      fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
      return true;
    },
    // What the agent's tools call, for one person.
    forUser(userKey, emit = () => {}) {
      const user = userOf(userKey);
      const notify = () => emit({ computer: { at: Date.now() } });
      return {
        async look(question) {
          const s = await screen(userKey);
          notify();
          const desc = await vision(s.grid || s.png, s.grid ? "image/jpeg" : "image/png", question, s.w, s.h);
          return { w: s.w, h: s.h, text: desc };
        },
        async input(action) {
          claim(userKey);
          await wake("desktop");
          const r = await agent("desktop", "/input", action, 30_000);
          touch("desktop");
          await new Promise((res) => setTimeout(res, 350)); // let the screen react
          notify();
          return r;
        },
        async run(kind, cmd, timeout) {
          if (kind === "desktop") claim(userKey);
          await wake(kind);
          if (kind === "desktop") notify();
          const r = await agent(kind, "/run", { user, cmd, timeout }, (Math.min(Number(timeout) || 60, 600) + 30) * 1000);
          touch(kind);
          return r;
        },
      };
    },
  };
  return api;
}
