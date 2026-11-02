#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* Socket regression: hold the connection's first status read until a fast
 * synthetic apply has finished. No real patcher, mount, service or car is used.
 * Run with Node 8: node patch/test/patchd_busy_test.js */
var assert = require('assert');
var fs = require('fs');
var net = require('net');
var path = require('path');
var cp = require('child_process');
var dir = fs.mkdtempSync('/tmp/woc-busy-');
var sock = path.join(dir, 'patch.sock');
var events = path.join(dir, 'events');
var hook = path.join(dir, 'hook.js');
var target = path.join(dir, 'carplay');
var patchd = path.resolve(__dirname, '..', 'patchd.js');
var child, client, timer, output = '', finished = false;

/* Intercept the privileged subprocesses inside the daemon, not the socket.
 * The held callback is released only after patchd logs operation completion,
 * so the ordering does not depend on timing or scheduler speed. */
function preload() {
    var cp = require('child_process'), fs = require('fs');
    var realSpawn = cp.spawn, held, applied = false;
    function mark(s) { fs.appendFileSync(process.env.WOC_TEST_EVENTS, s + '\n'); }
    var originalWrite = process.stdout.write;
    process.stdout.write = function (chunk) {
        var result = originalWrite.apply(this, arguments);
        if (String(chunk).indexOf('apply done') !== -1 && held) {
            mark('operation-finished');
            var cb = held; held = null;
            setImmediate(function () { mark('status-released'); cb(null, statusText(), ''); });
        }
        return result;
    };
    function statusText() {
        return 'known: yes, pristine synthetic\nproven: yes\nvariant: ORIGINAL\n' +
            'sink: ORIGINAL\nselfstart: ORIGINAL\nres: ORIGINAL\nbackup: none\n';
    }
    cp.execFile = function (file, args, options, cb) {
        if (file === process.execPath && args[1] === 'status') {
            if (!applied && !held) { mark('status-held'); held = cb; }
            else process.nextTick(function () { cb(null, statusText(), ''); });
        } else if (file === process.execPath && args[1] === 'apply') {
            applied = true; mark('apply');
            process.nextTick(function () { cb(null, 'nothing to do\n', ''); });
        } else if (file === process.env.WOC_MOUNT) {
            mark('mock-mount ' + args[1]);
            process.nextTick(function () { cb(null, '', ''); });
        } else {
            mark('unexpected-exec ' + file);
            process.nextTick(function () { cb(new Error('unexpected command'), '', ''); });
        }
        return {};
    };
    cp.spawn = function () { return realSpawn('/usr/bin/true', [], { stdio: ['ignore', 'pipe', 'pipe'] }); };
}
function remove(p) {
    var st;
    try { st = fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
        fs.readdirSync(p).forEach(function (n) { remove(path.join(p, n)); });
        fs.rmdirSync(p);
    } else fs.unlinkSync(p);
}
function finish(err) {
    if (finished) return;
    finished = true; clearTimeout(timer);
    if (client) client.destroy();
    function done() {
        try { remove(dir); } catch (e) { if (!err) err = e; }
        if (err) { console.error(err.stack || err); process.exitCode = 1; }
        else console.log('ok   busy arrives before terminal status despite delayed first read');
    }
    if (child && child.exitCode === null && child.signalCode === null) {
        child.once('exit', done); child.kill('SIGKILL');
    } else done();
}
fs.writeFileSync(hook, '(' + preload.toString() + ')();\n');
fs.writeFileSync(target, 'synthetic');
fs.writeFileSync(path.join(dir, 'mounts'), '/dev/root / ext4 ro 0 0\n');
fs.writeFileSync(events, '');
fs.mkdirSync(path.join(dir, 'proc'));
var env = {};
Object.keys(process.env).forEach(function (k) { if (!/^WOC_/.test(k) && k !== 'NODE_OPTIONS') env[k] = process.env[k]; });
Object.assign(env, {
    WOC_TEST_EVENTS: events, WOC_CARPLAY: target, WOC_PATCH_SOCK: sock,
    WOC_MOUNT: path.join(dir, 'fake-mount'), WOC_PROC_MOUNTS: path.join(dir, 'mounts'),
    WOC_PROC: path.join(dir, 'proc'), WOC_UNIT_DIRS: path.join(dir, 'units'),
    WOC_RECMGR_CONF: path.join(dir, 'recmgr'), WOC_RECMGR_AT_BOOT: path.join(dir, 'no-recmgr'),
    WOC_REMOUNT_LOCK: path.join(dir, 'lock'), WOC_NAVMD_ANCHOR_FILE: path.join(dir, 'anchor'),
    WOC_CAPTURE_SOCK: path.join(dir, 'capture.sock'), WOC_DLT_RETRY_MS: '600000'
});
child = cp.spawn(process.execPath, ['-r', hook, patchd], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', function (b) { output += b; });
child.stderr.on('data', function (b) { output += b; });
child.on('error', finish);
child.on('exit', function (code, signal) { if (!finished) finish(new Error('patchd exited ' + code + '/' + signal + ': ' + output)); });
timer = setTimeout(function () { finish(new Error('timeout: ' + output + '\nevents: ' + fs.readFileSync(events, 'utf8'))); }, 10000);
(function waitSocket() {
    if (finished) return;
    if (!fs.existsSync(sock)) { setTimeout(waitSocket, 10); return; }
    client = net.connect(sock);
    var buf = '', statuses = [];
    client.on('connect', function () { client.write(JSON.stringify({ cmd: 'apply', panel: 'high', mode: 'avb' }) + '\n'); });
    client.on('error', finish);
    client.on('data', function (data) {
        buf += data.toString();
        var at;
        while ((at = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, at); buf = buf.slice(at + 1);
            try {
                var msg = JSON.parse(line);
                if (msg.ev !== 'status') continue;
                statuses.push(msg);
                if (msg.state === 'busy') continue;
                assert.strictEqual(statuses[0].state, 'busy', JSON.stringify(statuses));
                assert.strictEqual(statuses[0].reason, 'applying');
                assert.strictEqual(statuses[0].navmd.state, 'unknown');
                assert.strictEqual(msg.state, 'original', JSON.stringify(statuses));
                var trace = fs.readFileSync(events, 'utf8');
                assert(trace.indexOf('status-held\n') >= 0, trace);
                assert(trace.indexOf('apply\n') > trace.indexOf('status-held\n'), trace);
                assert(trace.indexOf('operation-finished\n') > trace.indexOf('apply\n'), trace);
                assert(trace.indexOf('status-released\n') > trace.indexOf('operation-finished\n'), trace);
                assert.strictEqual(trace.indexOf('unexpected-exec'), -1, trace);
                finish(); return;
            } catch (e) { finish(e); return; }
        }
    });
})();
