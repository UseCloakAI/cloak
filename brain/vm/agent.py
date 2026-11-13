#!/usr/bin/env python3
"""Cloak Computer agent: runs inside each person's own VM (as root) and does
what the brain asks.

Every VM belongs to exactly one person: their own disk, their own token,
their own account ("cloak", who has sudo on this machine only). The VM's
network port is isolated (it cannot see other VMs), and this agent only
answers the brain (10.77.0.1) with this VM's own token.

    GET  /health                      {ok, kind, mem, load, version}
    POST /run    {cmd, timeout}       a bash command as the person, with limits
    POST /screen                      the desktop as PNG + a JPEG with a labelled
                                      100px grid (desktop VMs only)
    POST /input  {action, ...}        click / double / right / move / drag / type /
                                      key / scroll (desktop VMs only)
    POST /browser {op, ...}           Firefox over Marionette: state / peek / goto /
                                      click / type / select / scroll / back / read /
                                      windows (desktop VMs only)
    POST /update {code}               a newer copy of this file from the brain

No dependencies beyond Python 3, xdotool and ImageMagick."""

import base64, hashlib, json, os, re, subprocess, pwd, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = json.load(open("/etc/cloak/agent.json"))
TOKEN = CONF["token"]
KIND = CONF.get("kind", "server")          # "desktop" or "server"
USER = CONF.get("user", "cloak")           # the person's account on their own VM
PORT = int(CONF.get("port", 8765))
BRAIN = CONF.get("brain", "10.77.0.1")     # the only address this agent answers
OUT_MAX = 64 * 1024
VERSION = hashlib.sha256(open(__file__, "rb").read()).hexdigest()[:16]

def x_env():
    home = pwd.getpwnam(USER).pw_dir
    return {"DISPLAY": ":0", "XAUTHORITY": os.path.join(home, ".Xauthority"), "PATH": "/usr/local/bin:/usr/bin:/bin"}

def run(cmd, timeout):
    timeout = max(1, min(int(timeout or 60), 600))
    home = pwd.getpwnam(USER).pw_dir
    env = ["-E", f"HOME={home}", "-E", f"USER={USER}", "-E", "LANG=C.UTF-8", "-E", "TERM=dumb"]
    if KIND == "desktop":
        env += ["-E", "DISPLAY=:0", "-E", f"XAUTHORITY={home}/.Xauthority"]
    # Limits keep one runaway command from freezing the person's own machine.
    # KillMode=process: programs the command leaves running (firefox &) stay
    # open after it returns, instead of dying with it. Output goes to files,
    # not pipes, so a program left running never holds the call open.
    argv = ["systemd-run", "--quiet", "--wait", "--pipe", "--collect", f"--uid={USER}", f"--gid={USER}",
            f"--working-directory={home}",
            "-p", "MemoryMax=85%", "-p", "TasksMax=2048", "-p", f"RuntimeMaxSec={timeout}", "-p", "KillMode=process",
            *env, "/bin/bash", "-lc", cmd]
    t0 = time.time()
    import tempfile
    with tempfile.TemporaryFile() as fo, tempfile.TemporaryFile() as fe:
        try:
            code = subprocess.run(argv, stdout=fo, stderr=fe, timeout=timeout + 15, stdin=subprocess.DEVNULL).returncode
            note = b""
        except subprocess.TimeoutExpired:
            code, note = 124, b"\n[stopped: took longer than the time limit]"
        fo.seek(0); fe.seek(0)
        out, err = fo.read(), fe.read() + note
    cut = lambda b: b[-OUT_MAX:].decode("utf-8", "replace")
    return {"code": code, "stdout": cut(out), "stderr": cut(err), "seconds": round(time.time() - t0, 1),
            "truncated": len(out) > OUT_MAX or len(err) > OUT_MAX}

