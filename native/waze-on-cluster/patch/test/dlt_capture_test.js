// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
var assert = require('assert'), fs = require('fs'), os = require('os');
var net = require('net'), path = require('path'), cp = require('child_process');
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
var helper = path.join(__dirname, '..', 'dlt_capture.js');
var children = [], sockets = [], modes = [], behavior = 'ok', tcp;
var env = Object.assign({}, process.env, {
    WOC_CAPTURE_DIR: path.join(dir, 'capture'), WOC_DLT_SOCKET: path.join(dir, 'ctrl'),
    WOC_TRACE_DIR: dir, WOC_CAPTURE_MS: '400',
    WOC_CAPTURE_RETRY_MS: '80', WOC_DLT_PROC: path.join(dir,'proc')
});
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function listen(server, address) { return new Promise(function (r) { server.listen(address, r); }); }
async function until(fn) {
    for (var i = 0; i < 250; i++) { if (await fn()) return; await delay(20); }
    throw new Error('condition timed out');
}
function state() { try { return JSON.parse(fs.readFileSync(path.join(env.WOC_CAPTURE_DIR, 'state.json'))); } catch (e) { return {}; } }
function command(cmd) {
    return new Promise(function (resolve, reject) {
        var c = net.connect(path.join(env.WOC_CAPTURE_DIR, 'control.sock')), buf = '';
        c.on('error', reject); c.on('connect', function () { c.write(JSON.stringify({cmd:cmd}) + '\n'); });
        c.on('data', function (d) { buf += d; if (buf.indexOf('\n') >= 0) { c.destroy(); resolve(JSON.parse(buf)); } });
    });
}
function spawn(args) {
    var child = cp.spawn(process.execPath, [helper].concat(args || []), { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); var text = '';
    child.stderr.on('data', function(d) { text += d; });
    child.result = new Promise(function (resolve) { child.on('exit', function (code, sig) { resolve({code:code, signal:sig, text:text}); }); });
    return child;
}
function trace(mode) {
    fs.writeFileSync(path.join(dir, '12_dltd.idlt'), mode === 0 ? '2026/10/26 12:00:00 1 Tracing OFF: Switched to log mode off state \n' : '2026/10/26 12:00:00 1 Tracing ON: Switched to buffer state for socket connections \n');
}
function netState(open) {fs.writeFileSync(path.join(env.WOC_DLT_PROC,'net','tcp'),open ? '0: 0100007F:'+Number(env.WOC_DLT_PORT).toString(16)+' 00000000:0000 0A\n' : 'sl local_address rem_address st\n');}
async function openTCP() {
    if (tcp) return;
    tcp = net.createServer(function(c) { sockets.push(c); c.on('error', function() {}); c.on('data', function() {}); });
    await listen(tcp, {host:'127.0.0.1', port:Number(env.WOC_DLT_PORT)});
    netState(true);
}
async function closeTCP() {
    if (!tcp) return;
    netState(false);
    sockets.forEach(function(c) { c.destroy(); }); sockets = [];
    var old = tcp; tcp = null;
    await new Promise(function(r) { old.close(r); });
}
(async function() {
    fs.mkdirSync(env.WOC_DLT_PROC);fs.mkdirSync(path.join(env.WOC_DLT_PROC,'9'));
    fs.writeFileSync(path.join(env.WOC_DLT_PROC,'9','comm'),'dlt-daemon\n');
    fs.mkdirSync(path.join(env.WOC_DLT_PROC,'9','fd'));
    var clientFD=path.join(env.WOC_DLT_PROC,'9','fd','10');
    fs.symlinkSync('/run/dlt-files/dltpipes/dlt99',clientFD);
    var reserve = net.createServer(); await listen(reserve, {host:'127.0.0.1',port:0});
    env.WOC_DLT_PORT = String(reserve.address().port);fs.mkdirSync(path.join(env.WOC_DLT_PROC,'net'));netState(false); await new Promise(function(r) { reserve.close(r); });
    var ctrl = net.createServer(function(c) {
        var buf = Buffer.alloc(0);
        c.on('error', function() {});
        c.on('data', async function(d) {
            buf = Buffer.concat([buf,d]); if (buf.length < 27) return;
            // Frozen request fixture: BMW libdlt's UEH/WEID/WTMS control envelope.
            assert.strictEqual(buf.slice(0,26).toString('hex'), '3500001b4d47485300000000160141505000434f4e00130f0000');
            var mode = buf[26]; buf = Buffer.alloc(0); modes.push(mode);
            if (behavior === 'hang' || (behavior === 'restore-hang' && mode !== 1)) return;
            if (behavior !== 'reject') {
                if (mode === 1) await openTCP(); else { await closeTCP(); trace(mode); }
            }
            var reply = Buffer.from('3500001b4d47485300000000260141505000434f4e00130f000000','hex');
            if (behavior === 'reject') reply[26] = 1;
            // Fragmented acknowledgement exercises stream reassembly.
            c.write(reply.slice(0,3)); setTimeout(function() { c.end(reply.slice(3)); }, 5);
        });
    });
    await listen(ctrl, env.WOC_DLT_SOCKET);
    trace(2);
    var daemon = spawn();
    await until(function() { return fs.existsSync(path.join(env.WOC_CAPTURE_DIR,'control.sock')); });
    await command('status'); await delay(60); assert.deepStrictEqual(modes, [], 'startup/status must not toggle DLT');
    await command('start'); await until(function() { return state().state === 'open'; });
    var deadline = state().closes_at;
    for (var i=0;i<4;i++) { await command('start'); await command('status'); }
    assert.strictEqual(state().closes_at, deadline, 'requests cannot extend capture');
    await until(function() { return state().state === 'closed'; }); assert.deepStrictEqual(modes,[1,2]);
    console.log('ok fixed deadline, passive reads, acknowledgement and verified restore');
    await openTCP(); var before = modes.length; await command('start');
    await until(function() { return state().state === 'refused'; }); assert.strictEqual(modes.length,before);
    await closeTCP(); fs.writeFileSync(path.join(dir,'12_dltd.idlt'),'no state record\n');
    await command('start'); await until(function() { return state().state === 'refused' && /unknown/.test(state().error); });
    assert.strictEqual(modes.length,before); console.log('ok pre-existing trace and unknown baseline refused without mutation');
    fs.unlinkSync(clientFD);trace(2);await command('start');
    await until(function() { return state().state === 'refused'; });
    assert.strictEqual(modes.length,before,'an empty daemon gets no request');
    fs.symlinkSync('/run/dlt-files/dltpipes/dlt99',clientFD);
    console.log('ok empty daemon receives no control request');
    trace(0); await command('start'); await until(function() { return state().state === 'open'; });
    await command('stop'); await until(function() { return state().state === 'closed'; });
    assert.strictEqual(modes[modes.length-1],0); console.log('ok OFF baseline restored as OFF');
    trace(0); fs.writeFileSync(path.join(dir,'13_dltd.idlt'),'2026/10/26 12:00:00 1 iDLT ~ new lifecycle\n');
    await command('start'); await until(function() { return state().state === 'open'; });
    await command('stop'); await until(function() { return state().state === 'closed'; });
    assert.strictEqual(modes[modes.length-1],0); fs.unlinkSync(path.join(dir,'13_dltd.idlt'));
    console.log('ok baseline from an earlier lifecycle record');
    trace(2); behavior='reject'; await command('start');
    await until(function() { return state().state === 'restore_failed'; });
    assert.strictEqual(state().owned,true); assert(/rejected/.test(state().error));
    behavior='ok'; await until(function() { return state().state === 'closed'; });
    console.log('ok rejected acknowledgement, visible failed restore, recovery');
    trace(2); await command('start'); await until(function() { return state().state === 'open'; });
    daemon.kill('SIGKILL'); await daemon.result;
    assert.strictEqual(state().owned,true);
    var cleanup = spawn(['restore']); assert.strictEqual((await cleanup.result).code,0);
    assert.strictEqual(state().owned,false); assert.strictEqual(tcp,null);
    console.log('ok independent ExecStopPost restores owned lease after SIGKILL');
    before=modes.length; cleanup=spawn(['restore']); assert.strictEqual((await cleanup.result).code,0);
    assert.strictEqual(modes.length,before,'no owned lease means no restore command');
    daemon=spawn(); await until(async function() { try { await command('status'); return true; } catch(e) { return false; } }); behavior='hang'; trace(2); await command('start');
    await until(function() { return state().owned; }); await command('stop');
    behavior='ok'; await until(function() { return state().state === 'closed'; });
    assert.strictEqual(modes[modes.length-1],2); console.log('ok stop during pending start and ambiguous timeout restores baseline');
    daemon.kill('SIGTERM'); await daemon.result;
    await new Promise(function(r) { ctrl.close(r); }); await closeTCP();
    console.log('DLT capture lifecycle passed');
})().catch(function(err) { console.error(err.stack); process.exitCode=1; }).then(function() {
    children.forEach(function(c) { try { c.kill('SIGKILL'); } catch(e) {} });
    // This directory is exclusively created by this test.
    cp.execFileSync('rm',['-rf',dir]);
    process.exit(process.exitCode || 0);
});
