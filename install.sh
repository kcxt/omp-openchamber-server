#!/bin/sh
# Install the omp-server and openchamber systemd user units and the ~/bin
# launcher links.
#
# Every install is a symlink into this checkout, so the checkout stays the
# single source of truth: editing a launcher or a unit edits what systemd
# runs. Run this again if the checkout itself moves.

set -eu

repo=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
units="omp-server.service openchamber.service"
launchers="omp-server openchamber-serve"

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
mkdir -p "$HOME/.config/systemd/user" "$HOME/bin" "$HOME/.config/openchamber" "$HOME/.config/opencode"
for unit in $units; do
    ln -sf "$repo/$unit" "$HOME/.config/systemd/user/$unit"
done
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

# List the bundled OpenChamber extensions (omp settings, context). Writes to
# OpenChamber's data dir only; a running OpenChamber notices within seconds.
"$repo/bin/register-extensions" || true

cat <<EOF
Installed:
  ~/.config/systemd/user/{omp-server,openchamber}.service -> $repo
  ~/bin/{omp-server,openchamber-serve}                    -> $repo/bin

Reload:  systemctl --user daemon-reload
Start:   systemctl --user enable --now openchamber.service
         (omp-server.service starts with it: openchamber Requires= it)
Watch:   journalctl --user -fu omp-server -fu openchamber

The omp settings and context panels are registered with OpenChamber; allow their
local services once in Settings -> Extensions to use them.

A checkout update needs only: systemctl --user restart omp-server openchamber
Namespace options in a user unit need unprivileged user namespaces
(sysctl kernel.unprivileged_userns_clone=1).
EOF
