#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* End-to-end daemon/real-patcher regressions for the optional navmd edit.
 * No vehicle binary or privileged operation is used. Run with Node 8:
 *   node patch/test/patchd_navmd_test.js
 * Every service, mount, proc and socket path belongs to a disposable fixture.
 */
var assert = require('assert');
var fs = require('fs');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var synthetic = require('./synthetic_carplay.js');
var fixture = synthetic.build();
var patchDir = path.resolve(__dirname, '..');
var patchd = path.join(patchDir, 'patchd.js');
var cli = path.join(patchDir, 'carplay_patch.js');
var tests = [];
var anchor = 'forwardToHmi';
var original = fixture.buf;
var call = fixture.at.navmdCall;

function test(name, fn) { tests.push({ name: name, fn: fn }); }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function unlink(p) { try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function rm(p) {
    var st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (!st.isDirectory() || st.isSymbolicLink()) { fs.unlinkSync(p); return; }
    fs.readdirSync(p).forEach(function (n) { rm(path.join(p, n)); });
    fs.rmdirSync(p);
}
function quote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
function executable(p, body) { fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n', { mode: 0o755 }); fs.chmodSync(p, 0o755); }
function navBytes(w) { return fs.readFileSync(w.target).toString('hex', call, call + 5); }
function checkNav(status, state) {
    assert(status && status.navmd && typeof status.navmd === 'object', 'missing navmd in ' + JSON.stringify(status));
    assert.strictEqual(status.navmd.state, state, JSON.stringify(status));
}
function diagnostic(s) {
    assert(s && s.navmd && (s.navmd.state === 'unknown' || s.navmd.state === 'unavailable'), JSON.stringify(s));
    assert.strictEqual(typeof s.navmd.reason, 'string', JSON.stringify(s));
    assert(s.navmd.reason.length > 0, JSON.stringify(s));
}
function newFixture() {
    // Keep Unix socket paths short even on systems with a long TMPDIR.
    var d = fs.mkdtempSync('/tmp/woc-nd-');
    ['bin', 'proc', 'units', 'sock'].forEach(function (n) { fs.mkdirSync(path.join(d, n)); });
    var w = { dir: d, target: path.join(d, 'carplay'), sock: path.join(d, 'sock', 'p.sock'),
        calls: path.join(d, 'calls'), mounts: path.join(d, 'mounts'), child: null, stderr: '' };
    fs.writeFileSync(w.target, original);
    fs.writeFileSync(w.calls, '');
    fs.writeFileSync(w.mounts, '/dev/root / ext4 ro 0 0\n');
    fs.writeFileSync(path.join(d, 'recmgr'), '');
    fs.writeFileSync(path.join(d, 'stat'), 'cpu 1 2 3\nbtime 1\n');
    fs.writeFileSync(path.join(d, 'bootid'), 'synthetic-boot\n');
    var bin = path.join(d, 'bin');
    executable(path.join(bin, 'mount'), 'echo "mount $*" >> ' + quote(w.calls) + '\n' +
        'case "$*" in "-o remount,rw /") m=rw ;; "-o remount,ro /") m=ro ;; *) exit 91 ;; esac\n' +
        'printf "/dev/root / ext4 %s 0 0\\n" "$m" > ' + quote(w.mounts));
    executable(path.join(bin, 'systemctl'), 'echo "systemctl $*" >> ' + quote(w.calls) + '\n' +
        'case "$1" in show) printf "MainPID=0\\nActiveState=inactive\\nResult=success\\nInvocationID=\\n" ;; ' +
        'is-system-running) echo running ;; *) exit 92 ;; esac');
    ['reboot', 'kill'].forEach(function (n) { executable(path.join(bin, n), 'echo "' + n + ' $*" >> ' + quote(w.calls) + '\nexit 93'); });
    executable(path.join(bin, 'journalctl'), 'exit 0');
    executable(path.join(bin, 'dlt-receive'), 'exit 0');
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
        WOC_REBOOT_CMD: path.join(bin, 'reboot'), WOC_REMOUNT_LOCK: path.join(d, 'sock', 'lock'),
        WOC_NAVMD_ANCHOR_FILE: path.join(d, 'anchor')
    });
    w.env = env;
    return w;
}
function runCli(w, args, overrides) {
    var env = Object.assign({}, w.env, overrides || {});
    var r = cp.spawnSync(process.execPath, [cli].concat(args), { env: env, cwd: w.dir, encoding: 'utf8', timeout: 20000 });
    assert.ifError(r.error);
    assert.strictEqual(r.status, 0, r.stdout + '\n' + r.stderr);
    return r;
}
function start(w) {
    w.child = cp.spawn(process.execPath, [patchd], { cwd: w.dir, env: w.env, stdio: ['ignore', 'ignore', 'pipe'] });
    w.child.stderr.on('data', function (b) { w.stderr += b.toString(); });
    return waitSocket(w);
}
async function waitSocket(w) {
    for (var i = 0; i < 200; i++) {
        if (w.child.exitCode !== null) throw new Error('patchd exited: ' + w.stderr);
        if (fs.existsSync(w.sock)) return;
        await sleep(25);
    }
    throw new Error('patchd socket timeout: ' + w.stderr);
}
function stop(w) {
    if (!w.child || w.child.exitCode !== null || w.child.signalCode !== null) return Promise.resolve();
    return new Promise(function (resolve) { w.child.once('exit', resolve); w.child.kill('SIGKILL'); });
}
// The daemon broadcasts an initial status and busy/final operation statuses.
function request(w, command) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(w.sock), buffer = '', sent = !command, busy = false, done = false;
        var timer = setTimeout(function () { finish(new Error('socket timeout for ' + JSON.stringify(command) + ': ' + w.stderr)); }, 15000);
        function finish(err, value) {
            if (done) return;
            done = true; clearTimeout(timer); c.destroy();
            if (err) reject(err); else resolve(value);
        }
        c.setEncoding('utf8');
        c.on('error', function (e) { finish(e); });
        c.on('data', function (chunk) {
            buffer += chunk;
            var i;
            while ((i = buffer.indexOf('\n')) !== -1) {
                var line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
                var m;
                try { m = JSON.parse(line); } catch (e) { finish(e); return; }
                if (m.ev !== 'status') continue;
                if (!sent) { sent = true; c.write(JSON.stringify(command) + '\n'); continue; }
                if (!command) { if (m.state !== 'busy') finish(null, m); }
                else if (m.state === 'busy') busy = true;
                else if (m.state === 'error' || busy) finish(null, m);
                if (done) return;
            }
        });
    });
}
function operation(w, navmd) {
    var m = { cmd: 'apply', panel: 'high', mode: 'avb' };
    if (arguments.length > 1) m.navmd = navmd;
    return request(w, m);
}
function boot(w) {
    // Model the next head-unit start: the old process and its retained inode
    // are gone and the on-disk binary is what the new process will execute.
    unlink(path.join(w.dir, 'sock', 'activation-pending'));
    unlink(w.target + '.woc-running');
    rm(path.join(w.dir, 'proc', '1234'));
}
function checkNoDanger(w) {
    var lines = fs.readFileSync(w.calls, 'utf8').trim().split('\n').filter(Boolean);
    lines.forEach(function (line) {
        assert(/^mount -o remount,(rw|ro) \/$/.test(line) || /^systemctl (show|is-system-running)\b/.test(line), 'unexpected service/mount call: ' + line);
    });
    assert(/\/ ext4 ro /.test(fs.readFileSync(w.mounts, 'utf8')), 'fixture root left writable');
}
async function sandbox(fn) {
    var w = newFixture();
    try { await fn(w); }
    finally {
        try { checkNoDanger(w); }
        finally { await stop(w); rm(w.dir); }
    }
}
function assertBackup(w) {
    assert(fs.readFileSync(w.target + '.woc-orig').equals(original), 'backup differs from pristine ELF');
    assert(fs.existsSync(w.target + '.woc-orig.json'), 'missing backup identity metadata');
}
function noWrite(w, before) {
    assert(fs.readFileSync(w.target).equals(before), 'target changed on rejected request');
    assert(!fs.existsSync(w.target + '.woc-orig'), 'rejected request created a backup');
    assert(!fs.existsSync(w.target + '.woc-orig.json'), 'rejected request created backup metadata');
}