def screen(grid=True):
    env = x_env()
    raw = subprocess.run(["import", "-display", ":0", "-window", "root", "png:-"], capture_output=True, env=env, timeout=20).stdout
    if not raw:
        raise RuntimeError("could not capture the screen (is the desktop up?)")
    # Screenshots leave the pointer out: draw a large one where it is, so the
    # model and the person watching both see it.
    try:
        loc = subprocess.run(["xdotool", "getmouselocation", "--shell"], capture_output=True, env=env, timeout=5).stdout.decode()
        px = int(re.search(r"X=(\d+)", loc).group(1)); py = int(re.search(r"Y=(\d+)", loc).group(1))
        pts = [(0, 0), (0, 34), (9, 26), (15, 39), (21, 36), (15, 24), (27, 24)]
        poly = " ".join(f"{px + dx},{py + dy}" for dx, dy in pts)
        drawn = subprocess.run(["convert", "png:-", "-fill", "white", "-stroke", "black", "-strokewidth", "2.5", "-draw", f"polygon {poly}", "png:-"],
                               input=raw, capture_output=True, timeout=15).stdout
        if drawn: raw = drawn
    except Exception:
        pass
    size = subprocess.run(["identify", "-format", "%w %h", "png:-"], input=raw, capture_output=True, timeout=10).stdout.decode().split()
    w, h = (int(size[0]), int(size[1])) if len(size) == 2 else (1280, 800)
    if not grid:
        return {"w": w, "h": h, "png": base64.b64encode(raw).decode(), "grid": None}
    # A labelled 100px grid, so a vision model can name coordinates.
    draw = []
    for x in range(100, w, 100):
        draw += ["-draw", f"line {x},0 {x},{h}"]
    for y in range(100, h, 100):
        draw += ["-draw", f"line 0,{y} {w},{y}"]
    labels = []
    for x in range(0, w, 100):
        for y in range(0, h, 100):
            labels += ["-annotate", f"+{x + 3}+{y + 13}", f"{x},{y}"]
    grid = subprocess.run(["convert", "png:-", "-stroke", "rgba(255,0,80,0.45)", "-strokewidth", "1", *draw,
                           "-stroke", "none", "-fill", "rgba(255,0,80,0.9)", "-pointsize", "11", *labels, "-quality", "78", "jpg:-"],
                          input=raw, capture_output=True, timeout=30).stdout
    return {"w": w, "h": h, "png": base64.b64encode(raw).decode(), "grid": base64.b64encode(grid).decode() if grid else None}

KEY_RE = re.compile(r"^[A-Za-z0-9_+\-]{1,40}$")
def xdo(*args):
    p = subprocess.run(["xdotool", *args], capture_output=True, env=x_env(), timeout=30)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.decode("utf-8", "replace")[:300] or "xdotool failed")

def act(a):
    kind = a.get("action")
    num = lambda k: str(max(0, min(int(a.get(k) or 0), 8000)))
    if kind in ("click", "double", "right", "move"):
        xdo("mousemove", "--sync", num("x"), num("y"))
        if kind == "click": xdo("click", "1")
        elif kind == "double": xdo("click", "--repeat", "2", "--delay", "90", "1")
        elif kind == "right": xdo("click", "3")
    elif kind == "drag":
        xdo("mousemove", "--sync", num("x"), num("y")); xdo("mousedown", "1")
        xdo("mousemove", "--sync", num("to_x"), num("to_y")); xdo("mouseup", "1")
    elif kind == "type":
        text = str(a.get("text") or "")[:4000]
        xdo("type", "--delay", "12", "--", text)
    elif kind == "key":
        keys = [k for k in str(a.get("keys") or "").split() if KEY_RE.match(k)][:12]
        if not keys: raise ValueError("no keys")
        xdo("key", "--delay", "40", *keys)
    elif kind == "scroll":
        n = max(1, min(int(a.get("amount") or 3), 25))
        button = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(a.get("direction"), "5")
        if a.get("x") is not None: xdo("mousemove", "--sync", num("x"), num("y"))
        xdo("click", "--repeat", str(n), "--delay", "30", button)
    else:
        raise ValueError("unknown action")
    return {"ok": True}

