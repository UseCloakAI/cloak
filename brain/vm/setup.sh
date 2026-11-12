#!/usr/bin/env bash
# Cloak Computer: every person gets their own virtual machines on this PC.
#
# This script builds two sealed "golden" images once:
#   desktop  Debian 13 + a minimal XFCE desktop (1280x800), Firefox, a terminal
#   server   Debian 13 (cloud kernel), no desktop: packages, scripts, servers
# The brain (brain/computer.js) then gives each person their own small disk
# on top of these (/var/lib/cloak-vm/users/<id>/), with its own key, and
# boots it into a slot when they need it:
#   1 desktop slot (6 GB RAM, 4 vCPUs) and 2 server slots (1.5 GB, 2 vCPUs).
#
# Sealed: every VM sits on an isolated port of a private network
# (10.77.0.0/24). It can reach the internet, but not other VMs, not this PC
# (except DNS/DHCP), not your home network or router. Its agent answers only
# the brain, with that VM's own key.
#
# Safe to run again: only builds what is missing. Run by the installer with
# --with-computer (and on every update after).
set -euo pipefail

CONF=/etc/cloak-brain
APP=/opt/cloak-brain/app
VMROOT=/var/lib/cloak-vm
NET=cloak-vm
IMG_BASE=https://cloud.debian.org/images/cloud/trixie/latest
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this as root."
grep -Eq 'vmx|svm' /proc/cpuinfo || fail "This processor has no virtualization turned on. Turn on Intel VT-x in the BIOS (HP: F10 > Advanced > System Options > Virtualization Technology), then run this again."

say "Computer 1/6  Virtualization packages"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq qemu-system-x86 qemu-utils libvirt-daemon-system libvirt-clients virtinst cloud-image-utils nftables openssl >/dev/null
systemctl enable --now libvirtd >/dev/null 2>&1 || true
[ -e /dev/kvm ] || fail "KVM is not available (/dev/kvm is missing). Turn on VT-x in the BIOS."
id cloakbrain >/dev/null 2>&1 || fail "Install Cloak Brain first."
usermod -aG libvirt,kvm cloakbrain

# Storage: golden images (read-only) and one folder per person. Only the brain
# and libvirt can get in; libvirt's own user just needs to pass through.
mkdir -p "$VMROOT/base" "$VMROOT/users" "$VMROOT/build"
chown root:root "$VMROOT" "$VMROOT/base" "$VMROOT/build"; chmod 0711 "$VMROOT" "$VMROOT/base"; chmod 0700 "$VMROOT/build"
chown cloakbrain:libvirt "$VMROOT/users"; chmod 0711 "$VMROOT/users"

say "Computer 2/6  Removing the old shared VMs (from the first version)"
for old in cloak-computer cloak-server; do
  if virsh -q dominfo "$old" >/dev/null 2>&1; then
    virsh -q destroy "$old" >/dev/null 2>&1 || true
    virsh -q undefine "$old" --remove-all-storage >/dev/null 2>&1 || virsh -q undefine "$old" >/dev/null 2>&1 || true
    echo "Removed $old."
  fi
done
rm -f /var/lib/cloak-brain/vm/cloak-*.qcow2 /var/lib/cloak-brain/vm/cloak-*-seed.iso 2>/dev/null || true

say "Computer 3/6  A private network, sealed off"
if ! virsh -q net-info "$NET" >/dev/null 2>&1; then
  cat > "$VMROOT/build/net.xml" <<XML
<network>
  <name>$NET</name>
  <forward mode='nat'/>
  <bridge name='cloakvm0' stp='on' delay='0'/>
  <port isolated='yes'/>
  <ip address='10.77.0.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='10.77.0.100' end='10.77.0.200'/>
      <host mac='52:54:00:77:00:10' ip='10.77.0.10'/>
      <host mac='52:54:00:77:00:20' ip='10.77.0.20'/>
      <host mac='52:54:00:77:00:21' ip='10.77.0.21'/>
      <host mac='52:54:00:77:00:30' ip='10.77.0.30'/>
      <host mac='52:54:00:77:00:31' ip='10.77.0.31'/>
    </dhcp>
  </ip>
