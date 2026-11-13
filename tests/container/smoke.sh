#!/bin/bash
# Drives the extension inside a headless GNOME Shell over org.gnome.Shell.Eval
# (needs --unsafe-mode). Exits non-zero when a step does not report what the
# click comparison table in docs/REDESIGN.md §3 expects.
UUID=timelogs-extension@heno-dm.github.io
LOG=/tmp/gnome-shell.log
gnome-shell --headless --virtual-monitor 1280x720 --wayland --unsafe-mode >"$LOG" 2>&1 &
SHELL_PID=$!
failures=0

# Eval helper: prints the JSON the expression returned, unescaped. Eval
# returns JSON.stringify(result), so a string result arrives double-quoted
# with escaped inner quotes while a number such as `1` arrives bare.
ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1 \
        | sed -e "s/^(true, '//" -e "s/')\$//" -e 's/^"\(.*\)"$/\1/' -e 's/\\\\"/"/g'
}
# check NAME EXPR EXPECTED_FRAGMENT...
check() {
    local name=$1 out; out=$(ev "$2"); shift 2
    local ok=1 fragment
    for fragment in "$@"; do
        [[ $out == *"$fragment"* ]] || ok=0
    done
    if [ $ok = 1 ]; then
        echo "PASS $name"
    else
        echo "FAIL $name: expected $*"; echo "     got: $out"; failures=$((failures + 1))
    fi
}

for _ in $(seq 1 120); do
    [[ $(ev 1) == 1 ]] && break
    kill -0 $SHELL_PID 2>/dev/null || { echo "FAIL gnome-shell exited during startup"; tail -30 "$LOG"; exit 1; }
    sleep 1
done
[[ $(ev 1) == 1 ]] || { echo "FAIL gnome-shell did not answer org.gnome.Shell.Eval within 120 s"; tail -30 "$LOG"; kill $SHELL_PID; exit 1; }
ev "globalThis.J = o => JSON.stringify(o); globalThis.bind = () => { globalThis.ext = Main.extensionManager.lookup('$UUID').stateObj; globalThis.ind = ext._indicator; }; bind(); 0" >/dev/null

check "extension enabled without error" \
    "J({state: Main.extensionManager.lookup('$UUID').state, error: Main.extensionManager.lookup('$UUID').error})" \
    '"state":1' '"error":""'

# Seed a running and a paused session, then re-enable so the store restores them.
# Enable/disable may be deferred, so each step gets its own Eval round trip.
ev "Main.extensionManager.disableExtension('$UUID'); 0" >/dev/null; sleep 1
ev "const Gio = imports.gi.Gio; const src = Gio.SettingsSchemaSource.new_from_directory(ext.dir.get_child('schemas').get_path(), Gio.SettingsSchemaSource.get_default(), false); const st = new Gio.Settings({settings_schema: src.lookup('org.gnome.shell.extensions.timelogs-extension', true)}); const now = Math.floor(Date.now() / 1000); const project = {id: 1, path_with_namespace: 'group/app', name: 'app', web_url: 'https://gitlab.example/group/app'}; st.set_string('timer-state', JSON.stringify({version: 3, activeKey: '1#142', lastSeenAt: now - 60, sessions: [{key: '1#142', project, issue: {id: 101, iid: 142, title: 'Fix login redirect loop'}, accumulatedSeconds: 3600, runningSince: now - 300, updatedAt: now - 300}, {key: '1#7', project, issue: {id: 7, iid: 7, title: 'Paused one'}, accumulatedSeconds: 900, runningSince: null, updatedAt: now - 900}]})); Gio.Settings.sync(); 0" >/dev/null
ev "Main.extensionManager.enableExtension('$UUID'); 0" >/dev/null; sleep 1
ev "bind(); 0" >/dev/null
check "sessions restored after re-enable" \
    "J({error: Main.extensionManager.lookup('$UUID').error, active: ext._store.snapshot().active?.key ?? null, paused: ext._store.snapshot().paused.map(s => s.key)})" \
    '"error":""' '"active":"1#142"' '"paused":["1#7"]'
check "panel shows the running time" "J({label: ind._panelLabel.text, labelVisible: ind._panelLabel.visible, visible: ind.visible})" '"labelVisible":true' '"visible":true'
check "open-menu shortcut opens with search" "ind.openWithSearch(); J({open: ind.menu.isOpen})" '"open":true'
check "open-menu shortcut toggles" \
    "ind.toggleMenuFromShortcut(); const a = ind.menu.isOpen; ind.toggleMenuFromShortcut(); J({afterFirst: a, afterSecond: ind.menu.isOpen})" \
    '"afterFirst":false' '"afterSecond":true'
check "menu has vertical St.BoxLayouts (orientation shim)" \
    "const St = imports.gi.St; let total = 0, vertical = 0; const walk = a => { if (a instanceof St.BoxLayout) { total++; if ((a.orientation ?? (a.vertical ? 1 : 0)) === 1) vertical++; } a.get_children?.().forEach(walk); }; walk(ind.menu.box); J({total, vertical, ok: total > 0 && vertical > 0})" \
    '"ok":true'
ev "import(ext.dir.get_child('ui').get_child('submitDialog.js').get_uri()).then(m => { globalThis.SubmitDialog = m.SubmitDialog; }); 0" >/dev/null; sleep 1
check "submit dialog opens with a vertical form and live button label" \
    "const s = ext._store.get('1#142'); const d = new SubmitDialog({gettext: t => t, project: s.project, issue: s.issue, duration: '1h 10m', roundingMinutes: 15, onSubmit: () => {}}); const opened = d.open(); let form = d._durationEntry; while (form && !form.get_style_class_name?.()?.includes('timelogs-submit-form')) form = form.get_parent(); const out = J({opened, vertical: (form.orientation ?? (form.vertical ? 1 : 0)) === 1, label: d._submitButton?.label ?? null}); d.close(); out" \
    '"opened":true' '"vertical":true' '"label":"Submit 1h 10m"'
check "notification with actions shows up under the Timelogs source" \
    "import(ext.dir.get_child('ui').get_child('notifications.js').get_uri()).then(m => m.notifyWithActions('Timelogs test', 'body', [{label: 'Act', callback: () => {}}])); 0; J({queued: true})" '"queued":true'
sleep 1
check "source exists while enabled" "J({sources: Main.messageTray.getSources().filter(s => s.title === 'Timelogs').length})" '"sources":1'
ev "Main.extensionManager.disableExtension('$UUID'); 0" >/dev/null; sleep 1
check "disable leaves no indicator in the panel" "J({gone: !Main.panel.statusArea['$UUID']})" '"gone":true'
check "disable removes the notification source" "J({sources: Main.messageTray.getSources().filter(s => s.title === 'Timelogs').length})" '"sources":0'
ev "Main.extensionManager.enableExtension('$UUID'); 0" >/dev/null; sleep 1
check "re-enable works" "J({state: Main.extensionManager.lookup('$UUID').state, error: Main.extensionManager.lookup('$UUID').error})" '"state":1' '"error":""'

kill $SHELL_PID; wait $SHELL_PID 2>/dev/null; sleep 1
if grep -i -E "timelogs|JS ERROR|deprecated" "$LOG" | grep -v -i "welcome" | grep -q .; then
    echo "FAIL shell log mentions the extension, JS errors or deprecations:"
    grep -i -E "timelogs|JS ERROR|deprecated" "$LOG" | head -20
    failures=$((failures + 1))
else
    echo "PASS shell log has no JS errors, deprecation warnings or extension messages"
fi
[ $failures = 0 ] && echo "Container smoke test passed" || echo "$failures check(s) failed"
exit $failures
