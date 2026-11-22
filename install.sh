#!/bin/sh
# Install the omp-server (service + socket) and openchamber systemd user units, the shared sandbox drop-in
# for the sidecar and the omp sessions it hosts, and the ~/bin launcher links.
#
# Every install is a symlink into this checkout, so the checkout stays the
# single source of truth: editing a launcher or a unit edits what systemd
# runs. Run this again if the checkout itself moves.

set -eu

repo=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
units="omp-server.service omp-server.socket omp-child@.service openchamber.service"
launchers="omp-server omp-child openchamber-serve"

for unit in $units; do
    [ -f "$repo/$unit" ] || {
        echo "install.sh: $repo/$unit missing" >&2
        exit 1
    }
done
for launcher in $launchers; do
    [ -x "$repo/bin/$launcher" ] || {
        echo "install.sh: $repo/bin/$launcher missing or not executable" >&2
        exit 1
    }
done

umask 022
# BindPaths= needs the source to exist, so create the state dirs up front.
mkdir -p "$HOME/.config/systemd/user" "$HOME/bin" "$HOME/.config/openchamber" "$HOME/.config/opencode" "$HOME/.cache"
for unit in $units; do
    ln -sf "$repo/$unit" "$HOME/.config/systemd/user/$unit"
done
# Links from the earlier layouts (a sandbox drop-in directory, no template) are removed.
rm -rf "$HOME/.config/systemd/user/omp-.service.d" "$HOME/.config/systemd/user/omp-child-.service.d"
for launcher in $launchers; do
    ln -sf "$repo/bin/$launcher" "$HOME/bin/$launcher"
done

envfile=$HOME/.config/omp-openchamber-server/env
if [ ! -f "$envfile" ]; then
    mkdir -p "$(dirname "$envfile")"
    umask 077
    cat > "$envfile" <<'EOF'
# Read by both units (EnvironmentFile=-).
# Caller-owned provider keys for omp:
# EXA_API_KEY=
# NVIDIA_API_KEY=
# Required for OpenChamber to listen on the tailnet address (otherwise it binds 127.0.0.1):
# OPENCHAMBER_UI_PASSWORD=
EOF
fi

[ -d "$repo/node_modules" ] ||
    echo "note: no node_modules in $repo, run 'bun install' before starting"
command -v openchamber >/dev/null 2>&1 ||
    echo "note: no openchamber on PATH; install @openchamber/web"

# List the bundled OpenChamber extensions (omp settings, Oh-My-Pi) and drop renamed ones. Writes to
# OpenChamber's data dir only; a running OpenChamber notices within seconds.
"$repo/bin/register-extensions" || true

command -v systemd-run >/dev/null 2>&1 ||
    echo "note: no systemd-run on PATH; kept for debugging; the sidecar itself uses systemctl"
systemctl --user show-environment >/dev/null 2>&1 ||
    echo "note: no user systemd manager reachable from this shell; run the commands below from a login session"

cat <<EOF
Installed:
  ~/.config/systemd/user/{omp-server.service,omp-server.socket,omp-child@.service,openchamber.service} -> $repo
  ~/bin/{omp-server,omp-child,openchamber-serve}                                                       -> $repo/bin

Start (first time, or switching from an install without omp-server.socket: this ends running omp sessions once,
the old sidecar owns their pipes and the port):
  systemctl --user daemon-reload
  systemctl --user stop openchamber.service omp-server.service
  systemctl --user start openchamber.service
         (openchamber Requires= omp-server.service, which Requires= omp-server.socket)
Watch:   journalctl --user -fu omp-server -fu openchamber
         systemctl --user list-units 'omp-child@*'      # one unit per live omp session

Update:  git pull && systemctl --user restart omp-server.service
         The port stays open and running omp sessions keep going: the new sidecar adopts them (docs/handover.md).
         Restart openchamber.service only when OpenChamber itself changed.
Port:    ListenStream= in omp-server.socket (default 127.0.0.1:4096), not OC_SIDECAR_PORT.

The omp settings and context panels are registered with OpenChamber; allow their
local services once in Settings -> Extensions to use them.

Namespace options in a user unit need unprivileged user namespaces
(sysctl kernel.unprivileged_userns_clone=1).
EOF
