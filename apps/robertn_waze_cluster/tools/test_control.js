// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Drives src/waze_cluster_control.js against tools/fakes.js.
 *
 *   node tools/test_control.js
 *
 * Covers: both sockets unreachable (the patch daemon not yet running);
 * Enable map / Disable map applying the one patch configuration; the map
 * following the stream with no command from the app, and an idle status
 * showing the stream's reason; a page opened while the
 * map is up reading its state, also when opened again;
 * the combined status line across patch and render state, ignoring extra
 * status fields and reading an unrecognised patch state as unknown; the
 * Enable prompt for a unit on an older safe area, and none from a daemon that
 * omits it; the status line a page renders on the link-up change, before the
 * first patch status arrives; the pending patch or removal (from the daemon,
 * or from its marker before the daemon runs) with no Enable or Disable; which
 * states offer Enable and Disable; a conflict the install left alone; the
 * merged, source-tagged log; and reconnect without duplicated backlog.
 */
const assert = require('assert');
const fs = require('fs');
const { WazeClusterControl, SIZE, SAFE } = require('../src/waze_cluster_control.js');
const { FakeRender, FakePatch, RENDER_PAGE, RENDER_FPS } = require('./fakes.js');

/* short: macOS limits a socket path to 104 bytes */
const RSOCK = `/tmp/woc-r-${process.pid}.sock`;
const PSOCK = `/tmp/woc-p-${process.pid}.sock`;
const PENDING = `/tmp/woc-pending-${process.pid}.json`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Resolves once check() holds, polling every 10 ms. */
function until(what, check) {
    const deadline = Date.now() + 1000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) {
                resolve();
            } else if (Date.now() > deadline) {
                reject(new Error(`timed out waiting for ${what}`));
            } else {
                setTimeout(poll, 10);
            }
        };
        poll();
    });
}

function control() {
    return new WazeClusterControl({ renderPath: RSOCK, patchPath: PSOCK, pendingPath: PENDING, retryMs: 100 });
}

const tests = [];
function test(name, fn) {
    tests.push({ name, fn });
}

test('patch daemon unreachable: reported, not an error', async () => {
    /* Neither socket exists — the patch service has not come up yet. */
    const c = control();
    c.open();
    await until('patch absent', () => c.patch.link === 'absent');
    assert.strictEqual(c.statusText(), 'Patch service unavailable (reboot may be needed)');
    assert.strictEqual(c.connectedPatch(), false);
    assert.strictEqual(c.connectedRender(), false);
    c.close();
});

test('explicit capture and early stop follow capture status without applying a patch', async (render, patch) => {
    const c=control();c.open();await until('connected',()=>c.connectedPatch());
    c.capture();await until('start sent',()=>patch.count('capture-start')===1);
    patch._broadcast({ev:'capture',capture:{state:'open'}});
    await until('capture ready',()=>c.captureButtonText()==='Stop capture');
    assert(c.captureText().includes('reconnect CarPlay'));
    c.capture();await until('stop sent',()=>patch.count('capture-stop')===1);
    assert.strictEqual(patch.count('apply'),0);
    patch._broadcast({ev:'capture',capture:{state:'restore_failed',error:'daemon unavailable'}});
    await until('restore failure visible',()=>c.captureText().includes('daemon unavailable'));
    c.close();
});

test('connected, original: enable the map', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    assert.strictEqual(c.connectedPatch(), true);
    assert.strictEqual(c.connectedRender(), true);
    c.close();
});

