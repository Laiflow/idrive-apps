// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Production lifecycle regressions, using only the synthetic ELF and temp files.
 * Runs the real CLI, patchd deactivate, recovery boot and shell revert. No
 * CARPLAY_BIN, car, root, services or dependencies required; Node 8 compatible.
 *
 *   node patch/test/navmd_lifecycle_test.js
 *
 * Based on /tmp/pr23-navmd-production-xaQMlM/repro.js and its evidence: an
 * anchorless rollback used to leave Edit 5 behind yet delete the backup or
 * clear the boot failure count. The seed explicitly requests navmd; every
 * production rollback must rediscover it using persisted identity alone.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var fixture = require('./synthetic_carplay.js').build();
var PATCH = path.resolve(__dirname, '..');
var TIMEOUT_MS = 20000;
var tests = [];

function test(name, fn) { tests.push({ name: name, fn: fn }); }
function removeTree(p) {
    var st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) { fs.unlinkSync(p); return; }
    fs.readdirSync(p).forEach(function (n) { removeTree(path.join(p, n)); });
    fs.rmdirSync(p);
}
function executable(p, text) { fs.writeFileSync(p, text); fs.chmodSync(p, 0o755); }
function shQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

/* Observe the real subprocesses without faking their patch/classify/restore.
 * Record the complete target bytes BEFORE backup unlink and AFTER state writes,
 * so final-state checks cannot hide premature deletion or counter clearing.
 */
function observer() {
    var fs = require('fs');
    var env = process.env;
    var unlink = fs.unlinkSync;
    var write = fs.writeFileSync;
    var rename = fs.renameSync;
    function record(kind, file) {
        var state = null;
        try { state = JSON.parse(fs.readFileSync(env.WOC_RECOVERY_STATE, 'utf8')); } catch (e) {}
        fs.appendFileSync(env.WOC_TEST_EVENTS, JSON.stringify({
            kind: kind, file: String(file),
            bytes: fs.readFileSync(env.WOC_CARPLAY).toString('hex'),
            backup: fs.existsSync(env.WOC_CARPLAY + '.woc-orig'),
            state: state
        }) + '\n');
    }
    fs.unlinkSync = function (file) {
        if (String(file) === env.WOC_CARPLAY + '.woc-orig' ||
            String(file) === env.WOC_CARPLAY + '.woc-orig.json') record('drop', file);
        return unlink.apply(fs, arguments);
    };
    fs.writeFileSync = function (file) {
        var result = write.apply(fs, arguments);
        if (String(file) === env.WOC_RECOVERY_STATE) record('state', file);
        return result;
    };
    fs.renameSync = function (src, dest) {
        var result = rename.apply(fs, arguments);
        if (String(dest) === env.WOC_RECOVERY_STATE) record('state', dest);
        return result;
    };
}

