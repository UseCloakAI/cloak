// Cloak Computer: every person gets their own virtual machines on this PC.
//
//   desktop  their own Debian XFCE desktop, which the agent sees and drives
//   server   their own headless Debian machine for packages and code
//
// Each person's machines are small disks on top of two sealed golden images
// (brain/vm/setup.sh), kept in /var/lib/cloak-vm/users/<id>/, with keys only
// the brain knows. Nothing is shared between people: not a disk, a browser
// profile, a process, a port or a network path (isolated ports, no spoofing,
// firewall), and inside their own VM the person is admin.
//
// This PC has slots: one desktop (6 GB) and two servers (1.5 GB each). A
// machine boots into a slot when its person needs it (about a minute on a
// hard drive) and shuts down after IDLE_MS unused. If the desktop slot is in
// use by someone else, they are told so; a server slot whose person has gone
// quiet is handed over.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEASE_MS = 4 * 60_000;  // the desktop stays yours this long after your last action
const IDLE_MS = 10 * 60_000;  // a machine nobody used for this long shuts down
const WAKE_MS = 240_000;
const HANDOVER_MS = 60_000;   // a server quiet this long can be handed to someone else
const MIN_FREE = 15 * 1024 ** 3; // bytes of disk to keep free before making new machines

const DESKTOP = { kind: "desktop", ip: "10.77.0.10", mac: "52:54:00:77:00:10", mb: 6144, cpus: 4 };
const SERVERS = [
  { kind: "server", ip: "10.77.0.20", mac: "52:54:00:77:00:20", mb: 1536, cpus: 2 },
  { kind: "server", ip: "10.77.0.21", mac: "52:54:00:77:00:21", mb: 1536, cpus: 2 },
];

export class Busy extends Error {}