test('Enable map applies the patch; patched line once done', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    c.enableMap();
    await until('applying', () => c.statusText() === 'Applying patch…');
    await until('apply received', () => patch.count('apply') === 1);
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('A unit on the older mid-panel patch is prompted to Enable map', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('patched', 'mid', null);
    await until('update patch', () => c.statusText() === 'Patched — Enable map to update the patch');
    c.enableMap();
    await until('apply high', () => patch.count('apply') === 1);
    assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply'), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('the map follows the stream; the app sends the render nothing', async (render, patch) => {
    const c = control();
    const seen = [];
    c.on('change', () => seen.push(c.statusText()));
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    await until('patched idle', () => c.statusText() === 'Patched — waiting for CarPlay');
    render.stream(true);
    await until('showing', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    assert(seen.includes('Starting map…'), `status lines rendered on change: ${JSON.stringify(seen)}`);
    render.stream(false);
    await until('stream stopped', () => c.statusText() === 'Patched — waiting for CarPlay');
    render.announce('idle', 'Stream lost — reconnect CarPlay');
    await until('idle with the stream\'s reason', () => c.statusText() === 'Stream lost — reconnect CarPlay');
    assert.deepStrictEqual(render.received, [], 'no command to the render');
    assert.strictEqual(c.show, undefined);
    assert.strictEqual(c.stop, undefined);
    /* The DLT capture window is the Capture button's alone. */
    assert(!patch.received.some((m) => m.cmd === 'capture-start'), 'the stream does not arm capture');
    assert.strictEqual(SIZE, '1088x480');
    c.close();
});

test('a page opened while the map is up reads it, again after closing', async (render, patch) => {
    patch.res = SIZE;
    patch.safe = SAFE;
    patch.announce('patched', 'high', null);
    render.stream(true);
    await until('fake showing', () => render.state === 'showing');
    const c = control();
    c.open();
    await until('showing', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    c.close();
    await until('closed', () => render._clients.size === 0);
    c.open();
    await until('showing again', () => c.statusText() === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
    c.close();
});

test('Starting map while the render is mapping', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    render.announce('starting', null);
    await until('starting', () => c.statusText() === 'Starting map…');
    c.close();
});

test('a frozen stream: the line says to reconnect CarPlay', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedRender());
    patch.announce('patched', 'high', null);
    render.announce('frozen', "the phone's cluster stream froze");
    await until('frozen', () => c.statusText() === 'Map frozen — reconnect CarPlay');
    c.close();
});

test('Disable map reverts', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('patched', 'high', null);
    await until('patched', () => c.statusText().indexOf('Patched') === 0);
    c.disableMap();
    await until('reverting', () => c.statusText() === 'Reverting patch…');
    await until('revert received', () => patch.count('revert') === 1);
    assert.strictEqual(patch.count('revert'), 1);
    await until('original', () => c.statusText() === 'Original — enable the map');
    c.close();
});

test('status line on the link-up change, before the first patch status', async (render, patch) => {
    const c = control();
    /* The page renders on every change. The link-up change fires with the last
     * patch status cleared and the new one not yet arrived. */
    const seen = [];
    c.on('change', () => seen.push(c.statusText()));
    c.open();
    await until('connected', () => c.connectedPatch());
    assert(seen.includes('Patch state unknown — enable the map'),
        `status lines rendered on change: ${JSON.stringify(seen)}`);
    c.close();
});

test('extra status fields are ignored; an unrecognised state is not shown as patched', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', selfstart: 'patched', edits: [1, 2, 3, 4] });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    /* e.g. a binary patched before the self-start edit, reported under a new state name */
    patch._broadcast({ ev: 'status', state: 'partial', panel: 'high', mode: 'udp' });
    await until('needs enable', () => c.statusText() === 'Patch state unknown — enable the map');
    /* written but deferred to the next head-unit start: show the restart-needed
     * line with the daemon's reason, not "enable" */
    patch._broadcast({ ev: 'status', state: 'unknown', panel: 'high', mode: 'udp', carplay: 'deferred', reason: 'patch written; takes effect at the next head-unit start' });
    await until('restart needed', () => c.statusText() === 'Restart needed — patch written; takes effect at the next head-unit start');
    /* patched onto another sink by an older app: the stream never reaches the
     * render, so Enable map is prompted instead of the render line */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'udp' });
    await until('update capture', () => c.statusText() === 'Patched — Enable map to update the patch');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '720x320' });
    await until('update resolution', () => c.statusText() === 'Patched — Enable map to update the patch');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '1088x480' });
    await until('patched avb', () => c.statusText() === 'Patched — waiting for CarPlay');
    c.close();
});