</network>
XML
  virsh -q net-define "$VMROOT/build/net.xml"
else
  # The first version's network: add the slot addresses it lacks.
  for pair in "20 10.77.0.20" "21 10.77.0.21" "30 10.77.0.30" "31 10.77.0.31"; do
    set -- $pair
    virsh -q net-update "$NET" add ip-dhcp-host "<host mac='52:54:00:77:00:$1' ip='$2'/>" --config --live >/dev/null 2>&1 || true
  done
fi
virsh -q net-autostart "$NET" >/dev/null
virsh -q net-start "$NET" >/dev/null 2>&1 || true

cat > "$CONF/vm-firewall.nft" <<'NFT'
table inet cloak_vm
delete table inet cloak_vm
table inet cloak_vm {
  chain fwd {
    type filter hook forward priority -10; policy accept;
    # Never another VM, never your home network, the router or this PC.
    iifname "cloakvm0" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8, 224.0.0.0/4 } drop
    iifname "cloakvm0" ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } drop
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
systemctl enable cloak-vm-firewall >/dev/null
systemctl restart cloak-vm-firewall

say "Computer 4/6  Debian 13 images"
for img in debian-13-generic-amd64.qcow2 debian-13-genericcloud-amd64.qcow2; do
  if [ ! -f "$VMROOT/build/$img" ] && [ ! -f "$VMROOT/base/desktop.qcow2" -o ! -f "$VMROOT/base/server.qcow2" ]; then
    curl -fsSL "$IMG_BASE/$img" -o "$VMROOT/build/$img.part" || fail "Could not download $img."
    mv -f "$VMROOT/build/$img.part" "$VMROOT/build/$img"
  fi
done

# Golden image build: the full software install runs once, then the image is
# cleaned (cloud-init, machine id, keys) and sealed read-only.
build_seed() { # $1 kind  $2 out.iso
  local kind=$1 out=$2 agent pkgs extra
  agent=$(base64 -w0 "$APP/brain/vm/agent.py")
  if [ "$kind" = desktop ]; then
    pkgs="[xfce4, xfce4-terminal, lightdm, xserver-xorg-core, xserver-xorg-video-qxl, x11-xserver-utils, dbus-x11, xdotool, imagemagick, firefox-esr, fonts-dejavu, python3, python3-pip, python3-venv, nodejs, npm, git, curl, unzip, build-essential, sudo, unattended-upgrades, qemu-guest-agent]"
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
      Exec=sh -c 'xrandr -s 1280x800 || true; xset s off -dpms'
"
  else
    pkgs="[python3, python3-pip, python3-venv, nodejs, npm, git, curl, unzip, build-essential, sudo, sqlite3, unattended-upgrades, qemu-guest-agent]"
    extra=""
  fi
  cat > "$VMROOT/build/$kind-user-data" <<YAML
#cloud-config
users:
  - name: cloak
    shell: /bin/bash
    lock_passwd: true
    sudo: "ALL=(ALL) NOPASSWD:ALL"
package_update: true
packages: $pkgs
write_files:
  - path: /opt/cloak/agent.py
    encoding: b64
    permissions: '0755'
    content: $agent
  - path: /etc/systemd/system/cloak-agent.service
    content: |
      [Unit]
      Description=Cloak Computer agent
      After=network-online.target
      ConditionPathExists=/etc/cloak/agent.json
      [Service]
      ExecStart=/usr/bin/python3 /opt/cloak/agent.py
      Restart=always
      RestartSec=2
      [Install]
      WantedBy=multi-user.target
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
$extra
runcmd:
  - [systemctl, daemon-reload]
  - [systemctl, enable, cloak-agent]
  - [sh, -c, '[ "$kind" = desktop ] && systemctl set-default graphical.target || true']
  - [sh, -c, 'systemctl disable ssh.service ssh.socket 2>/dev/null || true']
  - [sh, -c, 'apt-get clean; rm -rf /var/lib/apt/lists/*']
  # Seal: forget this machine's identity, so every person's copy starts fresh.
  - [sh, -c, 'rm -f /etc/ssh/ssh_host_* /etc/cloak/agent.json; cloud-init clean --logs --machine-id; sync; poweroff']
YAML
  printf 'instance-id: cloak-build-%s\nlocal-hostname: cloak-%s\n' "$kind" "$kind" > "$VMROOT/build/$kind-meta-data"
  cloud-localds "$out" "$VMROOT/build/$kind-user-data" "$VMROOT/build/$kind-meta-data"
}

