// Cloak sandbox: where the brain runs code a Blink wrote, before anyone sees
// it. One locked-down runner for everybody's checks:
//
//   - bubblewrap: its own user, mount, pid, ipc and NETWORK namespaces. The
//     code sees a read-only /usr, a throwaway /work with just its own files,
//     and nothing else: no brain data, no other person's files, no internet,
//     no LAN.
//   - a hard time limit; the whole process group is killed after it.
//   - nothing from one run survives into the next (the folder is deleted).
//
// If bubblewrap or Chromium is missing, checks that need them are reported as
// unavailable. Code is NEVER run outside the sandbox.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "sandbox", "driver.mjs");
const CHROMES = ["/usr/lib/chromium/chromium", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;

export function makeSandbox({ dir, log = () => {}, wrap, chrome } = {}) {
  const nodeBin = process.execPath, nodeDir = path.dirname(path.dirname(nodeBin));
  const chromeBin = chrome || CHROMES.find((c) => fs.existsSync(c)) || null;
  let state = null;
  // What works on this machine, checked once (and re-checked after an update restarts the brain).
  function probe() {
    if (state) return state;
    const bwrap = wrap ? true : has("bwrap") && spawnSync("bwrap", ["--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "/usr/bin/true"], { timeout: 8000 }).status === 0;
    state = { isolated: bwrap, html: bwrap && !!chromeBin, js: bwrap, python: bwrap && (wrap ? has("python3") : fs.existsSync("/usr/bin/python3")) };
    log("info", `sandbox: ${bwrap ? "ready" : "bubblewrap is missing or blocked, code checks are off"}${bwrap ? ` (web pages ${state.html ? "yes" : "no, Chromium is not installed"}, python ${state.python ? "yes" : "no"})` : ""}`);
    return state;
  }
  // The lockdown. Everything the code can see is listed here.
  const jail = (work, cmd) => wrap ? wrap(work, cmd) : ["bwrap",
    "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/alternatives", "/etc/alternatives", "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind", nodeDir, "/node", "--ro-bind", DRIVER, "/driver.mjs",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm", "--tmpfs", "/home",
    "--bind", work, "/work", "--chdir", "/work",
    "--clearenv", "--setenv", "PATH", "/node/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "CHROME", chromeBin || "", "--setenv", "RUN_MS", "8000",
    "--hostname", "sandbox",
    ...cmd];

  const queue = []; let busy = 0; // two checks at a time: this PC also runs VMs
  const slot = () => new Promise((r) => { const go = () => { busy++; r(); }; busy < 2 ? go() : queue.push(go); });
  const free = () => { busy--; const n = queue.shift(); if (n) n(); };

  // files: [{ name, content }], entry: the file to check, kind: html | js | python
  async function run({ files, entry, kind }) {
    const s = probe();
    if (!s[kind]) return { kind, ok: false, unavailable: true, errors: [], warnings: [], notes: [`This brain cannot run ${kind} checks yet.`] };
    const id = crypto.randomBytes(8).toString("hex"), work = path.join(dir, id);
    await slot();
    try {
      await fsp.mkdir(work, { recursive: true, mode: 0o700 });
      let bytes = 0;
      for (const f of files.slice(0, 40)) {
        const name = String(f.name || "").replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..").join("/").slice(0, 120);
        if (!name) continue;
        bytes += Buffer.byteLength(f.content || "");
        if (bytes > 4e6) break;
        await fsp.mkdir(path.dirname(path.join(work, name)), { recursive: true });
        await fsp.writeFile(path.join(work, name), String(f.content || ""));
      }
      const inside = wrap ? [nodeBin, DRIVER, kind, entry] : ["/node/bin/node", "/driver.mjs", kind, entry];
      const argv = jail(work, inside);
      const t0 = Date.now();
      const res = await new Promise((resolve) => {
        const p = spawn(argv[0], argv.slice(1), { cwd: work, detached: true, stdio: ["ignore", "pipe", "pipe"], env: wrap ? { ...process.env, CHROME: chromeBin || "", RUN_MS: "8000" } : {} });
        let so = "", se = "";
        p.stdout.on("data", (d) => { if (so.length < 4e6) so += d; });
        p.stderr.on("data", (d) => { if (se.length < 2e5) se += d; });
        const kill = setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 60_000);
        p.on("close", (code) => { clearTimeout(kill); resolve({ code, so, se }); });
        p.on("error", (e) => { clearTimeout(kill); resolve({ code: -1, so: "", se: String(e.message) }); });
      });
      let rep = null;
      try { rep = JSON.parse(res.so.slice(res.so.indexOf("{"))); } catch {}
      if (!rep) { log("error", `sandbox run gave no report (${res.code}): ${res.se.slice(0, 300)}`); return { kind, ok: false, unavailable: true, errors: [], warnings: [], notes: ["The check could not run."] }; }
      if (rep.infra) { log("error", `sandbox check failed: ${(rep.errors || []).join("; ").slice(0, 300)}`); return { kind, ok: false, unavailable: true, errors: [], warnings: [], notes: ["The check could not run."] }; }
      rep.ms = Date.now() - t0;
      return rep;
    } finally {
      free();
      fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { run, status: () => ({ ...probe() }) };
}