test('an older full-frame safe area prompts Enable map, which writes the default', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    /* 1088x480 with the whole frame as the safe area: the guidance banner
     * lands under the gauges, so Enable map is prompted. */
    patch.res = '1088x480';
    patch.safe = '1088x480+0+0';
    patch.announce('patched', 'high', null);
    await until('update safe area', () => c.statusText() === 'Patched — Enable map to update the patch');
    c.enableMap();
    await until('applied', () => patch.count('apply') === 1 && !patch.busy);
    assert.strictEqual(patch.safe, SAFE);
    await until('current', () => c.statusText() === 'Patched — waiting for CarPlay');
    /* A daemon that omits safe (before the safe area) is taken as current. */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: '1088x480' });
    await until('older daemon', () => c.statusText() === 'Patched — waiting for CarPlay' && c.patchStatus.safe === undefined);
    assert.strictEqual(SAFE, '504x368+286+72');
    c.close();
});

test('installed, before the head-unit start: the marker shows the pending patch, no buttons', async () => {
    /* The install wrote the patch; the daemon starts at the next head-unit
     * start, so only its marker says so. */
    fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply', reason: 'patch written; takes effect at the next head-unit start' }) + '\n');
    const c = control();
    c.open();
    await until('patch absent', () => c.patch.link === 'absent');
    assert.strictEqual(c.statusText(), 'Patch pending — reboot to activate');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    assert.strictEqual(c.restartNeeded(), false, 'no daemon to reboot through');
    fs.writeFileSync(PENDING, JSON.stringify({ action: 'revert' }) + '\n');
    assert.strictEqual(c.statusText(), 'Removal pending — reboot to finish');
    fs.unlinkSync(PENDING);
    assert.strictEqual(c.statusText(), 'Patch service unavailable (reboot may be needed)');
    c.close();
});

test('a pending apply from the daemon: its line, a restart, no Enable or Disable', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.pending = 'apply';
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('pending', () => c.statusText() === 'Patch pending — reboot to activate');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    assert.strictEqual(c.restartNeeded(), true);
    patch.pending = 'revert';
    patch.announce('unknown', null, 'patch removed; the original carplay runs from the next head-unit start', 'deferred');
    await until('removal pending', () => c.statusText() === 'Removal pending — reboot to finish');
    assert.strictEqual(c.canEnable(), false);
    assert.strictEqual(c.canDisable(), false);
    c.requestRestart();
    await until('restarting', () => c.statusText() === 'Restarting head unit…');
    c.close();
});

test('Enable map only for original, unknown or outdated; Disable map only for a patch', async (render, patch) => {
    const c = control();
    c.open();
    await until('original', () => c.statusText() === 'Original — enable the map');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, false], 'original');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: SIZE, safe: SAFE });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [false, true], 'patched');
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'mid', mode: 'avb', res: null, safe: null });
    await until('outdated', () => c.statusText() === 'Patched — Enable map to update the patch');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, true], 'outdated patch');
    patch._broadcast({ ev: 'status', state: 'unknown', panel: 'high', reason: 'self-start edit missing (older patch); enable the map to apply it' });
    await until('unknown', () => c.statusText() === 'Patch state unknown — enable the map');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [true, true], 'unknown');
    patch._broadcast({ ev: 'status', state: 'busy', reason: 'applying' });
    await until('busy', () => c.statusText() === 'Applying patch…');
    assert.deepStrictEqual([c.canEnable(), c.canDisable()], [false, false], 'busy');
    c.close();
});

test('a conflict the install left alone is shown, and Enable map stays the user\'s choice', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.conflict = 'carplay.service starts /bin/sh (/etc/systemd/system/carplay.service.d/60-other.conf)';
    patch.announce('original', null, null);
    await until('conflict', () => c.statusText() === `Not patched — ${patch.conflict}`);
    assert.strictEqual(c.canEnable(), true);
    patch.conflict = 'not patchable: self-start: onSuggestUi call not found';
    patch.announce('unknown', null, null);
    await until('unknown conflict', () => c.statusText() === `Patch state unknown — ${patch.conflict}`);
    assert.strictEqual(c.canEnable(), true);
    c.close();
});

