#!/usr/bin/env python3
"""Cloak Computer agent: runs inside each Cloak VM (as root) and does what
the brain asks, on the VM's private network only (10.77.0.0/24).

    GET  /health                       {ok, kind, mem, load}
    POST /run      {user, cmd, timeout} run a shell command as that person's own
                                       Linux account, with memory/CPU/time limits
    POST /screen                       PNG of the desktop with a labelled 100px grid,
                                       plus a clean copy (desktop VM only)
    POST /input    {action, ...}       click / double / right / move / drag / type /
                                       key / scroll on the desktop (desktop VM only)

Every request needs the X-Agent-Token written at provisioning. Commands
never run as root: each person gets an unprivileged account (cl-<id>) in the
group cloakusers. The only root path is /usr/local/bin/cloak-apt, which
installs packages from the configured Debian repositories by name.
No dependencies beyond Python 3, xdotool and ImageMagick."""

import base64, hashlib, json, os, re, subprocess, pwd, grp, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONF = json.load(open("/etc/cloak/agent.json"))
TOKEN = CONF["token"]
KIND = CONF.get("kind", "server")          # "desktop" or "server"
DESK_USER = CONF.get("desktop_user", "cloak")
PORT = int(CONF.get("port", 8765))
OUT_MAX = 64 * 1024
USER_RE = re.compile(r"^cl-[a-z0-9]{6,24}$")
VERSION = hashlib.sha256(open(__file__, "rb").read()).hexdigest()[:16]

def x_env():
    home = pwd.getpwnam(DESK_USER).pw_dir
    return {"DISPLAY": ":0", "XAUTHORITY": os.path.join(home, ".Xauthority"), "PATH": "/usr/local/bin:/usr/bin:/bin"}

def ensure_user(name):
    if not USER_RE.match(name or ""):
        raise ValueError("bad user")
    try:
        pwd.getpwnam(name)
        return
    except KeyError:
        pass
    try:
        grp.getgrnam("cloakusers")
    except KeyError:
        subprocess.run(["groupadd", "cloakusers"], check=True)
    subprocess.run(["useradd", "-m", "-s", "/bin/bash", "-G", "cloakusers", name], check=True)
    subprocess.run(["chmod", "700", f"/home/{name}"], check=True)
    if KIND == "desktop":
        # Let this person's commands open windows on the shared desktop.
        subprocess.run(["runuser", "-u", DESK_USER, "--", "xhost", f"+SI:localuser:{name}"], env=x_env(), capture_output=True)

def run(user, cmd, timeout):
    ensure_user(user)
    timeout = max(1, min(int(timeout or 60), 600))
    env = ["-E", f"HOME=/home/{user}", "-E", f"USER={user}", "-E", "LANG=C.UTF-8", "-E", "TERM=dumb"]
    if KIND == "desktop":
        env += ["-E", "DISPLAY=:0"]
    argv = ["systemd-run", "--quiet", "--wait", "--pipe", "--collect", f"--uid={user}", f"--gid={user}",
            f"--working-directory=/home/{user}",
            "-p", "MemoryMax=2500M", "-p", "CPUQuota=200%", "-p", "TasksMax=512", "-p", f"RuntimeMaxSec={timeout}",
            *env, "/bin/bash", "-lc", cmd]
    t0 = time.time()
    try:
        p = subprocess.run(argv, capture_output=True, timeout=timeout + 15, stdin=subprocess.DEVNULL)
        out, err, code = p.stdout, p.stderr, p.returncode
    except subprocess.TimeoutExpired as e:
        out, err, code = e.stdout or b"", (e.stderr or b"") + b"\n[stopped: took longer than the time limit]", 124
    cut = lambda b: b[-OUT_MAX:].decode("utf-8", "replace")
    return {"code": code, "stdout": cut(out), "stderr": cut(err), "seconds": round(time.time() - t0, 1),
            "truncated": len(out) > OUT_MAX or len(err) > OUT_MAX}

def screen():
    env = x_env()
    raw = subprocess.run(["import", "-display", ":0", "-window", "root", "png:-"], capture_output=True, env=env, timeout=20).stdout
    if not raw:
        raise RuntimeError("could not capture the screen (is the desktop up?)")
    size = subprocess.run(["identify", "-format", "%w %h", "png:-"], input=raw, capture_output=True, timeout=10).stdout.decode().split()
    w, h = (int(size[0]), int(size[1])) if len(size) == 2 else (1280, 800)
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

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def ok(self):
        if self.headers.get("X-Agent-Token") != TOKEN:
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
            if self.path == "/run": return self.send(200, run(a.get("user"), str(a.get("cmd") or ""), a.get("timeout")))
            if self.path == "/update":
                # The brain sends a newer copy of this file; systemd restarts us on it.
                code = base64.b64decode(a.get("code") or "")
                compile(code, "agent.py", "exec")
                with open(__file__ + ".new", "wb") as f: f.write(code)
                os.replace(__file__ + ".new", __file__)
                self.send(200, {"ok": True}); sys.stdout.flush(); os._exit(0)
            if KIND != "desktop": return self.send(400, {"error": "this machine has no screen"})
            if self.path == "/screen": return self.send(200, screen())
            if self.path == "/input": return self.send(200, act(a))
            self.send(404, {"error": "not found"})
        except Exception as e:
            self.send(500, {"error": str(e)[:400]})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