build_base() { # $1 kind  $2 cloud image  $3 disk GB  $4 MB
  local kind=$1 img=$2 gb=$3 mb=$4 name="cloak-build-$1"
  [ -f "$VMROOT/base/$kind.qcow2" ] && { echo "The $kind image is ready."; return; }
  echo "Building the $kind image. On this hard drive the software install can take 20 to 40 minutes."
  virsh -q destroy "$name" >/dev/null 2>&1 || true
  virsh -q undefine "$name" >/dev/null 2>&1 || true
  qemu-img create -q -f qcow2 -F qcow2 -b "$VMROOT/build/$img" "$VMROOT/build/$kind-build.qcow2" "${gb}G"
  build_seed "$kind" "$VMROOT/build/$kind-seed.iso"
  local gfx=(--graphics none)
  [ "$kind" = desktop ] && gfx=(--graphics vnc,listen=127.0.0.1 --video qxl)
  virt-install -q --name "$name" --memory "$mb" --vcpus 4 --cpu host-passthrough \
    --osinfo detect=on,require=off --import --noautoconsole --autostart=no \
    --disk "path=$VMROOT/build/$kind-build.qcow2,bus=virtio" --disk "path=$VMROOT/build/$kind-seed.iso,device=cdrom" \
    --network "network=$NET,model=virtio" "${gfx[@]}"
  # It powers itself off when the install is done.
  for _ in $(seq 1 360); do
    virsh -q domstate "$name" 2>/dev/null | grep -q "shut off" && break
    sleep 10
  done
  virsh -q domstate "$name" | grep -q "shut off" || fail "The $kind image did not finish building within an hour. Run this again to retry."
  virsh -q undefine "$name" >/dev/null
  # Flatten into one sealed, read-only file.
  qemu-img convert -O qcow2 "$VMROOT/build/$kind-build.qcow2" "$VMROOT/base/$kind.qcow2.part"
  mv -f "$VMROOT/base/$kind.qcow2.part" "$VMROOT/base/$kind.qcow2"
  chmod 0444 "$VMROOT/base/$kind.qcow2"
  rm -f "$VMROOT/build/$kind-build.qcow2" "$VMROOT/build/$kind-seed.iso"
  echo "The $kind image is sealed."
}

say "Computer 5/6  Building the golden images (once)"
build_base server debian-13-genericcloud-amd64.qcow2 12 2048
build_base desktop debian-13-generic-amd64.qcow2 16 4096
rm -f "$VMROOT/build/"debian-13-*.qcow2

say "Computer 6/6  Letting the brain manage them"
JSON="$CONF/computer.json"
if [ ! -f "$JSON" ] || ! grep -q '"version": *2' "$JSON"; then
  ACCESS=$(python3 -c "import json;print(json.load(open('$JSON')).get('access','admins'))" 2>/dev/null || echo admins)
  printf '{"version": 2, "access": "%s", "root": "%s"}\n' "$ACCESS" "$VMROOT" > "$JSON"
fi
chown cloakbrain:cloakbrain "$JSON"; chmod 600 "$JSON"
DROP=/etc/systemd/system/cloak-brain.service.d/computer.conf
mkdir -p "$(dirname "$DROP")"
WANT=$(printf '[Service]\nSupplementaryGroups=libvirt kvm\nEnvironment=LIBVIRT_DEFAULT_URI=qemu:///system\nReadWritePaths=%s\n' "$VMROOT")
if [ "$(cat "$DROP" 2>/dev/null)" != "$WANT" ]; then
  printf '%s\n' "$WANT" > "$DROP"
  systemctl daemon-reload
  systemctl restart cloak-brain
fi
echo "Cloak Computer is ready. Everyone gets their own machines, built the first time they need one."
