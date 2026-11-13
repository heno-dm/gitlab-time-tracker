#!/bin/bash
# Entry point inside the test container (repo mounted read-only at /src):
# headless GJS checks, the package build, then a smoke test of the packaged
# extension inside a headless GNOME Shell (tests/container/smoke.sh).
set -eu
echo "== $(gnome-shell --version), $(gjs --version)"

rm -rf /work && cp -r /src /work && cd /work
make test
make build

# Isolated HOME with the keyfile GSettings backend; the built zip is unpacked
# where the Shell looks for user extensions.
UUID=timelogs-extension@heno-dm.github.io
export HOME=/tmp/home XDG_RUNTIME_DIR=/tmp/xdg GSETTINGS_BACKEND=keyfile
mkdir -p "$HOME/.config/glib-2.0/settings" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
EXT=$HOME/.local/share/gnome-shell/extensions/$UUID
mkdir -p "$EXT"
unzip -q -o "build/$UUID.shell-extension.zip" -d "$EXT"
glib-compile-schemas "$EXT/schemas"
cat > "$HOME/.config/glib-2.0/settings/keyfile" <<KEYFILE
[org/gnome/shell]
enabled-extensions=['$UUID']
disable-user-extensions=false
welcome-dialog-last-shown-version='9999'
KEYFILE

# The Shell needs a system bus (time limits manager) but must not find
# systemd's seat directory, or it insists on talking to logind.
rm -rf /run/systemd/seats
mkdir -p /run/dbus
dbus-daemon --system --fork --nopidfile
export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket

exec dbus-run-session -- bash /work/tests/container/smoke.sh