# ── The browser: Firefox driven over Marionette (built into Firefox) ─────────
# The operator works from the page itself, not from pixels: every button,
# link and field gets a number, and it clicks or types into that exact
# element. Firefox runs on the visible desktop, so the person watches it.
import socket, shutil, threading

MARIONETTE_PORT = 2828
_browser_lock = threading.Lock()
_mn = None  # the live Marionette connection

PAGE_JS = r"""
const MAX = arguments[0] || 120, W = innerWidth, H = innerHeight;
const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
document.querySelectorAll('[data-cloak-i]').forEach((e) => e.removeAttribute('data-cloak-i'));
const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=switch],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
const nameOf = (e) => {
  let t = e.getAttribute('aria-label') || '';
  if (!t && e.getAttribute('aria-labelledby')) t = e.getAttribute('aria-labelledby').split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
  if (!t && e.labels && e.labels.length) t = e.labels[0].innerText;
  if (!t) t = e.placeholder || '';
  if (!t && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) t = e.innerText || '';
  if (!t) { const img = e.querySelector && e.querySelector('img[alt],svg[aria-label]'); t = e.title || e.alt || (img && (img.alt || img.getAttribute('aria-label'))) || e.name || e.value || ''; }
  return clean(t).slice(0, 80);
};
const els = []; let n = 0;
for (const e of document.querySelectorAll(sel)) {
  if (n >= MAX) break;
  const r = e.getBoundingClientRect();
  if (r.width < 3 || r.height < 3 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) continue;
  const cs = getComputedStyle(e);
  if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.05) continue;
  const x = Math.min(W - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(H - 1, Math.max(0, r.top + r.height / 2));
  const top = document.elementFromPoint(x, y);
  if (top && top !== e && !e.contains(top) && !top.contains(e) && !(top.tagName === 'LABEL' && top.control === e)) continue;
  const i = n++;
  e.setAttribute('data-cloak-i', String(i));
  const role = e.getAttribute('role') || (e.tagName === 'A' ? 'link' : e.tagName.toLowerCase());
  const it = { i, role, name: nameOf(e) };
  if (e.tagName === 'INPUT') {
    it.type = e.type;
    if (e.type === 'checkbox' || e.type === 'radio') it.checked = e.checked;
    else it.value = e.type === 'password' ? (e.value ? '(filled)' : '') : clean(e.value).slice(0, 60);
  }
  if (e.tagName === 'TEXTAREA') it.value = clean(e.value).slice(0, 60);
  if (e.tagName === 'SELECT') { it.value = clean((e.options[e.selectedIndex] || {}).text); it.options = Array.from(e.options).slice(0, 15).map((o) => clean(o.text).slice(0, 30)); }
  if (e.disabled || e.getAttribute('aria-disabled') === 'true') it.disabled = true;
  if (e.getAttribute('aria-expanded')) it.expanded = e.getAttribute('aria-expanded') === 'true';
  if (e.tagName === 'A') { const h = e.getAttribute('href') || ''; if (h && !/^(javascript:|#$)/.test(h)) it.href = h.slice(0, 90); }
  els.push(it);
}
let vis = '', seen = 0;
if (document.body) {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = tw.nextNode()) && vis.length < 2600 && seen++ < 6000) {
    const t = node.nodeValue.trim(); if (!t) continue;
    const p = node.parentElement; if (!p || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) continue;
    const r = p.getBoundingClientRect(); if (r.bottom < 0 || r.top > H || r.width === 0) continue;
    vis += clean(t) + ' ';
  }
}
const alerts = Array.from(document.querySelectorAll('[role=alert],[aria-live=assertive],.error,[aria-invalid=true]')).map((e) => clean(e.innerText || e.getAttribute('aria-label'))).filter(Boolean).slice(0, 4);
return { url: location.href, title: document.title, els, text: clean(vis).slice(0, 2600), alerts,
  scroll: { y: Math.round(scrollY), h: document.documentElement.scrollHeight, vh: H } };
"""