test('a deferred patch offers a restart; one press reboots once', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    assert.strictEqual(c.restartNeeded(), false, 'no restart before a deferred patch');
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('restart needed', () => c.restartNeeded());
    assert.strictEqual(c.statusText(), 'Restart needed — patch written; takes effect at the next head-unit start');
    c.requestRestart();
    await until('reboot sent', () => patch.count('reboot') === 1);
    await until('restarting', () => c.statusText() === 'Restarting head unit…');
    assert.strictEqual(c.restartRequested(), true);
    /* A second press does not send another reboot. */
    c.requestRestart();
    await sleep(50);
    assert.strictEqual(patch.count('reboot'), 1, 'the restart is sent once');
    assert.strictEqual(patch.reboots, 1, 'the daemon reboots once');
    c.close();
});

test('no restart button when carplay restarts at once (never deferred)', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    /* An apply that restarts carplay reports carplay "restarted", never
     * "deferred": the restart is not needed. */
    patch._broadcast({ ev: 'status', state: 'patched', panel: 'high', mode: 'avb', res: SIZE, safe: SAFE, carplay: 'restarted' });
    await until('patched', () => c.statusText() === 'Patched — waiting for CarPlay');
    assert.strictEqual(c.restartNeeded(), false);
    c.requestRestart();
    await sleep(50);
    assert.strictEqual(patch.count('reboot'), 0, 'no reboot is sent when none is needed');
    c.close();
});

test('a refused restart reply clears the asked flag so the button returns', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
    await until('restart needed', () => c.restartNeeded());
    /* The daemon refuses this request (a restart is already underway); its
     * reply carries no status, so the deferred state is unchanged. */
    patch._rebooting = true;
    c.requestRestart();
    await until('requested', () => c.restartRequested());
    await until('cleared', () => !c.restartRequested());
    assert.strictEqual(c.restartNeeded(), true, 'still deferred, so the button is offered again');
    assert.strictEqual(patch.reboots, 0, 'the refused request reboots nothing');
    c.close();
});

test('render unreachable while patched', async (render, patch) => {
    /* Only the patch daemon is up (the render socket is absent in this case). */
    const c = new WazeClusterControl({ renderPath: `/tmp/woc-none-${process.pid}.sock`, patchPath: PSOCK, retryMs: 100 });
    c.open();
    await until('patch up', () => c.connectedPatch());
    patch.announce('patched', 'high', null);
    await until('map unavailable', () => c.statusText() === 'Patched — map service unavailable');
    assert.strictEqual(c.connectedRender(), false);
    c.close();
});

test('merged log, newest first, tagged by source', async (render, patch) => {
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch() && c.connectedRender());
    render.log('render running');
    patch.log('patchd listening');
    await until('both lines', () => c.rows().some((r) => r.indexOf('render running') >= 0) &&
        c.rows().some((r) => r.indexOf('patchd listening') >= 0));
    const rows = c.rows();
    assert.strictEqual(rows[0], 'patch: patchd listening', 'newest line first');
    assert.ok(rows.some((r) => r === 'map: render running'), 'render line tagged map');
    c.close();
});

test('reconnect does not duplicate the backlog', async (render, patch) => {
    patch.log('boot line');
    const c = control();
    c.open();
    await until('connected', () => c.connectedPatch());
    await until('backlog', () => c.rows().some((r) => r === 'patch: boot line'));
    const before = c.rows().filter((r) => r === 'patch: boot line').length;
    assert.strictEqual(before, 1);
    patch.dropClients();
    await until('reconnected', () => c.connectedPatch());
    await sleep(50);
    const after = c.rows().filter((r) => r === 'patch: boot line').length;
    assert.strictEqual(after, 1, 'the resent backlog is not duplicated');
    c.close();
});