const sh = (cmd, args, ms = 120_000) => new Promise((resolve) => execFile(cmd, args, { timeout: ms }, (err, out, errOut) => resolve({ ok: !err, out: String(out || "").trim(), err: String(errOut || err?.message || "").trim() })));
const virsh = (...args) => sh("virsh", ["-c", "qemu:///system", ...args]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

// ── The operator's instructions and helpers ───────────────────────────────
const OPERATOR = `You are Cloak's computer operator. You control a Linux desktop (XFCE) with a Firefox browser on behalf of an AI assistant that gave you a goal. Be fast and precise.

Each turn you get the goal, what you did so far, and what is on the screen now: the open windows, and the browser page as text (URL, numbered elements [i], visible text).

Answer with ONLY one JSON object, no prose:
{"actions":[...]}   1 to 6 actions, run in order
{"done":"what you did, and the answer or result with the exact text they asked for"}
{"fail":"why it cannot be done, and what the person has to do"}

Browser actions (use these for anything on a website):
{"goto":"https://..."}  open a URL; go straight to a URL when you can (e.g. https://www.google.com/search?q=...)
{"click":3}  click element [3]
{"type":[5,"text"]}  replace the text in field [5]
{"enter":[5,"text"]}  type into field [5] and press Enter
{"select":[7,"option text"]}  choose from a dropdown
{"scroll":"down"} or {"scroll":"up"}
{"back":true}
{"read":true}  the whole page's text (articles, long results)

Desktop actions (anything outside the browser):
{"run":"bash command"}  the fastest way to open programs, files and folders; end with & to leave a program open
{"click_on":"what to click, described plainly, e.g. the Terminal icon in the bottom panel"}
{"double_click_on":"..."}
{"type_text":"text"}  types into whatever has focus
{"key":"ctrl+l"}  xdotool key names: Return Tab Escape ctrl+c alt+F4
{"look":"a question about the screen"}  a careful look, for things not in the browser text

Rules:
- Element numbers belong to the page shown now. If an action loads a new page, the rest of your list is skipped and you get the new page.
- Fill every field of a form in one turn, then click the button last.
- After each turn, check the new page: if something did not work, try another way instead of repeating it.
- Never type passwords, card numbers or one-time codes, and never buy anything. If the goal needs a password, a phone number, a verification code or a CAPTCHA, stop with "fail" and say exactly what the person has to do.
- As soon as the goal is met or the question answered, stop with "done" and put the answer in it.`;

// The two models the operator uses, set by makeComputer (think: text, see: vision).
const models = { think: async () => "", see: async () => "" };
const LOOK = `You look at a screenshot of a Linux desktop for an AI agent. Answer the question about it briefly and exactly: what is open, what has focus, the exact text that matters, and any dialog, error or popup.`;
const FIND = `You find things on a screenshot of a computer screen. Give the centre of the thing asked for as normalized coordinates from 0 to 1000 (x from the left edge, y from the top edge). Answer with only JSON: {"x":0,"y":0}. If it is not on the screen, answer {"x":-1,"y":-1}.`;

const clip = (t, n) => { t = String(t || "").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
function firstJson(raw) {
  raw = String(raw || "").replace(/```(?:json)?/g, "");
  for (let i = raw.indexOf("{"); i >= 0; i = raw.indexOf("{", i + 1)) {
    for (let j = raw.lastIndexOf("}"); j > i; j = raw.lastIndexOf("}", j - 1)) {
      try { return JSON.parse(raw.slice(i, j + 1)); } catch {}
    }
  }
  return null;
}
function pageText(p) {
  const els = (p.els || []).map((e) => {
    const name = e.name || (e.href ? `→ ${e.href}` : "(no label)");
    let t = `[${e.i}] ${e.role}${e.type && !["text", "submit", "button"].includes(e.type) ? `:${e.type}` : ""} "${name}"`;
    if (e.value != null && e.value !== "") t += ` = "${e.value}"`;
    else if (e.value === "" && /input|textarea|textbox|searchbox|combobox/.test(e.role)) t += " (empty)";
    if (e.checked != null) t += e.checked ? " (checked)" : " (unchecked)";
    if (e.options) t += ` options: ${e.options.join(" / ")}`;
    if (e.disabled) t += " (disabled)";
    if (e.expanded != null) t += e.expanded ? " (open)" : " (closed)";
    return t;
  });
  const sc = p.scroll || {};
  const more = sc.h && sc.y + sc.vh < sc.h - 20 ? "more below" : "end of page";
  return [`URL: ${p.url}`, `Title: ${p.title}`, sc.h ? `Scroll: ${sc.y}px of ${sc.h}px (${sc.y > 10 ? "scrolled, " : ""}${more})` : "", p.alerts?.length ? `Alerts: ${p.alerts.join(" | ")}` : "",
    `Elements:\n${els.join("\n") || "(none visible)"}`, `Visible text: ${clip(p.text, 2400)}`].filter(Boolean).join("\n");
}
const SECRET_RE = /pass ?(word|code|phrase)|\bpin\b|card ?(number|no)|\bcvv\b|\bcvc\b|security code|one[- ]?time|\botp\b|verification code|2fa|two[- ]factor|authenticator/i;
const secret = (p, i) => { const e = p?.els?.find((x) => x.i === +i); return !!e && (e.type === "password" || SECRET_RE.test(e.name || "")); };
const brief = (p) => (p ? { url: p.url, title: p.title } : null);
// Where on the screen is it? The vision model answers on a 0-1000 grid.
async function locate(vm, target) {
  const shot = await vm("/screen", { grid: false }, 40_000);
  const raw = await models.see(shot.png, "image/png", FIND, `Where is ${target}?`).catch(() => "");
  const j = firstJson(raw);
  if (!j || !(j.x >= 0 && j.y >= 0)) return null;
  return { x: Math.round((Math.min(1000, j.x) / 1000) * shot.w), y: Math.round((Math.min(1000, j.y) / 1000) * shot.h) };
}

export function makeComputer({ file = "/etc/cloak-brain/computer.json", stateDir, log = () => {}, isAdmin = () => false, vision, think, see }) {
  if (think) models.think = think;
  if (see) models.see = see;
  let conf = null;
  const load = () => { try { conf = JSON.parse(fs.readFileSync(file, "utf8")); if (conf.version !== 2) conf = null; } catch { conf = null; } return conf; };
  load();
  const ROOT = () => conf?.root || "/var/lib/cloak-vm";
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const agentCode = (() => { try { return fs.readFileSync(path.join(HERE, "vm", "agent.py")); } catch { return null; } })();
  const agentVersion = agentCode ? crypto.createHash("sha256").update(agentCode).digest("hex").slice(0, 16) : null;

  const uidOf = (key) => crypto.createHash("sha256").update("cloak-vm:" + String(key)).digest("hex").slice(0, 20);
  const domName = (kind, uid) => `cloak-${kind === "desktop" ? "d" : "s"}-${uid}`;
  const userDir = (uid) => path.join(ROOT(), "users", uid);

  // Each machine's own key, kept where only the brain can read it.
  function keysFor(uid) {
    const f = path.join(stateDir, `${uid}.json`);
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const k = { desktop: crypto.randomBytes(24).toString("hex"), server: crypto.randomBytes(24).toString("hex") };
    fs.writeFileSync(f, JSON.stringify(k), { mode: 0o600 });
    return k;
  }

  let frame = null; // the latest screen, for the person driving: { key, png, at }

  // ── Slots: which person's machine is running where ────────────────────
  // occupant: { key, uid, state: waking|ready|stopping, lastUse }
  const slots = { desktop: { ...DESKTOP, occ: null, lease: null }, servers: SERVERS.map((s) => ({ ...s, occ: null })) };
  const slotsFile = path.join(stateDir, "slots.json");
  const saveSlots = () => fs.writeFileSync(slotsFile, JSON.stringify({ desktop: slots.desktop.occ && { key: slots.desktop.occ.key, uid: slots.desktop.occ.uid }, servers: slots.servers.map((s) => s.occ && { key: s.occ.key, uid: s.occ.uid }) }), { mode: 0o600 });

  // One change to the slots at a time.
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function agent(slot, uid, p, body, ms = 60_000) {
    const token = keysFor(uid)[slot.kind];
    const res = await fetch(`http://${slot.ip}:8765${p}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Agent-Token": token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(ms),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `the ${slot.kind} answered ${res.status}`);
    if (slot.occ && slot.occ.uid === uid) slot.occ.seen = Date.now();
    return out;
  }
  // One call to this person's machine. If the connection dropped (the VM
  // restarted, slept, or its network blinked), reconnect, waking it if it
  // has to, and try once more instead of failing the task.
  async function call(kind, key, p, body, ms, onWake) {
    let s = await machine(kind, key);
    try { return { s, r: await agent(s, s.occ.uid, p, body, ms) }; }
    catch (e) {
      if (/answered \d/.test(e.message)) throw e; // the machine answered: a real error, not a lost connection
      log("info", `lost the ${kind} (${e.message}); reconnecting`);
      if (s.occ) { s.occ.state = "lost"; s.occ.seen = 0; }
      onWake?.();
      s = await machine(kind, key);
      return { s, r: await agent(s, s.occ.uid, p, body, ms) };
    }
  }
  const awake = (kind, key) => { const s = kind === "desktop" ? slots.desktop : slots.servers.find((x) => x.occ?.key === key); return !!(s?.occ && s.occ.key === key && s.occ.state === "ready"); };
  const healthy = (slot, uid) => agent(slot, uid, "/health", null, 4_000).catch(() => null);

  // ── A person's machine: disk, seed and definition ─────────────────────
  async function ensureMachine(kind, key, slot) {
    const uid = uidOf(key), dir = userDir(uid), disk = path.join(dir, `${kind}.qcow2`), seed = path.join(dir, `seed-${kind}.iso`);
    const base = path.join(ROOT(), "base", `${kind}.qcow2`);
    if (!fs.existsSync(base)) throw new Error("the computer is not set up on this brain yet");
    await fsp.mkdir(dir, { recursive: true, mode: 0o711 });
    if (!fs.existsSync(disk)) {
      const st = await fsp.statfs(ROOT()).catch(() => null);
      if (st && st.bavail * st.bsize < MIN_FREE) throw new Error("the brain PC is low on disk space, so no new machines can be made right now");
      const r = await sh("qemu-img", ["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", base, disk]);
      if (!r.ok) throw new Error(`could not make the ${kind} disk: ${r.err.slice(0, 200)}`);
      log("info", `made a new ${kind} for a person`);
    }
    if (!fs.existsSync(seed)) {
      const token = keysFor(uid)[kind];
      const ud = `#cloud-config
hostname: cloak-${kind}
users:
  - name: cloak
    shell: /bin/bash
    lock_passwd: true
    sudo: "ALL=(ALL) NOPASSWD:ALL"
write_files:
  - path: /etc/cloak/agent.json
    permissions: '0600'
    content: '${JSON.stringify({ token, kind, user: "cloak", port: 8765, brain: "10.77.0.1" })}'
runcmd:
  - [systemctl, restart, cloak-agent]
`;
      await fsp.writeFile(path.join(dir, `ud-${kind}`), ud, { mode: 0o600 });
      await fsp.writeFile(path.join(dir, `md-${kind}`), `instance-id: cloak-${kind}-${uid}\nlocal-hostname: cloak-${kind}\n`, { mode: 0o600 });
      const r = await sh("cloud-localds", [seed, path.join(dir, `ud-${kind}`), path.join(dir, `md-${kind}`)]);
      await fsp.rm(path.join(dir, `ud-${kind}`), { force: true });
      await fsp.rm(path.join(dir, `md-${kind}`), { force: true });
      if (!r.ok) throw new Error(`could not make the ${kind} seed: ${r.err.slice(0, 200)}`);
    }
    // (Re)define it for the slot it is about to run in.
    const name = domName(kind, uid);
    // Already running (a wake raced another): leave it be.
    const ds = await virsh("domstate", name);
    if (ds.ok && /running|paused/.test(ds.out)) return { uid, name };
    // Already defined: keep its UUID, or libvirt refuses the redefine.
    const du = await virsh("domuuid", name);
    const uuid = du.ok && /^[0-9a-f-]{36}$/i.test(du.out.trim()) ? du.out.trim() : "";
    const xml = `<domain type='kvm'>
  <name>${name}</name>${uuid ? `<uuid>${uuid}</uuid>` : ""}
  <memory unit='MiB'>${slot.mb}</memory><currentMemory unit='MiB'>${slot.mb}</currentMemory>
  <vcpu>${slot.cpus}</vcpu>
  <os><type arch='x86_64' machine='q35'>hvm</type><boot dev='hd'/></os>
  <features><acpi/><apic/></features>
  <cpu mode='host-passthrough'/>
  <clock offset='utc'/>
  <on_poweroff>destroy</on_poweroff><on_reboot>restart</on_reboot><on_crash>destroy</on_crash>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2' discard='unmap'/><source file='${esc(disk)}'/><target dev='vda' bus='virtio'/></disk>
    <disk type='file' device='cdrom'><driver name='qemu' type='raw'/><source file='${esc(seed)}'/><target dev='sda' bus='sata'/><readonly/></disk>
    <interface type='network'>
      <source network='cloak-vm'/><mac address='${slot.mac}'/><model type='virtio'/>
      <port isolated='yes'/>
      <filterref filter='clean-traffic'><parameter name='IP' value='${slot.ip}'/></filterref>
    </interface>
    ${kind === "desktop" ? "<graphics type='vnc' listen='127.0.0.1' autoport='yes'/><video><model type='qxl'/></video>" : "<video><model type='none'/></video>"}
    <serial type='pty'/><console type='pty'/>
    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>
    <memballoon model='virtio'/>
  </devices>
</domain>`;
    const xf = path.join(stateDir, `${name}.xml`);
    await fsp.writeFile(xf, xml, { mode: 0o600 });
    const d = await virsh("define", xf);
    if (!d.ok) throw new Error(`could not set up the ${kind}: ${d.err.slice(0, 200)}`);
    return { uid, name };
  }

  async function stopMachine(slot) {
    const occ = slot.occ;
    if (!occ) return;
    occ.state = "stopping";
    const name = domName(slot.kind, occ.uid);
    log("info", `shutting down a ${slot.kind}`);
    await virsh("shutdown", name);
    for (let i = 0; i < 30; i++) {
      if (!/running/.test((await virsh("domstate", name)).out)) break;
      await wait(2000);
    }
    if (/running/.test((await virsh("domstate", name)).out)) await virsh("destroy", name);
    slot.occ = null;
    if (slot.kind === "desktop") { slot.lease = null; frame = null; }
    saveSlots();
  }

  async function bootInto(slot, kind, key) {
    const { uid, name } = await ensureMachine(kind, key, slot);
    slot.occ = { key, uid, state: "waking", lastUse: Date.now() };
    saveSlots();
    log("info", `waking a ${kind}`);
    if (!/running/.test((await virsh("domstate", name)).out)) {
      const r = await virsh("start", name);
      if (!r.ok && !/already active/i.test(r.err)) { slot.occ = null; saveSlots(); throw new Error(`could not start the ${kind}: ${r.err.slice(0, 200)}`); }
    }
    const until = Date.now() + WAKE_MS;
    let tries = 0;
    while (Date.now() < until) {
      const h = await healthy(slot, uid);
      if (h) {
        if (agentVersion && h.version !== agentVersion && tries++ < 2) {
          await agent(slot, uid, "/update", { code: agentCode.toString("base64") }, 15_000).catch(() => {});
          await wait(2500);
          continue;
        }
        if (kind === "desktop") await wait(1500);
        slot.occ.state = "ready";
        slot.occ.lastUse = Date.now();
        return slot;
      }
      await wait(2000);
    }
    await stopMachine(slot).catch(() => {});
    throw new Error(`the ${kind} did not wake up in time`);
  }

  // The slot running this person's machine, booting it if needed.
  // Someone driving their desktop by hand (a CAPTCHA, a sign-in): the operator waits.
  const held = new Map(); // key -> until
  const holding = (key) => (held.get(key) || 0) > Date.now();
  const waking = new Map();
  const failed = new Map(); // `${kind}:${key}` -> { error, at }: why the last wake failed, for the app
  function machine(kind, key) {
    const id = `${kind}:${key}`;
    if (waking.has(id)) return waking.get(id);
    failed.delete(id);
    const p = serial(async () => {
      const now = Date.now();
      if (kind === "desktop") {
        const s = slots.desktop;
        // Answered moments ago: no need to ask again (that check cost every action time).
        if (s.occ && s.occ.key === key && s.occ.state === "ready" && (Date.now() - (s.occ.seen || 0) < 20_000 || (await healthy(s, s.occ.uid)))) return s;
        if (s.occ && s.occ.key !== key) {
          if (s.lease && s.lease.until > now) throw new Busy("The computer is being used by someone else right now.");
          await stopMachine(s);
        }
        s.lease = { key, until: now + LEASE_MS };
        return bootInto(s, "desktop", key);
      }
      let s = slots.servers.find((x) => x.occ && x.occ.key === key);
      if (s && s.occ.state === "ready" && (Date.now() - (s.occ.seen || 0) < 20_000 || (await healthy(s, s.occ.uid)))) return s;
      if (!s) s = slots.servers.find((x) => !x.occ);
      if (!s) {
        const quiet = slots.servers.filter((x) => x.occ && x.occ.state === "ready" && now - x.occ.lastUse > HANDOVER_MS).sort((a, b) => a.occ.lastUse - b.occ.lastUse)[0];
        if (!quiet) throw new Busy("Both server slots are busy right now. Try again in a minute.");
        await stopMachine(quiet);
        s = quiet;
      }
      return bootInto(s, "server", key);
    });
    waking.set(id, p);
    p.catch((e) => { if (!(e instanceof Busy)) { failed.set(id, { error: String(e.message).slice(0, 200), at: Date.now() }); log("error", `${kind} wake failed: ${e.message}`); } });
    p.finally(() => waking.delete(id)).catch(() => {});
    return p;
  }
  function claim(key) {
    const s = slots.desktop, now = Date.now();
    if (s.occ && s.occ.key !== key && s.lease && s.lease.until > now) throw new Busy("The computer is being used by someone else right now.");
    if (s.occ?.key === key || !s.occ) s.lease = { key, until: now + LEASE_MS };
  }
  const touch = (slot) => { if (slot.occ) slot.occ.lastUse = Date.now(); if (slot.kind === "desktop" && slot.lease) slot.lease.until = Date.now() + LEASE_MS; };

  // ── At start: adopt machines that are still running, stop strays ───────
  async function adopt() {
    if (!load()) return;
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(slotsFile, "utf8")); } catch {}
    const running = (await virsh("list", "--name")).out.split("\n").filter((n) => /^cloak-[ds]-/.test(n));
    const keep = new Set();
    const take = async (slot, o) => {
      if (!o) return;
      const name = domName(slot.kind, o.uid);
      if (running.includes(name) && (await healthy(slot, o.uid))) { slot.occ = { key: o.key, uid: o.uid, state: "ready", lastUse: Date.now() }; keep.add(name); }
    };
    await take(slots.desktop, saved.desktop);
    for (let i = 0; i < slots.servers.length; i++) await take(slots.servers[i], (saved.servers || [])[i]);
    for (const n of running) if (!keep.has(n)) await virsh("destroy", n);
    saveSlots();
  }
  adopt().catch((e) => log("error", `computer start: ${e.message}`));
  setInterval(() => serial(async () => {
    const now = Date.now();
    for (const s of [slots.desktop, ...slots.servers]) {
      if (!s.occ || s.occ.state !== "ready") continue;
      const held = s.kind === "desktop" && s.lease && s.lease.until > now;
      if (!held && now - s.occ.lastUse > IDLE_MS) await stopMachine(s).catch((e) => log("error", `sleep failed: ${e.message}`));
    }
  }), 60_000).unref?.();

  const api = {
    get available() { return !!(conf || load()); },
    allowed(email) { return !!conf && (conf.access === "everyone" || isAdmin(email)); },
    status(key, email) {
      if (!conf && !load()) return { available: false };
      const d = slots.desktop, now = Date.now();
      const mineD = d.occ && d.occ.key === key;
      const other = d.occ && !mineD && (d.occ.state !== "ready" || (d.lease && d.lease.until > now));
      const sv = slots.servers.find((x) => x.occ && x.occ.key === key);
      // The brain page asks with no person: show every machine as it really is.
      if (key == null) return {
        available: true, allowed: true, access: conf.access || "admins",
        desktop: { state: d.occ ? d.occ.state : "asleep", holder: d.occ ? "someone" : null },
        server: { state: slots.servers.some((x) => x.occ?.state === "ready") ? "ready" : (slots.servers.find((x) => x.occ)?.occ.state || "asleep") },
        servers: slots.servers.map((x) => (x.occ ? x.occ.state : "asleep")),
        slots: { desktop: 1, servers: slots.servers.length, serversFree: slots.servers.filter((x) => !x.occ).length },
      };
      return {
        available: true, allowed: api.allowed(email), access: conf.access || "admins",
        desktop: { state: mineD ? d.occ.state : "asleep", holder: mineD ? "you" : other ? "someone" : null, error: failed.get(`desktop:${key}`)?.error || null, takeover: holding(key) },
        server: { state: sv ? sv.occ.state : "asleep", error: failed.get(`server:${key}`)?.error || null },
        slots: { desktop: 1, servers: slots.servers.length, serversFree: slots.servers.filter((x) => !x.occ).length },
      };
    },
    async wakeFor(key, kind = "desktop") { return machine(kind === "server" ? "server" : "desktop", key); },
    release(key) { const d = slots.desktop; if (d.occ?.key === key && d.lease) d.lease.until = 0; if (frame?.key === key) frame = null; return true; },
    async frameFor(key) {
      const d = slots.desktop;
      if (!d.occ || d.occ.key !== key || d.occ.state !== "ready") return null;
      if (!frame || frame.key !== key || Date.now() - frame.at > 1500) {
        const s = await agent(d, d.occ.uid, "/screen", { grid: false }, 30_000).catch(() => null);
        if (s) frame = { key, png: s.png, at: Date.now() };
      }
      return frame && frame.key === key ? Buffer.from(frame.png, "base64") : null;
    },
    setAccess(access) {
      if (!conf) return false;
      conf.access = access === "everyone" ? "everyone" : "admins";
      fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
      return true;
    },
    sleepAll() { return serial(async () => { for (const s of [slots.desktop, ...slots.servers]) await stopMachine(s).catch(() => {}); }); },
    // Everything this person has on the computer, gone: machines, disks, keys.
    wipe(key) {
      const uid = uidOf(key);
      return serial(async () => {
        for (const s of [slots.desktop, ...slots.servers]) if (s.occ && s.occ.key === key) await stopMachine(s).catch(() => {});
        for (const kind of ["desktop", "server"]) {
          const name = domName(kind, uid);
          await virsh("destroy", name);
          await virsh("undefine", name);
          await fsp.rm(path.join(stateDir, `${name}.xml`), { force: true });
        }
        await fsp.rm(userDir(uid), { recursive: true, force: true });
        await fsp.rm(path.join(stateDir, `${uid}.json`), { force: true });
        log("info", "a person's machines were deleted");
      });
    },
    // What the agent's tools call, for one person.
    forUser(key, emit = () => {}) {
      const notify = () => emit({ computer: { at: Date.now() } });
      return {
        async look(question) {
          claim(key);
          const { s, r: shot } = await call("desktop", key, "/screen", { grid: false }, 40_000);
          touch(s);
          frame = { key, png: shot.png, at: Date.now() };
          notify();
          const desc = await vision(shot.png, "image/png", question, shot.w, shot.h);
          return { w: shot.w, h: shot.h, text: desc };
        },
        async input(action, quick = false) {
          claim(key);
          const { s, r } = await call("desktop", key, "/input", action, 30_000);
          touch(s);
          if (!quick) { await wait(350); notify(); }
          return r;
        },
        // Taking over by hand: the operator pauses until it is handed back.
        takeover(on) {
          claim(key);
          if (on) held.set(key, Date.now() + 2 * 60_000); else held.delete(key); // kept alive by their live frames; a closed tab lets go within 2 minutes
          notify();
          return holding(key);
        },
        async live() {
          const d = slots.desktop;
          if (!d.occ || d.occ.key !== key || d.occ.state !== "ready") return null;
          if (holding(key)) held.set(key, Date.now() + 2 * 60_000); // still watching: keep it theirs
          touch(d);
          const s = await agent(d, d.occ.uid, "/screen", { fast: true }, 15_000);
          return { w: s.w, h: s.h, jpg: Buffer.from(s.jpg, "base64") };
        },
        // The operator: the agent that does the work on the desktop. It reads the
        // browser page as numbered elements (exact clicks and typing, no pixel
        // guessing), uses a fast text model to decide, and only looks at the
        // screen for things outside the browser, where a vision model finds the
        // exact point to click. Several actions per model call.
        async operate(goal, signal, onStep = () => {}, opts = {}) {
          claim(key);
          if (!awake("desktop", key)) onStep("Waking the computer (about a minute)");
          await machine("desktop", key);
          const wake = () => onStep("Reconnecting to the computer");
          const vm = async (p, body, ms = 60_000) => { const { s, r } = await call("desktop", key, p, body, ms, wake); touch(s); return r; };
          const history = [], said = [];
          let page = null, windows = [], note = "", lastSeen = "", same = 0;
          const t0 = Date.now();
          const peek = await vm("/browser", { op: "peek" }, 20_000).catch(() => null);
          if (peek?.open) page = peek.page;
          for (let step = 0; step < 30; step++) {
            if (signal?.aborted) return { ok: false, text: "Stopped.", steps: history };
            if (Date.now() - t0 > 9 * 60_000) return { ok: false, text: "This was taking too long, so I stopped. Here is where it got to.", steps: history, page: brief(page) };
            // What the person sent meanwhile reaches the operator too.
            const heard = (await opts.notes?.().catch?.(() => [])) || [];
            if (heard.length) {
              said.push(...heard);
              if (heard.some((t) => /^\s*(stop|cancel|never ?mind|halt|quit|abort)\b/i.test(t))) return { ok: false, text: `Stopped because they said: "${heard.join(" ")}".`, steps: history, page: brief(page) };
            }
            if (holding(key)) {
              onStep("Waiting while you use the computer");
              while (holding(key) && !signal?.aborted) await wait(800);
              const p2 = await vm("/browser", { op: "peek" }, 20_000).catch(() => null);
              if (p2?.open) page = p2.page;
              note = "The person just used the computer themselves (for example to solve a CAPTCHA or sign in). Look at the screen as it is now and carry on from there.";
              history.push("the person took over and handed back");
              onStep("Carrying on");
            }
            windows = ((await vm("/browser", { op: "windows" }, 15_000).catch(() => null))?.windows) || windows;
            const seenNow = JSON.stringify([page?.url, page?.text?.slice(0, 600), page?.els?.length, windows]);
            same = seenNow === lastSeen ? same + 1 : 0;
            lastSeen = seenNow;
            if (same >= 4) return { ok: false, text: "Nothing on screen changed for several tries, so I stopped.", steps: history, page: brief(page) };
            const user = [
              `Goal: ${goal}`,
              said.length ? `The person said while you worked: ${said.map((t) => `"${t}"`).join(" ")}` : "",
              history.length ? `Done so far:\n${history.slice(-14).map((h, i) => `${Math.max(0, history.length - 14) + i + 1}. ${h}`).join("\n")}` : "Done so far: nothing yet.",
              `\nNow on the screen:\nWindows: ${windows.join(" | ") || "(none)"}`,
              page ? `Browser:\n${pageText(page)}` : "Browser: not open yet (goto opens it).",
              note ? `\nNote: ${note}` : "",
              same ? "\nNothing changed since your last turn. Do something different." : "",
              "\nYour JSON:",
            ].filter(Boolean).join("\n");
            note = "";
            const raw = await models.think(OPERATOR, user).catch((e) => { log("error", `operator: ${e.message}`); return ""; });
            const j = firstJson(raw);
            if (!j) { note = "Your last answer was not valid JSON. Answer with one JSON object only."; continue; }
            if (j.done != null) return { ok: true, text: String(j.done).slice(0, 4000), steps: history, page: brief(page) };
            if (j.fail != null) return { ok: false, text: String(j.fail).slice(0, 2000), steps: history, page: brief(page) };
            const acts = (Array.isArray(j.actions) ? j.actions : [j]).slice(0, 6);
            for (let n = 0; n < acts.length; n++) {
              if (signal?.aborted) break;
              const a = acts[n] || {};
              const before = page ? `${page.url}|${page.title}` : "";
              const label = (i) => { const e = page?.els?.find((x) => x.i === +i); return e ? `“${(e.name || e.href || e.role).slice(0, 40)}”` : `[${i}]`; };
              try {
                let what = "", r = null;
                if (a.goto) { onStep(`Opening ${String(a.goto).replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}`); r = await vm("/browser", { op: "goto", url: String(a.goto) }, 45_000); what = `goto ${a.goto}`; }
                else if (a.click != null) { onStep(`Clicking ${label(a.click)}`); what = `click [${a.click}] ${label(a.click)}`; r = await vm("/browser", { op: "click", i: a.click }, 45_000); }
                else if ((a.type || a.enter) && secret(page, (a.type || a.enter)[0])) {
                  // Enforced here, not just asked for: passwords, cards and codes are the person's to type.
                  history.push(`refused to type into ${label((a.type || a.enter)[0])}: passwords, card numbers and codes are for the person to enter`);
                  note = "You may not fill in passwords, card numbers or verification codes. Stop now with \"fail\" and tell the person exactly what they need to enter themselves, and where.";
                  break;
                }
                else if (a.type || a.enter) { const [i, t] = a.type || a.enter; onStep(`Typing into ${label(i)}`); what = `${a.enter ? "enter" : "type"} [${i}] ${label(i)}: "${String(t).slice(0, 60)}"`; r = await vm("/browser", { op: "type", i, text: String(t ?? ""), enter: !!a.enter }, 45_000); }
                else if (a.select) { const [i, o] = a.select; onStep(`Choosing ${String(o).slice(0, 30)}`); what = `select [${i}] "${o}"`; r = await vm("/browser", { op: "select", i, option: String(o) }, 30_000); }
                else if (a.scroll) { onStep(`Scrolling ${a.scroll === "up" ? "up" : "down"}`); what = `scroll ${a.scroll}`; r = await vm("/browser", { op: "scroll", dir: a.scroll === "up" ? "up" : "down" }, 30_000); }
                else if (a.back) { onStep("Going back"); what = "back"; r = await vm("/browser", { op: "back" }, 45_000); }
                else if (a.read) { onStep("Reading the page"); what = "read the page"; r = await vm("/browser", { op: "read" }, 45_000); }
                else if (a.run) { onStep(`Running ${String(a.run).slice(0, 40)}`); const o = await vm("/run", { cmd: String(a.run), timeout: 60 }, 95_000); what = `run \`${String(a.run).slice(0, 120)}\` → exit ${o.code}${o.stdout ? `, out: ${String(o.stdout).trim().slice(-300)}` : ""}${o.stderr ? `, err: ${String(o.stderr).trim().slice(-200)}` : ""}`; await wait(700); }
                else if (a.click_on || a.double_click_on) {
                  const target = String(a.click_on || a.double_click_on);
                  onStep(`Clicking ${target.slice(0, 40)}`);
                  const pt = await locate(vm, target);
                  if (!pt) { what = `could not find "${target}" on the screen`; note = what; break; }
                  await vm("/input", { action: a.double_click_on ? "double" : "click", x: pt.x, y: pt.y }, 30_000);
                  what = `${a.double_click_on ? "double-clicked" : "clicked"} ${target} at ${pt.x},${pt.y}`; await wait(500);
                }
                else if (a.type_text != null) { onStep("Typing"); await vm("/input", { action: "type", text: String(a.type_text) }, 30_000); what = `typed "${String(a.type_text).slice(0, 60)}"`; }
                else if (a.key) { onStep(`Pressing ${String(a.key).slice(0, 20)}`); await vm("/input", { action: "key", keys: String(a.key) }, 30_000); what = `pressed ${a.key}`; await wait(300); }
                else if (a.look) { onStep("Looking at the screen"); const shot = await vm("/screen", { grid: false }, 40_000); frame = { key, png: shot.png, at: Date.now() }; const seen = await models.see(shot.png, "image/png", LOOK, String(a.look)).catch(() => ""); what = `looked (${a.look}): ${clip(seen, 900)}`; }
                else { note = `Unknown action ${JSON.stringify(a).slice(0, 80)}.`; break; }
                if (r?.page) { page = r.page; if (r.page.note) what += ` (${r.page.note})`; }
                if (a.read && r?.page?.text) what += `\n${clip(r.page.text, 6000)}`;
                history.push(what);
                notify();
                // The page changed: element numbers are stale, so stop this batch.
                const after = page ? `${page.url}|${page.title}` : "";
                if (n < acts.length - 1 && (after !== before || a.goto || a.back || (a.enter && r?.page))) { if (acts.slice(n + 1).some((x) => x && (x.click != null || x.type || x.enter || x.select))) note = "The page changed, so the rest of your actions were skipped. Here is the new page."; break; }
              } catch (e) {
                const msg = String(e.message || e).slice(0, 200);
                history.push(`${Object.keys(a)[0] || "action"} failed: ${msg}`);
                note = `That failed: ${msg}`;
                break;
              }
            }
          }
          return { ok: false, text: "Ran out of steps before finishing. Here is where it got to.", steps: history, page: brief(page) };
        },
        async run(kind, cmd, timeout, onStep) {
          if (kind === "desktop") claim(key);
          if (!awake(kind, key)) onStep?.(`Waking the ${kind === "server" ? "server" : "computer"} (about a minute)`);
          if (kind === "desktop") notify();
          const { s, r } = await call(kind, key, "/run", { cmd, timeout }, (Math.min(Number(timeout) || 60, 600) + 30) * 1000, () => onStep?.(`Reconnecting to the ${kind === "server" ? "server" : "computer"}`));
          touch(s);
          return r;
        },
      };
    },
  };
  return api;
}