test('env anchor: legacy apply, explicit on/off, full revert and idempotence', async function () {
    await sandbox(async function (w) {
        w.env.WOC_NAVMD_ANCHOR = anchor;
        await start(w);
        checkNav(await request(w), 'off');
        var r = await operation(w);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal, 'legacy apply opted into navmd');
        assertBackup(w);
        assert(!JSON.parse(fs.readFileSync(w.target + '.woc-orig.json', 'utf8')).navmd, 'legacy apply recorded navmd identity');
        boot(w);
        var st = await request(w); checkNav(st, 'off'); assert.strictEqual(st.state, 'patched', JSON.stringify(st));
        var core = fs.readFileSync(w.target);
        assert(!core.equals(original), 'core edits absent');
        r = await operation(w, true);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdPatched);
        assert(r.pending || r.carplay === 'deferred', 'expected a deferred activation: ' + JSON.stringify(r));
        boot(w);
        st = await request(w); checkNav(st, 'on'); assert.strictEqual(st.state, 'patched', JSON.stringify(st));
        var on = fs.readFileSync(w.target);
        assert(JSON.parse(fs.readFileSync(w.target + '.woc-orig.json', 'utf8')).navmd, 'opt-in did not persist identity');
        r = await operation(w); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert(fs.readFileSync(w.target).equals(on), 'legacy apply must preserve an existing navmd opt-in');
        r = await operation(w, true); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert(fs.readFileSync(w.target).equals(on), 'repeat on changed bytes');
        // Non-edit byte changed by an unrelated party must survive both operations.
        var external = Buffer.from(on), outside = external.length - 1;
        external[outside] ^= 0x5a; fs.writeFileSync(w.target, external);
        r = await operation(w, false); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        var expected = Buffer.from(core); expected[outside] = external[outside];
        assert(fs.readFileSync(w.target).equals(expected), 'off must restore only Edit5 and preserve core and unrelated bytes');
        boot(w);
        st = await request(w); checkNav(st, 'off'); assert.strictEqual(st.state, 'patched', JSON.stringify(st));
        r = await operation(w, false); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert(fs.readFileSync(w.target).equals(expected), 'repeat off changed bytes');
        r = await request(w, { cmd: 'revert' }); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        expected = Buffer.from(original); expected[outside] = external[outside];
        assert(fs.readFileSync(w.target).equals(expected), 'map disable must restore all owned edits and preserve unrelated bytes');
        assertBackup(w);
        boot(w);
        st = await request(w); checkNav(st, 'off'); assert.strictEqual(st.state, 'original', JSON.stringify(st));
        r = await request(w, { cmd: 'revert' }); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert(fs.readFileSync(w.target).equals(expected), 'repeat revert changed bytes');
    });
});