class Marionette:
    def __init__(self):
        self.s = socket.create_connection(("127.0.0.1", MARIONETTE_PORT), timeout=10)
        self.s.settimeout(90)
        self.mid = 0
        self.buf = b""
        self._read()  # greeting
        self.cmd("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {
            "pageLoadStrategy": "eager", "unhandledPromptBehavior": "accept",
            "timeouts": {"pageLoad": 25000, "script": 20000, "implicit": 0}}}})
    def _read(self):
        while b":" not in self.buf:
            c = self.s.recv(65536)
            if not c: raise ConnectionError("browser connection closed")
            self.buf += c
        n, _, rest = self.buf.partition(b":")
        n = int(n)
        while len(rest) < n:
            c = self.s.recv(65536)
            if not c: raise ConnectionError("browser connection closed")
            rest += c
        self.buf = rest[n:]
        return json.loads(rest[:n])
    def cmd(self, name, params=None):
        self.mid += 1
        msg = json.dumps([0, self.mid, name, params or {}]).encode()
        self.s.sendall(str(len(msg)).encode() + b":" + msg)
        while True:
            r = self._read()
            if isinstance(r, list) and len(r) == 4 and r[0] == 1 and r[1] == self.mid: break
        if r[2]:
            err = r[2] if isinstance(r[2], dict) else {"message": str(r[2])}
            raise BrowserError(err.get("error", ""), err.get("message", "") or err.get("error", "browser error"))
        res = r[3]
        return res.get("value", res) if isinstance(res, dict) and "value" in res else res
    def js(self, script, *args):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": list(args)})
    def close(self):
        try: self.s.close()
        except Exception: pass

class BrowserError(Exception):
    def __init__(self, kind, message):
        super().__init__(message); self.kind = kind

def _profile():
    home = pwd.getpwnam(USER).pw_dir
    prof = os.path.join(home, ".cloak-browser")
    if not os.path.isdir(prof):
        os.makedirs(prof, exist_ok=True)
    prefs = {"marionette.port": MARIONETTE_PORT, "dom.webdriver.enabled": False,
             "browser.shell.checkDefaultBrowser": False, "browser.aboutwelcome.enabled": False,
             "browser.startup.homepage_override.mstone": "ignore", "startup.homepage_welcome_url": "",
             "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
             "toolkit.telemetry.reportingpolicy.firstRun": False, "browser.tabs.warnOnClose": False,
             "browser.sessionstore.resume_from_crash": False, "signon.rememberSignons": False,
             "browser.translations.automaticallyPopup": False, "browser.startup.page": 0,
             "browser.newtabpage.enabled": False, "browser.startup.homepage": "about:blank"}
    with open(os.path.join(prof, "user.js"), "w") as f:
        for k, v in prefs.items(): f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
    pw = pwd.getpwnam(USER)
    for root, dirs, files in os.walk(prof):
        for x in [root] + [os.path.join(root, d) for d in dirs] + [os.path.join(root, f) for f in files]:
            try: os.chown(x, pw.pw_uid, pw.pw_gid)
            except Exception: pass
    return prof

