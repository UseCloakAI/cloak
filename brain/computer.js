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

export function makeComputer({ file = "/etc/cloak-brain/computer.json", stateDir, log = () => {}, isAdmin = () => false, vision }) {
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
    return out;
  }
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
  const waking = new Map();
  function machine(kind, key) {
    const id = `${kind}:${key}`;
    if (waking.has(id)) return waking.get(id);
    const p = serial(async () => {
      const now = Date.now();
      if (kind === "desktop") {
        const s = slots.desktop;
        if (s.occ && s.occ.key === key && s.occ.state === "ready" && (await healthy(s, s.occ.uid))) return s;
        if (s.occ && s.occ.key !== key) {
          if (s.lease && s.lease.until > now) throw new Busy("The computer is being used by someone else right now.");
          await stopMachine(s);
        }
        s.lease = { key, until: now + LEASE_MS };
        return bootInto(s, "desktop", key);
      }
      let s = slots.servers.find((x) => x.occ && x.occ.key === key);
      if (s && s.occ.state === "ready" && (await healthy(s, s.occ.uid))) return s;
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
      return {
        available: true, allowed: api.allowed(email), access: conf.access || "admins",
        desktop: { state: mineD ? d.occ.state : "asleep", holder: mineD ? "you" : other ? "someone" : null },
        server: { state: sv ? sv.occ.state : "asleep" },
        slots: { desktop: 1, servers: slots.servers.length, serversFree: slots.servers.filter((x) => !x.occ).length },
      };
    },
    async wakeFor(key, kind = "desktop") { return machine(kind === "server" ? "server" : "desktop", key); },
    release(key) { const d = slots.desktop; if (d.occ?.key === key && d.lease) d.lease.until = 0; if (frame?.key === key) frame = null; return true; },
    async frameFor(key) {
      const d = slots.desktop;
      if (!d.occ || d.occ.key !== key || d.occ.state !== "ready") return null;
      if (!frame || frame.key !== key || Date.now() - frame.at > 1500) {
        const s = await agent(d, d.occ.uid, "/screen", {}, 30_000).catch(() => null);
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
          const s = await machine("desktop", key);
          const shot = await agent(s, s.occ.uid, "/screen", {}, 40_000);
          touch(s);
          frame = { key, png: shot.png, at: Date.now() };
          notify();
          const desc = await vision(shot.grid || shot.png, shot.grid ? "image/jpeg" : "image/png", question, shot.w, shot.h);
          return { w: shot.w, h: shot.h, text: desc };
        },
        async input(action) {
          claim(key);
          const s = await machine("desktop", key);
          const r = await agent(s, s.occ.uid, "/input", action, 30_000);
          touch(s);
          await wait(350);
          notify();
          return r;
        },
        async run(kind, cmd, timeout) {
          if (kind === "desktop") claim(key);
          const s = await machine(kind, key);
          if (kind === "desktop") notify();
          const r = await agent(s, s.occ.uid, "/run", { cmd, timeout }, (Math.min(Number(timeout) || 60, 600) + 30) * 1000);
          touch(s);
          return r;
        },
      };
    },
  };
  return api;
}