test('pending enable reports disk on and explicitly deferred activation', async function () {
    await sandbox(async function (w) {
        w.env.WOC_NAVMD_ANCHOR = anchor;
        await start(w);
        var r = await operation(w, true);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdPatched, 'pending enable did not patch disk');
        checkNav(r, 'on');
        assert.strictEqual(r.carplay, 'deferred', JSON.stringify(r));
        assert.strictEqual(r.pending, 'apply', JSON.stringify(r));
        var s = await request(w);
        checkNav(s, 'on');
        assert.strictEqual(s.carplay, 'deferred', JSON.stringify(s));
        assert.strictEqual(s.pending, 'apply', JSON.stringify(s));
    });
});

test('pending disable reports disk off and explicitly deferred activation', async function () {
    await sandbox(async function (w) {
        w.env.WOC_NAVMD_ANCHOR = anchor;
        await start(w);
        var r = await operation(w, true);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        boot(w); checkNav(await request(w), 'on');
        r = await operation(w, false);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal, 'pending disable did not restore disk');
        checkNav(r, 'off');
        assert.strictEqual(r.carplay, 'deferred', JSON.stringify(r));
        assert.strictEqual(r.pending, 'apply', JSON.stringify(r));
        var s = await request(w);
        checkNav(s, 'off');
        assert.strictEqual(s.carplay, 'deferred', JSON.stringify(s));
        assert.strictEqual(s.pending, 'apply', JSON.stringify(s));
    });
});

test('trusted file identity survives file removal', async function () {
    await sandbox(async function (w) {
        fs.writeFileSync(w.env.WOC_NAVMD_ANCHOR_FILE, anchor + '\n', { mode: 0o600 });
        fs.chmodSync(w.env.WOC_NAVMD_ANCHOR_FILE, 0o600);
        assert.strictEqual(fs.statSync(w.env.WOC_NAVMD_ANCHOR_FILE).uid, process.getuid());
        await start(w); checkNav(await request(w), 'off');
        var r = await operation(w, true); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdPatched); assertBackup(w);
        boot(w); checkNav(await request(w), 'on');
        fs.unlinkSync(w.env.WOC_NAVMD_ANCHOR_FILE);
        checkNav(await request(w), 'on');
        r = await operation(w, false); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal);
        boot(w); checkNav(await request(w), 'off');
        r = await operation(w, true); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert.strictEqual(navBytes(w), fixture.at.navmdPatched);
        boot(w); checkNav(await request(w), 'on');
        r = await request(w, { cmd: 'revert' }); assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assert(fs.readFileSync(w.target).equals(original), 'anchorless revert did not fully restore');
    });
});