def _launch():
    binary = shutil.which("firefox-esr") or shutil.which("firefox")
    if not binary: raise RuntimeError("Firefox is not installed on this desktop")
    home = pwd.getpwnam(USER).pw_dir
    subprocess.run(["systemctl", "stop", "cloak-browser"], capture_output=True, timeout=20)
    subprocess.run(["systemctl", "reset-failed", "cloak-browser"], capture_output=True, timeout=10)
    # Its own unit: the browser outlives this agent restarting or updating.
    r = subprocess.run(["systemd-run", "--quiet", "--collect", "--unit=cloak-browser", f"--uid={USER}", f"--gid={USER}",
                        "-p", "KillMode=mixed", "-E", f"HOME={home}", "-E", "DISPLAY=:0", "-E", f"XAUTHORITY={home}/.Xauthority",
                        "-E", "LANG=C.UTF-8", binary, "--marionette", "-no-remote", "-profile", _profile()], capture_output=True, timeout=20)
    if r.returncode != 0: raise RuntimeError("could not start Firefox: " + r.stderr.decode("utf-8", "replace")[:200])
    for _ in range(60):
        time.sleep(0.5)
        try:
            socket.create_connection(("127.0.0.1", MARIONETTE_PORT), timeout=1).close(); return
        except OSError: pass
    raise RuntimeError("Firefox started but did not answer")

def _mn_get(launch=True):
    global _mn
    if _mn is not None:
        try:
            _mn.cmd("WebDriver:GetCurrentURL"); return _mn
        except Exception:
            _mn.close(); _mn = None
    try:
        _mn = Marionette()
    except OSError:
        if not launch: return None
        _launch(); _mn = Marionette()
        try: _mn.cmd("WebDriver:MaximizeWindow")
        except Exception: pass
    return _mn

def _follow_windows(m):
    # A link that opened a new tab or window: carry on there.
    try:
        hs = m.cmd("WebDriver:GetWindowHandles")
        cur = m.cmd("WebDriver:GetWindowHandle")
        if isinstance(hs, list) and hs and hs[-1] != cur:
            m.cmd("WebDriver:SwitchToWindow", {"handle": hs[-1], "focus": True})
    except Exception: pass

def _el(m, i):
    try:
        return m.cmd("WebDriver:FindElement", {"using": "css selector", "value": f'[data-cloak-i="{int(i)}"]'})
    except BrowserError:
        raise RuntimeError(f"there is no element [{i}] on the page now (the page changed); use the newest list")

def _page(m):
    for _ in range(3):
        try:
            return m.js(PAGE_JS, 120)
        except BrowserError as e:
            if "no such window" in str(e) or "NoSuchWindow" in e.kind:
                hs = m.cmd("WebDriver:GetWindowHandles")
                if hs: m.cmd("WebDriver:SwitchToWindow", {"handle": hs[-1], "focus": True}); continue
            time.sleep(0.6)
    return {"url": "", "title": "", "els": [], "text": "", "alerts": [], "scroll": {}}

