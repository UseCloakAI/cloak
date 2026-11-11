#!/usr/bin/env bash
# Cloak Computer: two small virtual machines on the brain PC, for the agent.
#
#   cloak-computer  Debian 13 + a minimal XFCE desktop, 6 GB RAM, 4 vCPUs.
#                   The agent sees the screen, clicks, types, runs commands.
#   cloak-server    Debian 13 (cloud kernel), no desktop, 1.5 GB RAM, 2 vCPUs.
#                   Packages, scripts, small servers.
#
# Both live on their own private network (10.77.0.0/24): they reach the
# internet, but never your home network, the router or this PC. They are
# off until someone needs them; the brain wakes them and puts them back to
# sleep after a while. Safe to run again: it only creates what is missing.
#
# Run by the installer with --with-computer, or on its own as root.
set -euo pipefail

DATA=/var/lib/cloak-brain
VMDIR=$DATA/vm
CONF=/etc/cloak-brain
APP=/opt/cloak-brain/app
NET=cloak-vm
IMG_BASE=https://cloud.debian.org/images/cloud/trixie/latest
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root."
grep -Eq 'vmx|svm' /proc/cpuinfo || fail "This processor has no virtualization support turned on. Turn on Intel VT-x in the BIOS (HP: F10 > Advanced > System Options > Virtualization Technology), then run this again."

say "Computer 1/5  Virtualization packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst cloud-image-utils nftables openssl >/dev/null
systemctl enable --now libvirtd >/dev/null 2>&1 || true
[ -e /dev/kvm ] || fail "KVM is not available (/dev/kvm is missing). Turn on VT-x in the BIOS."
mkdir -p "$VMDIR"

say "Computer 2/5  A private network the VMs cannot leave except to the internet"
if ! virsh -q net-info "$NET" >/dev/null 2>&1; then
  cat > "$VMDIR/net.xml" <<XML
<network>
  <name>$NET</name>
  <forward mode='nat'/>
  <bridge name='cloakvm0' stp='on' delay='0'/>
  <ip address='10.77.0.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='10.77.0.100' end='10.77.0.200'/>
      <host mac='52:54:00:77:00:10' ip='10.77.0.10'/>
      <host mac='52:54:00:77:00:11' ip='10.77.0.11'/>
    </dhcp>
  </ip>
</network>
XML
  virsh -q net-define "$VMDIR/net.xml"
fi
virsh -q net-autostart "$NET" >/dev/null
virsh -q net-start "$NET" >/dev/null 2>&1 || true

# Firewall: the VMs may use DNS/DHCP from this PC and reach the internet.
# Nothing else on this PC, and nothing on any private network (your LAN,
# the router), is reachable from them.
cat > "$CONF/vm-firewall.nft" <<'NFT'
table inet cloak_vm
delete table inet cloak_vm
table inet cloak_vm {
  chain fwd {
    type filter hook forward priority -10; policy accept;
    iifname "cloakvm0" ip daddr 10.77.0.0/24 accept
    iifname "cloakvm0" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } drop
    iifname "cloakvm0" ip6 daddr { fc00::/7, fe80::/10 } drop
  }
  chain in {
    type filter hook input priority -10; policy accept;
    iifname "cloakvm0" ct state established,related accept
    iifname "cloakvm0" udp dport { 53, 67 } accept
    iifname "cloakvm0" tcp dport 53 accept
    iifname "cloakvm0" drop
  }
}
NFT
cat > /etc/systemd/system/cloak-vm-firewall.service <<UNIT
[Unit]
Description=Cloak Computer firewall (keeps the VMs off your home network)
After=libvirtd.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f $CONF/vm-firewall.nft

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cloak-vm-firewall >/dev/null
systemctl restart cloak-vm-firewall

say "Computer 3/5  Debian 13 images"
for img in debian-13-generic-amd64.qcow2 debian-13-genericcloud-amd64.qcow2; do
  if [ ! -f "$VMDIR/$img" ]; then
    curl -fsSL "$IMG_BASE/$img" -o "$VMDIR/$img.part" || fail "Could not download $img."
    mv -f "$VMDIR/$img.part" "$VMDIR/$img"
  fi
done

# Settings the brain reads: where each VM is and its agent token.
JSON="$CONF/computer.json"
if [ ! -f "$JSON" ]; then
  printf '{"desktop":{"name":"cloak-computer","ip":"10.77.0.10","token":"%s"},"server":{"name":"cloak-server","ip":"10.77.0.11","token":"%s"},"access":"admins"}\n' \
    "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$JSON"
fi
chown cloakbrain:cloakbrain "$JSON" 2>/dev/null || true
chmod 600 "$JSON"
tok() { python3 -c "import json,sys;print(json.load(open('$JSON'))['$1']['token'])"; }