/* A deterministic status stream lets us inject stale, failed and deferred
 * broadcasts in the same order a real socket can deliver them. */
function navControl(state, nav) {
    const c = control();
    const sent = [];
    c.patch.link = 'up';
    c.patch.send = (msg) => sent.push(msg);
    c._onPatch({ ev: 'status', state: state, navmd: nav });
    return { c, sent };
}
function navStatus(c, state, nav, extra) {
    c._onPatch(Object.assign({ ev: 'status', state: state, navmd: nav }, extra || {}));
}

test('navmd is a local pre-option; apply true then apply false without reverting map', () => {
    const t = navControl('patched', {state:'off'}), c = t.c;
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: Off');
    assert(!c.canEnable());
    c.toggleNavmd();
    assert.strictEqual(c.navmdStatusText(), 'Guidance on disk: Off');
    assert.strictEqual(t.sent.length, 0);
    assert(c.navmdText().includes('On') && c.navmdText().includes('not applied'));
    assert(c.canEnable());
    assert.strictEqual(c.enableButtonText(), 'Apply settings');
    c.enableMap();
    assert.deepStrictEqual(t.sent[0], {cmd:'apply',panel:'high',mode:'avb',navmd:true});
    assert(!c.canEnable() && !c.canDisable() && !c.canToggleNavmd());
    assert.strictEqual(c.statusText(), 'Applying patch…');
    navStatus(c, 'busy', {state:'unknown',reason:'patch operation in progress'});
    assert(c.navmdText().includes('On — not applied'));
    assert(c.navmdStatusText().includes('patch operation in progress'));
    navStatus(c, 'patched', {state:'on'});
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: On');
    assert(!c.canEnable());
    c.toggleNavmd(); c.enableMap();
    assert.deepStrictEqual(t.sent[1], {cmd:'apply',panel:'high',mode:'avb',navmd:false});
    navStatus(c, 'busy', {state:'on'});
    navStatus(c, 'patched', {state:'off'});
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: Off');
    c.disableMap();
    assert.deepStrictEqual(t.sent[2], {cmd:'revert'});
});

test('navmd syncs on/off until edited, and stale refresh cannot clear dirty selection', () => {
    const t = navControl('original', {state:'off'}), c = t.c;
    navStatus(c, 'original', {state:'on'});
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: On');
    navStatus(c, 'original', {state:'off'});
    c.toggleNavmd();
    navStatus(c, 'original', {state:'off'});
    navStatus(c, 'original', {state:'on'});
    assert(c.navmdText().includes('On — not applied'));
    c.enableMap();
    navStatus(c, 'patched', {state:'on'}); // stale matching status before busy
    assert(c.navmdText().includes('not applied'));
    navStatus(c, 'busy', {state:'off'});
    navStatus(c, 'patched', {state:'off'}); // failed to reach requested state
    assert(c.navmdText().includes('On — not applied'));
    assert(c.canEnable());
});

test('unavailable, unknown and old daemons never allow toggling or receive navmd', () => {
    [undefined, {state:'unavailable',reason:'No root-provisioned verified anchor'},
        {state:'unknown',reason:'proof failed'}, {state:'future'}].forEach((nav) => {
        const t = navControl('original', nav), c = t.c;
        assert(!c.canToggleNavmd());
        c.toggleNavmd();
        assert.strictEqual(t.sent.length, 0);
        assert(c.navmdStatusText().includes(nav && nav.reason || 'daemon does not report this option') || nav && nav.state === 'future');
        c.enableMap();
        assert.deepStrictEqual(t.sent[0], {cmd:'apply',panel:'high',mode:'avb'});
    });
});

