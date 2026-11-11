#!/usr/bin/env bash
# Cloak Brain installer for Debian/Ubuntu servers. One command does it all:
#
#   curl -fsSL https://usecloak.org/brain/install.sh | sudo bash -s -- K7QX-2M9D-WP4F
#
# The code is a one-time pairing code (made by an admin, good for an hour).
# A full base64 settings blob works too.
#
# Installs Node 22, the brain (from usecloak.org), Cloudflare's tunnel client,
# and two always-on services that start at boot and restart if they stop:
#   cloak-brain   the brain itself (agent, memory, tasks, files, /admin)
#   cloudflared   the tunnel that lets Cloudflare (and only Cloudflare) reach it
#
# Run it again without a code to update the brain and keep everything else.
# Uninstall: ... | sudo bash -s -- --uninstall   (your data stays in /var/lib/cloak-brain)
set -euo pipefail

SRC="${CLOAK_BRAIN_SRC:-https://usecloak.org}"
API="${CLOAK_BRAIN_API:-https://blinks-api.usecloak.org}"
APP=/opt/cloak-brain
DATA=/var/lib/cloak-brain
CONF=/etc/cloak-brain
USER_NAME=cloakbrain
NODE_MAJOR=22

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this with sudo (or as root)."
command -v apt-get >/dev/null || fail "This installer is for Debian or Ubuntu."

if [ "${1:-}" = "--uninstall" ]; then
  say "Removing Cloak Brain (your data in $DATA is kept)"
  systemctl disable --now cloak-brain 2>/dev/null || true
  rm -f /etc/systemd/system/cloak-brain.service
  cloudflared service uninstall 2>/dev/null || true
  systemctl daemon-reload
  rm -rf "$APP"
  say "Done. Delete $DATA and $CONF yourself if you want everything gone."
  exit 0
fi

CODE="${1:-}"
if [ -z "$CODE" ] && [ ! -f "$CONF/config.json" ]; then
  fail "Add your pairing code: curl -fsSL $SRC/brain/install.sh | sudo bash -s -- YOUR_CODE"
fi

case "$(uname -m)" in
  x86_64|amd64) NARCH=x64;   CARCH=amd64 ;;
  aarch64|arm64) NARCH=arm64; CARCH=arm64 ;;
  *) fail "This processor ($(uname -m)) is not supported yet." ;;
esac

say "1/6  Basics"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates xz-utils >/dev/null

say "2/6  Node.js $NODE_MAJOR"
if [ -x "$APP/node/bin/node" ] && "$APP/node/bin/node" -e "process.exit(+process.versions.node.split('.')[0] >= $NODE_MAJOR && +process.versions.node.split('.')[1] >= 13 ? 0 : 1)" 2>/dev/null; then
  echo "Already installed: $("$APP/node/bin/node" -v)"
else
  BASE="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")"
  FILE="$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-${NARCH}\.tar\.xz$" | head -1)"
  [ -n "$FILE" ] || fail "Could not find Node.js for this machine."
  TMP="$(mktemp -d)"
  curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && printf '%s\n' "$SUMS" | grep " $FILE\$" | sha256sum -c - >/dev/null) || fail "Node.js download did not match its checksum."
  rm -rf "$APP/node" && mkdir -p "$APP/node"
  tar -xJf "$TMP/$FILE" -C "$APP/node" --strip-components=1
  rm -rf "$TMP"
  echo "Installed $("$APP/node/bin/node" -v)"
fi

say "3/6  The brain"
FILES="brain/server.js brain/sqlite.js brain/package.json brain/admin/index.html
blinks-api/src/agent.js blinks-api/src/carbon.js blinks-api/src/engine.js blinks-api/src/mind-core.js
blinks-api/src/models.js blinks-api/src/prompts.js blinks-api/src/safety.js blinks-api/src/tools.js
api-worker/src/governor.js"
STAGE="$(mktemp -d)"
for f in $FILES; do
  mkdir -p "$STAGE/$(dirname "$f")"
  curl -fsSL "$SRC/$f" -o "$STAGE/$f" || fail "Could not download $f from $SRC."