def browser(a):
    op = str(a.get("op") or "state")
    with _browser_lock:
        if op == "peek":
            m = _mn_get(launch=False)
            return {"open": bool(m), "page": _page(m) if m else None}
        if op == "windows":
            p = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", ".+", "getwindowname", "%@"], capture_output=True, env=x_env(), timeout=10)
            names = [x for x in p.stdout.decode("utf-8", "replace").splitlines() if x.strip() and x.strip() not in ("xfce4-panel", "Desktop", "xfdesktop")]
            return {"windows": list(dict.fromkeys(names))[:20]}
        m = _mn_get()
        note = ""
        if op == "goto":
            url = str(a.get("url") or "").strip()
            if not re.match(r"^[a-z][a-z0-9+.-]*:", url, re.I): url = "https://" + url
            try: m.cmd("WebDriver:Navigate", {"url": url})
            except BrowserError as e:
                if "timeout" not in e.kind.lower(): raise RuntimeError(str(e)[:200])
                note = "the page is still loading"
        elif op == "click":
            el = _el(m, a.get("i"))
            try: m.cmd("WebDriver:ElementClick", {"id": list(el.values())[0]})
            except BrowserError as e:
                if "timeout" in e.kind.lower(): note = "the next page is still loading"
                else: m.js("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
            time.sleep(0.5); _follow_windows(m)
        elif op == "type":
            el = _el(m, a.get("i")); eid = list(el.values())[0]
            text = str(a.get("text") or "")[:4000]
            try: m.cmd("WebDriver:ElementClear", {"id": eid})
            except BrowserError: pass
            try: m.cmd("WebDriver:ElementSendKeys", {"id": eid, "text": text + ("\ue007" if a.get("enter") else "")})
            except BrowserError:
                m.js("const e=arguments[0]; e.focus(); if ('value' in e) { e.value=arguments[1]; } else { e.textContent=arguments[1]; } e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true}));", el, text)
                if a.get("enter"): m.js("arguments[0].form ? arguments[0].form.requestSubmit() : null", el)
            if a.get("enter"): time.sleep(0.8); _follow_windows(m)
        elif op == "select":
            el = _el(m, a.get("i"))
            ok = m.js("const s=arguments[0], w=String(arguments[1]).toLowerCase(); const o=Array.from(s.options||[]).find(o=>o.text.trim().toLowerCase()===w)||Array.from(s.options||[]).find(o=>o.text.toLowerCase().includes(w)||o.value.toLowerCase()===w); if(!o) return false; s.value=o.value; s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true;", el, str(a.get("option") or ""))
            if not ok: raise RuntimeError("no option like that in the list")
        elif op == "scroll":
            m.js("window.scrollBy(0, (arguments[0]==='up'?-1:1)*innerHeight*0.8)", str(a.get("dir") or "down"))
            time.sleep(0.3)
        elif op in ("back", "forward", "reload"):
            try: m.cmd({"back": "WebDriver:Back", "forward": "WebDriver:Forward", "reload": "WebDriver:Refresh"}[op])
            except BrowserError as e:
                if "timeout" not in e.kind.lower(): raise RuntimeError(str(e)[:200])
        elif op == "read":
            page = _page(m)
            page["text"] = m.js("return (document.body ? document.body.innerText : '').replace(/[ \\t]+/g,' ').replace(/\\n{3,}/g,'\\n\\n').slice(0, 20000)")
            return {"open": True, "page": page}
        elif op != "state":
            raise ValueError("unknown browser op")
        page = _page(m)
        if note: page["note"] = note
        return {"open": True, "page": page}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def ok(self):
        if self.client_address[0] != BRAIN or self.headers.get("X-Agent-Token") != TOKEN:
            self.send(401, {"error": "unauthorized"}); return False
        return True
    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(min(n, 1_000_000)) or b"{}") if n else {}
    def do_GET(self):
        if not self.ok(): return
        if self.path == "/health":
            mem = os.popen("free -m | awk '/Mem:/{print $3\"/\"$2}'").read().strip()
            return self.send(200, {"ok": True, "kind": KIND, "mem": mem, "load": os.getloadavg()[0], "version": VERSION})
        self.send(404, {"error": "not found"})
    def do_POST(self):
        if not self.ok(): return
        try:
            a = self.body()
            if self.path == "/run": return self.send(200, run(str(a.get("cmd") or ""), a.get("timeout")))
            if self.path == "/update":
                # The brain sends a newer copy of this file; systemd restarts us on it.
                code = base64.b64decode(a.get("code") or "")
                compile(code, "agent.py", "exec")
                with open(__file__ + ".new", "wb") as f: f.write(code)
                os.replace(__file__ + ".new", __file__)
                self.send(200, {"ok": True}); sys.stdout.flush(); os._exit(0)
            if KIND != "desktop": return self.send(400, {"error": "this machine has no screen"})
            if self.path == "/screen": return self.send(200, screen(a.get("grid", True) is not False))
            if self.path == "/input": return self.send(200, act(a))
            if self.path == "/browser": return self.send(200, browser(a))
            self.send(404, {"error": "not found"})
        except Exception as e:
            self.send(500, {"error": str(e)[:400]})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
