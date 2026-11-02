#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
/* Real UI control -> Unix socket -> patchd -> real patcher, entirely in /tmp.
 * Run with Node 8 or later: node tools/test_navmd_end_to_end.js
 * The synthetic ELF is unproven; the UI's explicit Enable operation authorizes
 * it just as it does on a head unit. No privileged commands are executed.
 */
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var Control = require('../src/waze_cluster_control.js').WazeClusterControl;
var patchDir = path.resolve(__dirname, '../../../native/waze-on-cluster/patch');
var patchd = path.join(patchDir, 'patchd.js');
var fixture = require(path.join(patchDir, 'test/synthetic_carplay.js')).build();
var original = fixture.buf;

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
async function until(name, check, w) {
    var deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (w.spawnError) throw w.spawnError;
        if (w.child && (w.child.exitCode !== null || w.child.signalCode !== null)) throw new Error('daemon exited: ' + w.stderr);
        if (check()) return;
        if (w.control && w.control.patchStatus && w.control.patchStatus.state === 'error')
            throw new Error(name + ': daemon error ' + JSON.stringify(w.control.patchStatus) + '\n' + w.stderr);
        await sleep(25);
    }
    throw new Error('timeout: ' + name + '; status=' + JSON.stringify(w.control && w.control.patchStatus) + '\n' + w.stderr);
}
function remove(p) {
    var st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!st.isDirectory() || st.isSymbolicLink()) { fs.unlinkSync(p); return; }
    fs.readdirSync(p).forEach(function (name) { remove(path.join(p, name)); });
    fs.rmdirSync(p);
}
function quote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function script(p, body) { fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); fs.chmodSync(p, 0o755); }
function create(anchored) {
    var d = fs.mkdtempSync('/tmp/woc-e2e-');
    ['bin', 'proc', 'units', 'sock'].forEach(function (n) { fs.mkdirSync(path.join(d, n)); });
    var w = { dir: d, target: path.join(d, 'carplay'), sock: path.join(d, 'sock/p.sock'),
        calls: path.join(d, 'calls'), mounts: path.join(d, 'mounts'), stderr: '', sent: [], statuses: [] };
    fs.writeFileSync(w.target, original);
    fs.writeFileSync(w.calls, '');
    fs.writeFileSync(w.mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(d, 'recmgr'), '');
    fs.writeFileSync(path.join(d, 'stat'), 'cpu 1 2 3\nbtime 1\n');
    fs.writeFileSync(path.join(d, 'bootid'), 'synthetic-boot\n');
    var bin = path.join(d, 'bin');
    script(path.join(bin, 'mount'), 'echo "mount $*" >> ' + quote(w.calls) + '\n' +
        'case "$*" in "-o remount,rw /") m=rw ;; "-o remount,ro /") m=ro ;; *) exit 91 ;; esac\n' +
        'printf "/dev/root / ext4 %s 0 0\\n" "$m" > ' + quote(w.mounts));
    script(path.join(bin, 'systemctl'), 'echo "systemctl $*" >> ' + quote(w.calls) + '\n' +
        'case "$1" in show) printf "MainPID=0\\nActiveState=inactive\\nResult=success\\nInvocationID=\\n" ;; ' +
        'is-system-running) echo running ;; *) exit 92 ;; esac');
    ['reboot', 'kill'].forEach(function (n) { script(path.join(bin, n), 'echo "' + n + ' $*" >> ' + quote(w.calls) + '\nexit 93'); });
    script(path.join(bin, 'journalctl'), 'exit 0');
    script(path.join(bin, 'dlt-receive'), 'exit 0');
    var env = {};
    Object.keys(process.env).forEach(function (k) {
        if (!/^WOC_/.test(k) && k !== 'NODE_OPTIONS' && k !== 'CARPLAY_BIN') env[k] = process.env[k];
    });
    Object.assign(env, {
        PATH: bin + path.delimiter + (process.env.PATH || ''),
        WOC_CARPLAY: w.target, WOC_PATCH_SOCK: w.sock, WOC_MOUNT: path.join(bin, 'mount'),
        WOC_PROC_MOUNTS: w.mounts, WOC_PROC: path.join(d, 'proc'),
        WOC_RECMGR_CONF: path.join(d, 'recmgr'), WOC_RECMGR_AT_BOOT: path.join(d, 'no-recmgr'),
        WOC_PROC_STAT: path.join(d, 'stat'), WOC_BOOT_ID: path.join(d, 'bootid'),
        WOC_UNIT_DIRS: path.join(d, 'units'), WOC_CAPTURE_SOCK: path.join(d, 'capture.sock'),
        WOC_DLT_RECEIVE: path.join(bin, 'dlt-receive'), WOC_DLT_RETRY_MS: '600000',
        WOC_REBOOT_CMD: path.join(bin, 'reboot'), WOC_REMOUNT_LOCK: path.join(d, 'sock/lock'),
        WOC_NAVMD_ANCHOR_FILE: path.join(d, 'anchor')
    });
    if (anchored) {
        fs.writeFileSync(env.WOC_NAVMD_ANCHOR_FILE, 'forwardToHmi\n', { mode: 0o600 });
        fs.chmodSync(env.WOC_NAVMD_ANCHOR_FILE, 0o600);
    }
    w.env = env;
    return w;
}
async function start(w) {
    w.child = cp.spawn(process.execPath, [patchd], { cwd: w.dir, env: w.env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    w.child.on('error', function (e) { w.spawnError = e; });
    w.child.stderr.on('data', function (b) { w.stderr += b.toString(); });
    await until('daemon socket', function () { return fs.existsSync(w.sock); }, w);
    w.control = new Control({ patchPath: w.sock, renderPath: path.join(w.dir, 'missing-render.sock'),
        pendingPath: path.join(w.dir, 'sock/activation-pending'), retryMs: 100 });
    // Observe bytes actually written to the real daemon socket, not a fake send.
    w.control.patch.on('connect', function () {
        var socket = w.control.patch._socket, write = socket.write;
        socket.write = function (data) {
            String(data).split('\n').filter(Boolean).forEach(function (line) { w.sent.push(JSON.parse(line)); });
            return write.apply(socket, arguments);
        };
    });
    w.control.on('change', function () {
        var s = w.control.patchStatus;
        if (s) w.statuses.push(JSON.parse(JSON.stringify(s)));
    });
    w.control.open();
    await until('initial status', function () { return w.control.connectedPatch() && w.control.patchStatus && w.control.patchStatus.state !== 'busy'; }, w);
}
function nav(w) { return fs.readFileSync(w.target).toString('hex', fixture.at.navmdCall, fixture.at.navmdCall + 5); }
function assertSafe(w) {
    fs.readFileSync(w.calls, 'utf8').split('\n').filter(Boolean).forEach(function (line) {
        assert(/^mount -o remount,(rw|ro) \/$/.test(line) || /^systemctl (show|is-system-running)\b/.test(line), 'unexpected operation: ' + line);
    });
    assert(/\/ ext4 ro /.test(fs.readFileSync(w.mounts, 'utf8')), 'fixture root left writable');
}
async function cleanup(w) {
    try {
        if (w.control) w.control.close();
        // Kill the dedicated daemon process group as well as the daemon itself,
        // including a patcher or fake command if a timeout interrupted an apply.
        if (w.child && w.child.pid) {
            var stopped = w.child.exitCode !== null || w.child.signalCode !== null;
            var exited = stopped ? Promise.resolve() : new Promise(function (resolve, reject) {
                var timer = setTimeout(function () { reject(new Error('daemon did not exit on SIGKILL')); }, 3000);
                w.child.once('exit', function () { clearTimeout(timer); resolve(); });
            });
            try { process.kill(-w.child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
            await exited;
        }
        assertSafe(w);
    } finally { remove(w.dir); }
}
async function boot(w, expectedNav, expectedState) {
    // Simulate a head-unit start: discard pending marker and running inode,
    // then reconnect so the unchanged daemon reports the current disk state.
    w.control.close();
    remove(path.join(w.dir, 'sock/activation-pending'));
    remove(w.target + '.woc-running');
    remove(path.join(w.dir, 'proc/1234'));
    w.control.open();
    await until('post-start status', function () {
        var s = w.control.patchStatus;
        return s && s.state === expectedState && s.navmd && s.navmd.state === expectedNav && !w.control.pending();
    }, w);
}
function operations(w) { return w.sent.filter(function (m) { return m.cmd === 'apply' || m.cmd === 'revert'; }); }
function checkPending(w, navState) {
    var c = w.control;
    assert.strictEqual(c.patchStatus.navmd.state, navState);
    assert.strictEqual(c.pending(), 'apply');
    assert(c.restartNeeded());
    assert(/pending|restart|reboot/i.test(c.statusText()), c.statusText());
    assert(/reboot needed/i.test(c.navmdStatusText()));
    assert(!c.canToggleNavmd() && !c.canEnable() && !c.canDisable(), 'pending operation must gate controls');
    var n = operations(w).length;
    c.toggleNavmd(); c.enableMap(); c.disableMap();
    assert.strictEqual(operations(w).length, n, 'gated interactions wrote requests');
}
async function lifecycle() {
    var w = create(true);
    try {
        await start(w);
        var c = w.control;
        assert.strictEqual(c.patchStatus.state, 'original');
        assert.strictEqual(c.patchStatus.navmd.state, 'off');
        assert(c.canToggleNavmd() && c.canEnable());
        var before = fs.readFileSync(w.target), calls = fs.readFileSync(w.calls, 'utf8');
        c.toggleNavmd();
        assert(/On — not applied/.test(c.navmdText()));
        await sleep(200);
        assert(fs.readFileSync(w.target).equals(before), 'staging changed target');
        assert.strictEqual(fs.readFileSync(w.calls, 'utf8'), calls, 'staging invoked system operations');
        assert.deepStrictEqual(operations(w), [], 'staging sent a patch request');
        assert(!fs.existsSync(w.target + '.woc-orig'), 'staging created backup');
        c.enableMap();
        assert.deepStrictEqual(operations(w), [{ cmd: 'apply', panel: 'high', mode: 'avb', navmd: true }]);
        await until('on applied and deferred', function () { return c.pending() === 'apply' && c.patchStatus.navmd && c.patchStatus.navmd.state === 'on'; }, w);
        assert(w.statuses.some(function (s) { return s.state === 'busy'; }), 'daemon did not acknowledge apply as busy');
        assert.strictEqual(nav(w), fixture.at.navmdPatched);
        assert(fs.readFileSync(w.target + '.woc-orig').equals(original));
        var on = fs.readFileSync(w.target);
        assert(!on.equals(original));
        checkPending(w, 'on');
        assert(/not applied.*reboot needed/.test(c.navmdText()));
        await boot(w, 'on', 'patched');
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: On');
        assert(c.canToggleNavmd());
        calls = fs.readFileSync(w.calls, 'utf8');
        c.toggleNavmd();
        assert(/Off — not applied/.test(c.navmdText()));
        await sleep(200);
        assert(fs.readFileSync(w.target).equals(on), 'staged Off changed target');
        assert.strictEqual(fs.readFileSync(w.calls, 'utf8'), calls, 'staged Off invoked system operations');
        assert.strictEqual(operations(w).length, 1, 'staged Off sent a patch request');
        assert(c.canEnable());
        assert.strictEqual(c.enableButtonText(), 'Apply settings');
        c.enableMap();
        assert.deepStrictEqual(operations(w)[1], { cmd: 'apply', panel: 'high', mode: 'avb', navmd: false });
        await until('off applied and deferred', function () { return c.pending() === 'apply' && c.patchStatus.navmd && c.patchStatus.navmd.state === 'off'; }, w);
        assert.strictEqual(nav(w), fixture.at.navmdOriginal);
        var expectedCore = Buffer.from(on);
        original.copy(expectedCore, fixture.at.navmdCall, fixture.at.navmdCall, fixture.at.navmdCall + 5);
        assert(fs.readFileSync(w.target).equals(expectedCore), 'Off changed bytes outside navmd');
        assert(!expectedCore.equals(original), 'core patch unexpectedly removed');
        checkPending(w, 'off');
        await boot(w, 'off', 'patched');
        assert.strictEqual(c.navmdText(), 'Suppress native guidance: Off');
        assert(c.canDisable(), 'core map should remain enabled');
        c.disableMap();
        assert.deepStrictEqual(operations(w)[2], { cmd: 'revert' });
        await until('revert deferred', function () { return c.pending() === 'revert'; }, w);
        assert(fs.readFileSync(w.target).equals(original), 'disable did not restore every tracked region');
        assert(c.restartNeeded() && !c.canEnable() && !c.canDisable() && !c.canToggleNavmd());
        await boot(w, 'off', 'original');
        assert(c.canEnable());
    } finally { await cleanup(w); }
}
async function unavailable() {
    var w = create(false);
    try {
        await start(w);
        var c = w.control;
        assert.strictEqual(c.patchStatus.navmd.state, 'unavailable');
        assert(c.navmdStatusText().indexOf('Unavailable') >= 0);
        assert(!c.canToggleNavmd() && c.canEnable());
        c.toggleNavmd();
        assert.deepStrictEqual(operations(w), []);
        c.enableMap();
        assert.deepStrictEqual(operations(w), [{ cmd: 'apply', panel: 'high', mode: 'avb' }]);
        await until('legacy map apply deferred', function () { return c.pending() === 'apply'; }, w);
        assert(!fs.readFileSync(w.target).equals(original), 'map not patched');
        assert.strictEqual(nav(w), fixture.at.navmdOriginal, 'unavailable option modified navmd');
        await boot(w, 'unavailable', 'patched');
        assert(c.canDisable());
    } finally { await cleanup(w); }
}
(async function () {
    var failed = 0;
    for (var t of [{ name: 'real UI / daemon / patcher lifecycle', run: lifecycle },
        { name: 'unavailable option permits core map', run: unavailable }]) {
        try { await t.run(); console.log('ok   ' + t.name); }
        catch (e) { failed++; console.error('FAIL ' + t.name + '\n' + (e.stack || e)); }
    }
    process.exitCode = failed ? 1 : 0;
})().catch(function (e) { console.error(e.stack || e); process.exitCode = 1; });