test('dirty selection survives errors, unsupported refresh, and disconnect before busy', () => {
    const t = navControl('patched', {state:'off'}), c = t.c;
    c.toggleNavmd(); c.enableMap();
    navStatus(c, 'error', undefined, {reason:'write failed'});
    assert.strictEqual(c.statusText(), 'Patch error: write failed');
    assert(c.navmdText().includes('On — not applied'));
    assert(c.navmdStatusText().includes('daemon does not report'));
    navStatus(c, 'patched', {state:'unavailable',reason:'no verified anchor'});
    assert(!c.canToggleNavmd() && !c.canEnable() && c.navmdText().includes('On — not applied') && c.navmdStatusText().includes('no verified anchor'));
    navStatus(c, 'patched', {state:'off'});
    assert(c.navmdText().includes('On — not applied'));
    c.enableMap();
    c._patchDisconnected();
    c.patch.link = 'up';
    navStatus(c, 'patched', {state:'on'}); // no observed busy: cannot prove completion
    assert(c.navmdText().includes('On — not applied'));
    assert(c.canEnable());
});

test('operation error with verified changed disk syncs a clean choice before the next click', () => {
    [['off', 'on'], ['on', 'off']].forEach((states) => {
        const t = navControl('original', {state:states[0]}), c = t.c;
        c.enableMap(); // unchanged option: no dirty user intent
        navStatus(c, 'busy', {state:'unknown'});
        navStatus(c, 'error', {state:states[1]}, {reason:'write failed'});
        assert.strictEqual(c.statusText(), 'Patch error: write failed');
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: ' + (states[1] === 'on' ? 'On' : 'Off'));
        assert.strictEqual(c.navmdStatusText(), 'Guidance on disk: ' + (states[1] === 'on' ? 'On' : 'Off'));
        assert(c.canToggleNavmd());
        c.toggleNavmd();
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: ' + (states[0] === 'on' ? 'On' : 'Off') + ' — not applied');
        c.enableMap();
        assert.deepStrictEqual(t.sent[1], {cmd:'apply',panel:'high',mode:'avb',navmd:states[0] === 'on'});
        c.close();
    });
});

test('operation error with verified matching disk does not clear a dirty intent', () => {
    const c = navControl('original', {state:'off'}).c;
    c.toggleNavmd(); c.enableMap();
    navStatus(c, 'busy', {state:'unknown'});
    navStatus(c, 'error', {state:'on'}, {reason:'write failed'});
    assert.strictEqual(c.statusText(), 'Patch error: write failed');
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: On — not applied');
    assert.strictEqual(c.navmdStatusText(), 'Guidance on disk: On');
    c.close();
});

test('deferred navmd is not confirmed until post-reboot authoritative status', () => {
    const t = navControl('patched', {state:'off'}), c = t.c;
    c.toggleNavmd(); c.enableMap();
    navStatus(c, 'busy', {state:'off'});
    navStatus(c, 'unknown', {state:'on'}, {carplay:'deferred', pending:'apply'});
    assert.strictEqual(c.statusText(), 'Patch pending — reboot to activate');
    assert(c.navmdText().includes('not applied') && c.navmdText().includes('reboot needed') && c.navmdStatusText().includes('on disk: On — reboot needed'));
    assert(!c.canEnable() && !c.canToggleNavmd() && c.restartNeeded());
    c._patchDisconnected(); c.patch.link = 'up';
    navStatus(c, 'patched', {state:'on'});
    assert.strictEqual(c.navmdText(), 'Suppress native guidance: On');
    assert(!c.canEnable());
});

test('toggling twice returns to disk state without a spurious apply', () => {
    ['off', 'on'].forEach((state) => {
        const t = navControl('patched', {state:state}), c = t.c;
        c.toggleNavmd();
        assert(c.canEnable() && c.navmdText().includes('not applied'));
        c.toggleNavmd();
        assert(!c.canEnable());
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: ' + (state === 'on' ? 'On' : 'Off'));
        assert.strictEqual(t.sent.length, 0);
    });
});

test('fresh pending state mirrors disk with reboot warning without overwriting dirty choice', () => {
    ['on', 'off'].forEach((state) => {
        const c = navControl('unknown', {state:state}).c;
        navStatus(c, 'unknown', {state:state}, {pending:'apply', carplay:'deferred'});
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: ' + (state === 'on' ? 'On' : 'Off') + ' — reboot needed');
        assert(c.navmdStatusText().includes('reboot needed'));
        assert(!c.canEnable() && !c.canToggleNavmd());
    });
    const c = navControl('patched', {state:'off'}).c;
    c.toggleNavmd();
    navStatus(c, 'unknown', {state:'off'}, {pending:'apply', carplay:'deferred'});
    assert(c.navmdText().includes('On — not applied') && c.navmdText().includes('reboot needed'));
});

