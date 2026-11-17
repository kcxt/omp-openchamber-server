#!/bin/sh
# Install the omp-server systemd user unit and the ~/bin launcher link.
#
# Both installs are symlinks into this checkout, so the checkout stays the
# single source of truth: editing the launcher or the unit edits what systemd
# runs. Run this again if the checkout itself moves.

set -eu

repo=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
unit=omp-server.service
launcher=$repo/bin/omp-server

[ -f "$repo/$unit" ] || {
    echo "install.sh: $repo/$unit missing" >&2
    exit 1
}
[ -x "$launcher" ] || {
    echo "install.sh: $launcher missing or not executable" >&2
    exit 1
}

umask 022
mkdir -p "$HOME/.config/systemd/user"
ln -sf "$repo/$unit" "$HOME/.config/systemd/user/$unit"

mkdir -p "$HOME/bin"
ln -sf "$launcher" "$HOME/bin/omp-server"

envfile=$HOME/.config/omp-openchamber-server/env
if [ ! -f "$envfile" ]; then
    mkdir -p "$(dirname "$envfile")"
    umask 077
    cat > "$envfile" <<'EOF'
# Read by omp-server.service (EnvironmentFile=-). Caller-owned provider keys.
# EXA_API_KEY=
# NVIDIA_API_KEY=
EOF
fi

[ -d "$repo/node_modules" ] ||
    echo "note: no node_modules in $repo, run 'bun install' before starting"

cat <<EOF
Installed:
  ~/.config/systemd/user/$unit -> $repo/$unit
  ~/bin/omp-server             -> $launcher

Start:   systemctl --user restart $unit
Watch:   journalctl --user -fu $unit
Direct:  ~/bin/omp-server

Restart alone picks up checkout updates; after editing the unit itself run
systemctl --user daemon-reload first. Namespace options in a user unit need
unprivileged user namespaces (sysctl kernel.unprivileged_userns_clone=1).
EOF