seed() { # $1 kind  $2 hostname  $3 token  $4 out.iso
  local kind=$1 host=$2 token=$3 out=$4 agent apt pkgs extra
  agent=$(base64 -w0 "$APP/brain/vm/agent.py")
  apt=$(base64 -w0 <<'SH'
#!/bin/sh
# Installs packages from the configured Debian repositories, by name only.
[ "$#" -ge 1 ] || { echo "usage: sudo cloak-apt install NAME..."; exit 2; }
[ "$1" = install ] && shift
for p in "$@"; do echo "$p" | grep -Eq '^[a-z0-9][a-z0-9+.-]{0,60}$' || { echo "not a package name: $p"; exit 2; }; done
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
exec apt-get install -y --no-install-recommends -- "$@"
SH
)
  if [ "$kind" = desktop ]; then
    pkgs="[xfce4, xfce4-terminal, lightdm, xserver-xorg-core, xserver-xorg-video-qxl, x11-xserver-utils, dbus-x11, xdotool, imagemagick, firefox-esr, fonts-dejavu, python3, python3-pip, python3-venv, nodejs, npm, git, curl, unzip, build-essential, sudo]"
    extra="
  - path: /etc/lightdm/lightdm.conf.d/50-cloak.conf
    content: |
      [Seat:*]
      autologin-user=cloak
      autologin-session=xfce
  - path: /etc/xdg/autostart/cloak-screen.desktop
    content: |
      [Desktop Entry]
      Type=Application
      Name=Cloak screen
      Exec=sh -c 'xrandr -s 1280x800 || true; xset s off -dpms; xhost +SI:localuser:root'
"
  else
    pkgs="[python3, python3-pip, python3-venv, nodejs, npm, git, curl, unzip, build-essential, sudo, sqlite3]"
    extra=""
  fi
  cat > "$VMDIR/$host-user-data" <<YAML
#cloud-config
hostname: $host
users:
  - name: cloak
    shell: /bin/bash
    lock_passwd: true
groups: [cloakusers]
package_update: true
package_upgrade: false
packages: $pkgs
write_files:
  - path: /opt/cloak/agent.py
    encoding: b64
    permissions: '0755'
    content: $agent
  - path: /etc/cloak/agent.json
    permissions: '0600'
    content: '{"token": "$token", "kind": "$kind", "desktop_user": "cloak", "port": 8765}'
  - path: /usr/local/bin/cloak-apt
    encoding: b64
    permissions: '0755'
    content: $apt
  - path: /etc/sudoers.d/cloak-apt
    permissions: '0440'
    content: '%cloakusers ALL=(root) NOPASSWD: /usr/local/bin/cloak-apt'
  - path: /etc/systemd/system/cloak-agent.service
    content: |
      [Unit]
      Description=Cloak Computer agent
      After=network-online.target
      [Service]
      ExecStart=/usr/bin/python3 /opt/cloak/agent.py
      Restart=always
      [Install]
      WantedBy=multi-user.target
$extra
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, enable, --now, cloak-agent]
  - [sh, -c, '[ "$kind" = desktop ] && systemctl set-default graphical.target && systemctl restart lightdm || true']
  - [sh, -c, 'touch /var/lib/cloak-ready']
YAML
  printf 'instance-id: %s\nlocal-hostname: %s\n' "$host" "$host" > "$VMDIR/$host-meta-data"
  cloud-localds "$out" "$VMDIR/$host-user-data" "$VMDIR/$host-meta-data"
}

CREATED=0
make_vm() { # $1 kind  $2 name  $3 base image  $4 disk GB  $5 MB  $6 vcpus  $7 mac
  local kind=$1 name=$2 base=$3 gb=$4 mb=$5 cpus=$6 mac=$7
  if virsh -q dominfo "$name" >/dev/null 2>&1; then echo "$name already exists."; return; fi
  qemu-img create -q -f qcow2 -F qcow2 -b "$VMDIR/$base" "$VMDIR/$name.qcow2" "${gb}G"
  seed "$kind" "$name" "$(tok "$kind")" "$VMDIR/$name-seed.iso"
  local gfx=(--graphics none)
  [ "$kind" = desktop ] && gfx=(--graphics vnc,listen=127.0.0.1 --video qxl)
  virt-install -q --name "$name" --memory "$mb" --vcpus "$cpus" --cpu host-passthrough \
    --osinfo detect=on,require=off --import --noautoconsole --autostart=no \
    --disk "path=$VMDIR/$name.qcow2,bus=virtio" --disk "path=$VMDIR/$name-seed.iso,device=cdrom" \
    --network "network=$NET,mac=$mac,model=virtio" "${gfx[@]}"
  virsh -q autostart --disable "$name" >/dev/null 2>&1 || true
  CREATED=1
}

say "Computer 4/5  Creating the VMs (first boot installs their software; on this hard drive that can take 20 to 40 minutes)"
make_vm desktop cloak-computer debian-13-generic-amd64.qcow2 40 6144 4 52:54:00:77:00:10
make_vm server  cloak-server   debian-13-genericcloud-amd64.qcow2 20 1536 2 52:54:00:77:00:11

wait_ready() { # $1 ip  $2 token  $3 name
  for _ in $(seq 1 300); do
    if curl -fsS -m 5 -H "X-Agent-Token: $2" "http://$1:8765/health" >/dev/null 2>&1; then echo "$3 is ready."; return 0; fi
    sleep 10
  done
  echo "$3 did not finish setting up in time. It keeps going in the background; the brain will try again when it is needed."
}
if [ "$CREATED" = 1 ]; then
  wait_ready 10.77.0.11 "$(tok server)" cloak-server
  wait_ready 10.77.0.10 "$(tok desktop)" cloak-computer
  # Let the desktop finish logging in once, then put both to sleep until needed.
  sleep 20
  for n in cloak-computer cloak-server; do virsh -q shutdown "$n" >/dev/null 2>&1 || true; done
fi

say "Computer 5/5  Letting the brain manage them"
usermod -aG libvirt cloakbrain 2>/dev/null || true
mkdir -p /etc/systemd/system/cloak-brain.service.d
DROP=/etc/systemd/system/cloak-brain.service.d/computer.conf
if [ ! -f "$DROP" ]; then
  printf '[Service]\nSupplementaryGroups=libvirt\nEnvironment=LIBVIRT_DEFAULT_URI=qemu:///system\n' > "$DROP"
  systemctl daemon-reload
  systemctl restart cloak-brain
fi
echo "Cloak Computer is set up. Both VMs are asleep until someone needs them."