done
echo '{"type":"module"}' > "$STAGE/package.json"
rm -rf "$APP/app" && mv "$STAGE" "$APP/app"
chmod -R a+rX "$APP"

say "4/6  Account, folders and settings"
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DATA" "$CONF"
chown -R "$USER_NAME:$USER_NAME" "$DATA" "$CONF"
chmod 700 "$DATA" "$CONF"
TUNNEL=""
if [ -n "$CODE" ]; then
  CODE="$(printf '%s' "$CODE" | tr '[:lower:]' '[:upper:]' | tr -d ' ')"
  if printf '%s' "$CODE" | grep -Eq '^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$'; then
    JSON="$(curl -fsS "$API/v1/pair/$CODE")" || fail "That pairing code is wrong, used or expired. Ask for a new one."
  else
    JSON="$(printf '%s' "$CODE" | base64 -d 2>/dev/null)" || fail "That pairing code is not valid. Copy it again, all of it."
  fi
  TUNNEL="$("$APP/node/bin/node" -e '
    const c = JSON.parse(process.argv[1]);
    const fs = require("fs");
    const file = process.argv[2];
    let old = {};
    try { old = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const conf = { ...old, brainToken: c.brainToken, api: c.api || old.api, admins: c.admins || old.admins || [], supabaseUrl: c.supabaseUrl || old.supabaseUrl, supabaseAnonKey: c.supabaseAnonKey || old.supabaseAnonKey, dataDir: "/var/lib/cloak-brain", port: 7777 };
    if (!conf.brainToken || !c.tunnelToken) { console.error("missing fields"); process.exit(1); }
    fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
    process.stdout.write(c.tunnelToken);
  ' "$JSON" "$CONF/config.json")" || fail "That pairing code is missing something. Ask for a new one."
  chown "$USER_NAME:$USER_NAME" "$CONF/config.json"
fi

say "5/6  The brain service"
cat > /etc/systemd/system/cloak-brain.service <<UNIT
[Unit]
Description=Cloak Brain (Cloak Blinks home server)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP/app/brain
Environment=NODE_ENV=production
Environment=CLOAK_BRAIN_CONFIG=$CONF/config.json
ExecStart=$APP/node/bin/node --disable-warning=ExperimentalWarning $APP/app/brain/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA $CONF

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable cloak-brain >/dev/null 2>&1
systemctl restart cloak-brain

say "6/6  Cloudflare tunnel"
if ! command -v cloudflared >/dev/null; then
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CARCH}.deb" -o "$TMP/cloudflared.deb"
  dpkg -i "$TMP/cloudflared.deb" >/dev/null
  rm -rf "$TMP"
fi
if [ -n "$TUNNEL" ]; then
  cloudflared service uninstall >/dev/null 2>&1 || true
  cloudflared service install "$TUNNEL" >/dev/null 2>&1
fi
systemctl enable cloudflared >/dev/null 2>&1 || true
systemctl restart cloudflared || true

# Never sleep: this is a server now.
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true

sleep 3
B="$(systemctl is-active cloak-brain || true)"
C="$(systemctl is-active cloudflared || true)"
say "All set."
echo "  Brain:  $B"
echo "  Tunnel: $C"
echo
echo "  Manage it from any browser: https://brain.usecloak.org/admin"
echo "  Sign in with your Cloak account."
echo
echo "  Cloudflare checks on it every minute. Within a minute or two, Blinks"
echo "  switches from Low Light to fully awake."
[ "$B" = active ] || echo "  The brain did not start. See why: journalctl -u cloak-brain -n 50"
[ "$C" = active ] || echo "  The tunnel did not start. See why: journalctl -u cloudflared -n 50"