function sandbox(fn) {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-navmd-lifecycle-'));
    try {
        var env = {};
        Object.keys(process.env).forEach(function (k) {
            if (!/^WOC_/.test(k) && k !== 'CARPLAY_BIN' && k !== 'NODE_OPTIONS') env[k] = process.env[k];
        });
        ['bin', 'shm', 'proc', 'units'].forEach(function (n) { fs.mkdirSync(path.join(dir, n)); });
        var target = path.join(dir, 'carplay');
        var calls = path.join(dir, 'calls');
        var mounts = path.join(dir, 'mounts');
        var bin = path.join(dir, 'bin');
        var hook = path.join(dir, 'observe.js');
        fs.writeFileSync(target, fixture.buf);
        fs.writeFileSync(mounts, '/dev/root / ext4 ro 0 0\n');
        fs.writeFileSync(path.join(dir, 'stat'), 'cpu 1 2 3\nbtime 1\n');
        fs.writeFileSync(path.join(dir, 'recmgr'), '');
        fs.writeFileSync(path.join(dir, 'bootid'), 'navmd-test-boot\n');
        fs.writeFileSync(hook, '(' + observer.toString() + ')();\n');
        executable(path.join(bin, 'mount'), '#!/bin/sh\n' +
            'printf "mount %s\\n" "$*" >> ' + shQuote(calls) + '\n' +
            'case "$*" in "-o remount,rw /") mode=rw ;; "-o remount,ro /") mode=ro ;; *) exit 91 ;; esac\n' +
            '[ "$mode" != rw ] || [ "${WOC_TEST_FAIL_RW:-0}" != 1 ] || exit 94\n' +
            'printf "/dev/root / ext4 %s 0 0\\n" "$mode" > ' + shQuote(mounts) + '\n');
        executable(path.join(bin, 'systemctl'), '#!/bin/sh\n' +
            'printf "systemctl %s\\n" "$*" >> ' + shQuote(calls) + '\n' +
            'case "$1" in show) printf "MainPID=0\\nActiveState=inactive\\nResult=success\\nInvocationID=\\n" ;; ' +
            'is-system-running) echo running ;; *) exit 92 ;; esac\n');
        ['kill', 'reboot', 'sync'].forEach(function (n) {
            executable(path.join(bin, n), '#!/bin/sh\nprintf "' + n + ' %s\\n" "$*" >> ' + shQuote(calls) +
                '\nexit ' + (n === 'sync' ? '0' : '93') + '\n');
        });
        /* The wrapper resolves node/mount through PATH; force our runtime and
         * fake mount rather than whichever host commands happen to be installed.
         */
        fs.symlinkSync(process.execPath, path.join(bin, 'node'));
        Object.assign(env, {
            PATH: bin + path.delimiter + (env.PATH || '/usr/bin:/bin'),
            NODE_OPTIONS: '--require ' + hook,
            WOC_CARPLAY: target, WOC_MOUNT: path.join(bin, 'mount'), WOC_PROC_MOUNTS: mounts,
            WOC_PROC: path.join(dir, 'proc'), WOC_PATCH_SOCK: path.join(dir, 'shm', 'patch.sock'),
            WOC_REMOUNT_LOCK: path.join(dir, 'shm', 'remount.lock'),
            WOC_RECMGR_CONF: path.join(dir, 'recmgr'), WOC_RECMGR_AT_BOOT: path.join(dir, 'recmgr-at-boot'),
            WOC_PROC_STAT: path.join(dir, 'stat'), WOC_BOOT_ID: path.join(dir, 'bootid'),
            WOC_UNIT_DIRS: path.join(dir, 'units'), WOC_FIFO: path.join(dir, 'shm', 'alt.h264'),
            WOC_CAPTURE_SOCK: path.join(dir, 'shm', 'capture.sock'),
            WOC_RECOVERY_STATE: path.join(dir, 'recovery.json'), WOC_RECOVERY_THRESHOLD: '2',
            WOC_SYSTEMCTL: path.join(bin, 'systemctl'), WOC_TEST_EVENTS: path.join(dir, 'events')
        });
        var w = { dir: dir, target: target, env: env, calls: calls, mounts: mounts };
        fn(w);
    } finally { removeTree(dir); }
}
function run(w, program, args) {
    assert.strictEqual(w.env.WOC_NAVMD_ANCHOR, undefined, 'production rollback must not inherit an anchor');
    var r = cp.spawnSync(program, args, {
        env: w.env, cwd: w.dir, encoding: 'utf8', timeout: TIMEOUT_MS,
        killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
    });
    assert.ifError(r.error);
    assert.strictEqual(r.signal, null, 'entry point killed: ' + r.stderr);
    return r;
}
function successful(r) {
    assert.strictEqual(r.status, 0, 'entry point failed:\n' + r.stdout + '\n' + r.stderr);
}
function seed(w) {
    /* Even an inherited anchor is removed: apply gets an explicit CLI option,
     * and production rollback gets neither the option nor the env fallback.
     */
    delete w.env.WOC_NAVMD_ANCHOR;
    successful(run(w, process.execPath, [path.join(PATCH, 'carplay_patch.js'), 'apply',
        '--target', w.target, '--panel', 'high', '--unproven', '--navmd', 'GuidanceMetadata', '--yes']));
    delete w.env.WOC_NAVMD_ANCHOR;   // no anchor may reach production entry points
    assert.strictEqual(fs.readFileSync(w.target).toString('hex', fixture.at.navmdCall, fixture.at.navmdCall + 5),
        fixture.at.navmdPatched, 'seed must actually drop navmd');
    assert(fs.readFileSync(w.target + '.woc-orig').equals(fixture.buf), 'seed backup must be byte-exact');
    assert(fs.existsSync(w.target + '.woc-orig.json'), 'seed must persist backup metadata');
    fs.writeFileSync(w.env.WOC_TEST_EVENTS, '');
}
function events(w) {
    return fs.readFileSync(w.env.WOC_TEST_EVENTS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}
function restored(w) {
    assert(fs.readFileSync(w.target).equals(fixture.buf), 'must restore every byte, including navmd');
    assert.strictEqual(fs.readFileSync(w.target).toString('hex', fixture.at.navmdCall, fixture.at.navmdCall + 5),
        fixture.at.navmdOriginal, 'navmd must forward to the original HMI handler');
}
function safeSystem(w, remounted) {
    var calls = fs.existsSync(w.calls) ? fs.readFileSync(w.calls, 'utf8') : '';
    assert(!/^(?:kill|reboot) |^systemctl (?:start|stop|restart|reboot)\b/m.test(calls),
        'install-time rollback must not signal a process or change a service: ' + calls);
    assert.strictEqual(fs.readFileSync(w.mounts, 'utf8'), '/dev/root / ext4 ro 0 0\n', 'fake root must finish read-only');
    if (remounted) {
        assert(calls.indexOf('mount -o remount,rw /') !== -1, 'real write window must use fake mount');
        assert(calls.indexOf('mount -o remount,ro /') !== -1, 'real write window must close');
    }
}

test('patchd deactivate restores navmd before dropping BOTH backup files', function () {
    sandbox(function (w) {
        seed(w);
        successful(run(w, process.execPath, [path.join(PATCH, 'patchd.js'), 'deactivate']));
        restored(w);
        var drops = events(w).filter(function (e) { return e.kind === 'drop'; });
        assert.strictEqual(drops.length, 2, 'observe both real backup deletions');
        drops.forEach(function (e) { assert.strictEqual(e.bytes, fixture.buf.toString('hex'), 'backup deleted before full restoration'); });
        assert(!fs.existsSync(w.target + '.woc-orig'), 'deactivate must drop restored backup');
        assert(!fs.existsSync(w.target + '.woc-orig.json'), 'deactivate must drop restored metadata');
        safeSystem(w, true);
    });
});

test('recovery boot at threshold restores navmd BEFORE resetting failure count', function () {
    sandbox(function (w) {
        seed(w);
        fs.writeFileSync(w.env.WOC_RECOVERY_STATE, JSON.stringify({ fails: 2, arm: null }));
        successful(run(w, process.execPath, [path.join(PATCH, 'recovery.js'), 'boot']));
        restored(w);
        assert.strictEqual(JSON.parse(fs.readFileSync(w.env.WOC_RECOVERY_STATE, 'utf8')).fails, 0);
        var clears = events(w).filter(function (e) { return e.kind === 'state' && e.state && e.state.fails === 0; });
        assert(clears.length > 0, 'observe a real recovery counter reset');
        clears.forEach(function (e) {
            assert.strictEqual(e.bytes, fixture.buf.toString('hex'), 'counter reset before full restoration');
            assert(e.backup, 'recovery must retain its verified backup');
        });
        assert(fs.readFileSync(w.target + '.woc-orig').equals(fixture.buf));
        assert(fs.existsSync(w.target + '.woc-orig.json'));
        safeSystem(w, true);
    });
});

test('shell wrapper revert restores every byte without an anchor', function () {
    sandbox(function (w) {
        seed(w);
        successful(run(w, '/bin/sh', [path.join(PATCH, 'woc-patch.sh'), 'revert']));
        restored(w);
        assert(fs.readFileSync(w.target + '.woc-orig').equals(fixture.buf), 'manual revert retains backup');
        assert(fs.existsSync(w.target + '.woc-orig.json'));
        assert.strictEqual(events(w).filter(function (e) { return e.kind === 'drop'; }).length, 0);
        safeSystem(w, true);
    });
});

/* Failed restoration must not make success bookkeeping irreversible. Fail
 * the fake writable remount, after classification finds a restorable patch.
 */
['deactivate', 'boot'].forEach(function (mode) {
    test(mode + ' keeps backups and failure count when restoration cannot remount', function () {
        sandbox(function (w) {
            seed(w);
            var patched = fs.readFileSync(w.target);
            w.env.WOC_TEST_FAIL_RW = '1';
            fs.writeFileSync(w.env.WOC_RECOVERY_STATE, JSON.stringify({ fails: 2, arm: null }));
            var r = run(w, process.execPath, [path.join(PATCH, mode === 'boot' ? 'recovery.js' : 'patchd.js'), mode]);
            /* Boot intentionally exits zero even when recovery is refused. */
            if (mode === 'boot') successful(r);
            assert(fs.readFileSync(w.target).equals(patched), 'refused restore must leave target untouched');
            assert(fs.readFileSync(w.target + '.woc-orig').equals(fixture.buf), 'failed restore must retain verified backup');
            assert(fs.existsSync(w.target + '.woc-orig.json'), 'refused restore must retain metadata');
            assert.strictEqual(JSON.parse(fs.readFileSync(w.env.WOC_RECOVERY_STATE, 'utf8')).fails, 2,
                'failed restoration must not clear failure count');
            assert.strictEqual(events(w).filter(function (e) { return e.kind === 'drop'; }).length, 0);
            safeSystem(w, false);
        });
    });
});

var failed = 0;
tests.forEach(function (t) {
    try { t.fn(); console.log('PASS ' + t.name); }
    catch (e) { failed++; console.error('FAIL ' + t.name + '\n' + (e.stack || e)); }
});
console.log('navmd lifecycle: ' + (tests.length - failed) + '/' + tests.length + ' passed');
if (failed) process.exitCode = 1;