test('no configured anchor still permits legacy core apply', async function () {
    await sandbox(async function (w) {
        await start(w); checkNav(await request(w), 'unavailable');
        var r = await operation(w);
        assert.notStrictEqual(r.state, 'error', JSON.stringify(r));
        assertBackup(w);
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal);
        assert(!fs.readFileSync(w.target).equals(original), 'legacy core apply did not patch');
        boot(w);
        var s = await request(w); checkNav(s, 'unavailable');
        assert.strictEqual(s.state, 'patched', JSON.stringify(s));
    });
});

test('no configured anchor is unavailable; JSON anchor cannot grant trust', async function () {
    await sandbox(async function (w) {
        await start(w); checkNav(await request(w), 'unavailable');
        var r = await request(w, { cmd: 'apply', panel: 'high', mode: 'avb', navmd: true, anchor: anchor, navmdAnchor: anchor });
        assert.strictEqual(r.state, 'error', 'untrusted JSON anchor must not enable navmd: ' + JSON.stringify(r));
        noWrite(w, original);
        checkNav(await request(w), 'unavailable');
    });
});

['symlink', 'world-writable', 'group-writable', 'bad-anchor', 'bad-env-anchor'].forEach(function (kind) {
    test('invalid ' + kind + ' fails closed before patching', async function () {
        await sandbox(async function (w) {
            var file = w.env.WOC_NAVMD_ANCHOR_FILE;
            if (kind === 'bad-env-anchor') {
                w.env.WOC_NAVMD_ANCHOR = 'noSuchTrustedAnchor';
            } else if (kind === 'symlink') {
                fs.writeFileSync(path.join(w.dir, 'real-anchor'), anchor + '\n', { mode: 0o600 });
                fs.symlinkSync(path.join(w.dir, 'real-anchor'), file);
            } else {
                fs.writeFileSync(file, (kind === 'bad-anchor' ? 'noSuchTrustedAnchor' : anchor) + '\n', { mode: 0o600 });
                fs.chmodSync(file, kind === 'world-writable' ? 0o666 : kind === 'group-writable' ? 0o620 : 0o600);
            }
            await start(w); diagnostic(await request(w));
            var r = await operation(w, true);
            assert.strictEqual(r.state, 'error', JSON.stringify(r));
            noWrite(w, original);
            diagnostic(await request(w));
        });
    });
});

test('nonboolean navmd values are rejected before writes', async function () {
    await sandbox(async function (w) {
        w.env.WOC_NAVMD_ANCHOR = anchor;
        await start(w);
        var values = ['true', 1, null, {}, []];
        for (var i = 0; i < values.length; i++) {
            var r = await operation(w, values[i]);
            assert.strictEqual(r.state, 'error', 'accepted ' + JSON.stringify(values[i]) + ': ' + JSON.stringify(r));
            noWrite(w, original);
        }
    });
});

test('install activation with configured env does not opt in', async function () {
    await sandbox(async function (w) {
        // The synthetic build is unproven. A user-approved CLI seed creates a
        // real backup so the install hook can safely revisit the core patch.
        runCli(w, ['apply', '--target', w.target, '--panel', 'high', '--unproven', '--yes']);
        assertBackup(w);
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal);
        w.env.WOC_NAVMD_ANCHOR = anchor;
        var r = cp.spawnSync(process.execPath, [patchd, 'activate'], { env: w.env, cwd: w.dir, encoding: 'utf8', timeout: 30000 });
        assert.ifError(r.error); assert.strictEqual(r.status, 0, r.stdout + '\n' + r.stderr);
        assert(/mount -o remount,rw \/\n/.test(fs.readFileSync(w.calls, 'utf8')), 'install hook skipped core apply');
        assert.strictEqual(navBytes(w), fixture.at.navmdOriginal, 'install hook opted into navmd');
        boot(w);
        await start(w);
        var s = await request(w); checkNav(s, 'off'); assert.strictEqual(s.state, 'patched', JSON.stringify(s));
    });
});

(async function () {
    var fails = 0;
    for (var i = 0; i < tests.length; i++) {
        try { await tests[i].fn(); process.stdout.write('ok   ' + tests[i].name + '\n'); }
        catch (e) { fails++; process.stderr.write('FAIL ' + tests[i].name + '\n' + (e.stack || e) + '\n'); }
    }
    process.stdout.write((tests.length - fails) + '/' + tests.length + ' passed\n');
    if (fails) process.exitCode = 1;
})().catch(function (e) { process.stderr.write((e.stack || e) + '\n'); process.exitCode = 1; });