test('missed busy times out, reconnects for fresh status and never confirms dirty choice', async (render, patch) => {
    patch.state = 'patched'; patch.panel = 'high'; patch.navmd = {state:'off'};
    const initialConnect = patch._onConnect.bind(patch);
    let connects = 0;
    patch._onConnect = (socket) => { if (++connects === 1) initialConnect(socket); };
    patch._onCommand = (msg) => {
        patch.received.push(msg);
        if (msg.cmd === 'apply') {
            patch.navmd = {state:'on'};
            patch._broadcast(patch._status()); // terminal event, no busy
        }
    };
    const c = new WazeClusterControl({renderPath:RSOCK, patchPath:PSOCK, pendingPath:PENDING,
        retryMs:30, operationTimeoutMs:80});
    try {
        c.open();
        await until('initial nav status', () => c.canToggleNavmd());
        c.toggleNavmd(); c.enableMap();
        await until('terminal before busy', () => patch.count('apply') === 1 && c.patchStatus && c.patchStatus.navmd.state === 'on');
        assert(!c.canEnable() && c.navmdText().includes('not applied'));
        await until('timeout and fresh status request', () => connects >= 2 && patch.count('status') === 1);
        assert.strictEqual(c.statusText(), 'Operation unconfirmed — refreshing patch status…');
        assert(!c.canEnable() && !c.canDisable() && !c.canToggleNavmd());
        assert(c.navmdText().includes('On — not applied'));
        patch._broadcast(patch._status());
        await until('fresh status releases lock', () => c.canEnable());
        assert.strictEqual(c.statusText(), 'Operation unconfirmed — check status before retrying');
        assert(c.navmdText().includes('On — not applied'));
        assert.strictEqual(c.navmdStatusText(), 'Guidance on disk: On');
    } finally { c.close(); }
});

test('operation timers stop after confirmed success, error, deferred state, and close', () => {
    const a = navControl('patched', {state:'off'}).c;
    a.toggleNavmd(); a.enableMap(); assert(a._operationTimer);
    navStatus(a, 'busy', {state:'unknown'}); navStatus(a, 'patched', {state:'on'});
    assert.strictEqual(a._operationTimer, null);
    const b = navControl('patched', {state:'off'}).c;
    b.toggleNavmd(); b.enableMap(); navStatus(b, 'error', undefined);
    assert.strictEqual(b._operationTimer, null);
    const d = navControl('patched', {state:'off'}).c;
    d.toggleNavmd(); d.enableMap(); navStatus(d, 'busy', {state:'unknown'});
    navStatus(d, 'unknown', {state:'on'}, {pending:'apply',carplay:'deferred'});
    assert.strictEqual(d._operationTimer, null);
    const e = navControl('patched', {state:'off'}).c;
    e.toggleNavmd(); e.enableMap(); e.close();
    assert.strictEqual(e._operationTimer, null);
});

async function main() {
    let failed = 0;
    for (const t of tests) {
        const needsServers = t.fn.length > 0;
        const render = new FakeRender(RSOCK);
        const patch = new FakePatch(PSOCK);
        if (needsServers) {
            await render.listen();
            await patch.listen();
        }
        try {
            await t.fn(render, patch);
            console.log(`ok   ${t.name}`);
        } catch (err) {
            failed++;
            console.log(`FAIL ${t.name}\n     ${err && err.stack}`);
        } finally {
            if (needsServers) {
                await render.close();
                await patch.close();
            }
            [RSOCK, PSOCK, PENDING].forEach((p) => {
                try {
                    fs.unlinkSync(p);
                } catch (e) {
                    /* gone */
                }
            });
        }
    }
    console.log(`${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

main();
