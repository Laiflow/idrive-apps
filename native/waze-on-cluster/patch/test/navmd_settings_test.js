// SPDX-License-Identifier: GPL-3.0-or-later
// CLI regressions for independently switching the optional HMI metadata edit.
// Node 8; run with node patch/test/navmd_settings_test.js.
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var synthetic = require('./synthetic_carplay.js');
var locator = require('../carplay_locate.js');
var patch = path.join(__dirname, '..', 'carplay_patch.js');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-settings-'));
var fixture = synthetic.build(), anchor = 'GuidanceMetadata', counter = 0;
function fresh(f) { var p = path.join(root, 'target' + counter++); fs.writeFileSync(p, (f || fixture).buf); return p; }
function cli(t, args, env, fails, timeout) {
    var e = Object.assign({}, process.env, { WOC_NAVMD_ANCHOR: '' }, env || {});
    var r = cp.spawnSync(process.execPath, [patch].concat(args, ['--target', t]),
        { env: e, encoding: 'utf8', timeout: timeout || 30000, maxBuffer: 1024 * 1024 });
    assert.ifError(r.error);
    assert.strictEqual(r.signal, null);
    assert(fails ? r.status !== 0 : r.status === 0, args.join(' ') + '\n' + r.stdout + r.stderr);
    return r.stdout + r.stderr;
}
function apply(t, args, env, fails) {
    return cli(t, ['apply', '--panel', 'high', '--capture', '/tmp/woc-test', '--unproven', '--yes'].concat(args || []), env, fails);
}
function bytes(t) { return fs.readFileSync(t); }
function nav(t, expected) { assert.strictEqual(bytes(t).toString('hex', fixture.at.navmdCall, fixture.at.navmdCall + 5), expected); }
function core(t) {
    var b = bytes(t), l = locator.locate(b, anchor);
    assert(l.ok && l.navmd.ok);
    assert.strictEqual(b.readUInt32LE(l.variant.slot), l.variant.high, 'variant');
    assert.strictEqual(b.toString('latin1', l.sink.offset, l.sink.offset + 15), 'file:///tmp/woc', 'sink');
    assert.strictEqual(b.toString('hex', l.selfstart.offset, l.selfstart.offset + 5), l.selfstart.patched, 'self-start');
    assert.strictEqual(b.readUInt32LE(l.res.px), 1088, 'width');
    assert.strictEqual(b.readUInt32LE(l.res.px + 4), 480, 'height');
}
function snapshot(t) { return [t, t + '.woc-orig', t + '.woc-orig.json'].map(function (p) { return fs.existsSync(p) ? bytes(p) : null; }); }
function unchanged(t, snap) { snapshot(t).forEach(function (b, i) { assert((b === null && snap[i] === null) || (b && snap[i] && b.equals(snap[i])), 'unexpected write at index ' + i); }); }
function remove(p) { if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (n) { remove(path.join(p, n)); }); fs.rmdirSync(p); } else fs.unlinkSync(p); }
function test(name, fn) { fn(); console.log('ok ' + name); }
try {
    test('fresh off/on/off: four core edits, idempotence, unrelated bytes, recorded off-to-on and full revert', function () {
        var t = fresh();
        apply(t, ['--navmd-off', '--navmd', anchor]); core(t); nav(t, fixture.at.navmdOriginal);
        var off = bytes(t); apply(t, ['--navmd-off']); assert(bytes(t).equals(off));
        apply(t, ['--navmd-on', '--navmd', anchor]); core(t); nav(t, fixture.at.navmdPatched);
        var on = bytes(t); apply(t, ['--navmd-on']); assert(bytes(t).equals(on));
        var changed = bytes(t), unrelated = changed.length - 1; changed[unrelated] = 0x5a; fs.writeFileSync(t, changed);
        apply(t, ['--navmd-off'], { WOC_NAVMD_ANCHOR: 'invalid-ambient-anchor' });
        core(t); nav(t, fixture.at.navmdOriginal); assert.strictEqual(bytes(t)[unrelated], 0x5a);
        assert(fs.existsSync(t + '.woc-orig')); assert(fs.existsSync(t + '.woc-orig.json'));
        off = bytes(t); apply(t, ['--navmd-off']); assert(bytes(t).equals(off));
        apply(t, ['--navmd-on']); core(t); nav(t, fixture.at.navmdPatched); assert.strictEqual(bytes(t)[unrelated], 0x5a);
        cli(t, ['revert', '--yes']); var want = Buffer.from(fixture.buf); want[unrelated] = 0x5a;
        assert(bytes(t).equals(want), 'full tracked revert preserves unrelated byte');
    });
    test('unanchored off without backup accepts only byte-exact proven image', function () {
        var t = fresh(), before = snapshot(t);
        assert(/verified.*anchor.*verified backup/.test(apply(t, ['--navmd-off'], null, true))); unchanged(t, before);
        /* Any per-name search would request anchored locator calls. */
        var noScan = path.join(root, 'no-scan-hook.js');
        fs.writeFileSync(noScan, 'var l=require(' + JSON.stringify(path.join(__dirname, '..', 'carplay_locate.js')) +
            '),old=l.locate;l.locate=function(b,a){if(a!==undefined)throw new Error("unexpected name scan");return old(b,a);};');
        assert(/verified.*anchor.*verified backup/.test(apply(t, ['--navmd-off'], { NODE_OPTIONS: '--require ' + noScan }, true)));
        unchanged(t, before);
        /* Install a test-only proven entry into the process module before it
         * executes; no source or on-disk image is changed by the hook. */
        var id = locator.buildId(fixture.buf), hash = crypto.createHash('sha256').update(fixture.buf).digest('hex');
        var hook = path.join(root, 'proven-hook.js');
        var insertion = 'PROVEN[' + JSON.stringify(id) + '] = { version: "test", sha256: ' + JSON.stringify(hash) + ' };\nvar RES_DEFAULT';
        fs.writeFileSync(hook, 'var Module=require("module"),fs=require("fs"),old=Module._extensions[".js"];' +
            'Module._extensions[".js"]=function(m,f){if(f===' + JSON.stringify(patch) + '){' +
            'var s=fs.readFileSync(f,"utf8"); s=s.replace("var RES_DEFAULT",' + JSON.stringify(insertion) + ');m._compile(s,f);}' +
            'else old(m,f);};');
        var env = { NODE_OPTIONS: '--require ' + hook };
        var altered = bytes(t); altered[altered.length - 1] ^= 1; fs.writeFileSync(t, altered); before = snapshot(t);
        assert(/verified.*anchor.*verified backup/.test(apply(t, ['--navmd-off'], env, true))); unchanged(t, before);
        fs.writeFileSync(t, fixture.buf); apply(t, ['--navmd-off'], env); core(t); nav(t, fixture.at.navmdOriginal);
    });
    test('normal core apply without record or anchor never enables navmd', function () {
        var t = fresh(); apply(t); core(t); nav(t, fixture.at.navmdOriginal);
        assert(!JSON.parse(fs.readFileSync(t + '.woc-orig.json', 'utf8')).navmd);
        apply(t, ['--navmd-off']); core(t); nav(t, fixture.at.navmdOriginal);
    });
    test('record is not an opt-in during ordinary core apply', function () {
        var t = fresh(); apply(t, ['--navmd-on', '--navmd', anchor]); apply(t, ['--navmd-off']);
        apply(t); nav(t, fixture.at.navmdOriginal); core(t);
    });
    test('missing, empty, invalid and unsupported anchors refuse before writes', function () {
        [[], ['--navmd', ''], ['--navmd', '  '], ['--navmd', 'no-such-name'], ['--navmd', '[/']].forEach(function (a) {
            var t = fresh(), before = snapshot(t); apply(t, ['--navmd-on'].concat(a), null, true); unchanged(t, before);
        });
        var f = synthetic.build({ navmdCallsVideo: true }), t = fresh(f), before = snapshot(t);
        apply(t, ['--navmd-on', '--navmd', anchor], null, true); unchanged(t, before);
        t = fresh(); before = snapshot(t); apply(t, ['--navmd-on', '--navmd'], null, true); unchanged(t, before);
    });
    test('conflicting flags refuse before writes regardless of existing identity', function () {
        var t = fresh(), before = snapshot(t); apply(t, ['--navmd-on', '--navmd-off', '--navmd', anchor], null, true); unchanged(t, before);
        apply(t, ['--navmd-on', '--navmd', anchor]); before = snapshot(t);
        apply(t, ['--navmd-on', '--navmd-off'], null, true); unchanged(t, before);
    });
    test('off ignores even a valid ambient opt-in', function () {
        var t = fresh(), before = snapshot(t);
        apply(t, ['--navmd-off'], { WOC_NAVMD_ANCHOR: anchor }, true); unchanged(t, before);
        apply(t); apply(t, ['--navmd-off'], { WOC_NAVMD_ANCHOR: anchor }); nav(t, fixture.at.navmdOriginal); core(t);
        apply(t, ['--navmd-on'], { WOC_NAVMD_ANCHOR: anchor }); nav(t, fixture.at.navmdPatched);
        apply(t, ['--navmd-off'], { WOC_NAVMD_ANCHOR: anchor }); nav(t, fixture.at.navmdOriginal); core(t);
    });
    test('legacy unrecorded change refuses unanchored off, but explicit anchor can restore it', function () {
        var t = fresh(); apply(t, ['--navmd-on', '--navmd', anchor]);
        var meta = JSON.parse(fs.readFileSync(t + '.woc-orig.json', 'utf8')); delete meta.navmd;
        fs.writeFileSync(t + '.woc-orig.json', JSON.stringify(meta));
        var before = snapshot(t); apply(t, ['--navmd-off'], { WOC_NAVMD_ANCHOR: anchor }, true); unchanged(t, before);
        apply(t, ['--navmd-off', '--navmd', anchor]); nav(t, fixture.at.navmdOriginal); core(t);
        var noBackup = fresh(), b = bytes(noBackup); Buffer.from(fixture.at.navmdPatched, 'hex').copy(b, fixture.at.navmdCall); fs.writeFileSync(noBackup, b);
        before = snapshot(noBackup); apply(noBackup, ['--navmd-off'], null, true); unchanged(noBackup, before);
    });
    test('large unrelated call candidate with 3000 names stays bounded and preserves other bytes', function () {
        var original = Buffer.concat([fixture.buf, Buffer.alloc(1024 * 1024)]);
        var nameAt = fixture.buf.length + 16;
        for (var i = 0; i < 3000; i++) nameAt += original.write('void ns::candidate' + i + '()\0', nameAt, 'latin1');
        var call = 0x1600, entry = 0x1650, ret = 0x1660;
        original[call] = 0xe8; original.writeInt32LE(entry - call - 5, call + 1); original[ret] = 0xc3;
        var t = fresh({ buf: original }); apply(t);
        var b = bytes(t); b.writeInt32LE(ret - call - 5, call + 1); b[b.length - 1] = 0x77; fs.writeFileSync(t, b);
        var started = Date.now();
        assert(/restorable:\s+yes/.test(cli(t, ['status'], null, false, 8000)));
        cli(t, ['revert', '--yes', '--drop-backup'], null, false, 8000);
        assert(Date.now() - started < 16000, 'both CLI operations must finish within their individual 8s deadlines');
        var expected = Buffer.from(original); expected.writeInt32LE(ret - call - 5, call + 1); expected[expected.length - 1] = 0x77;
        assert(bytes(t).equals(expected), 'unrelated changed call and bytes must survive region restore');
        assert(!fs.existsSync(t + '.woc-orig'));
    });
    test('legacy self-name after 0x60 refuses status, off and backup deletion', function () {
        var original = Buffer.from(fixture.buf), call = 0x1400, entry = 0x1500, load = entry + 0x90, ret = entry + 0xa0;
        original[call] = 0xe8; original.writeInt32LE(entry - call - 5, call + 1);
        original.fill(0x90, entry, ret); original[ret] = 0xc3;
        var nameAt = original.indexOf('void carplay::navi_handler::GuidanceMetadata');
        assert(nameAt >= 0);
        original[load] = 0x48; original[load + 1] = 0x8d; original[load + 2] = 0x0d;
        original.writeInt32LE((0x600000 + nameAt - 0x2000) - (0x10000 + load + 7), load + 3);
        var t = fresh({ buf: original }); apply(t);
        var b = bytes(t); b.writeInt32LE(ret - call - 5, call + 1); fs.writeFileSync(t, b);
        var before = snapshot(t);
        assert(/restorable:\s+no.*legacy navmd/.test(cli(t, ['status'], null, false, 8000)));
        cli(t, ['revert', '--yes', '--drop-backup'], null, true, 8000); unchanged(t, before);
        apply(t, ['--navmd-off'], null, true); unchanged(t, before);
    });
    test('candidate and scan budgets refuse instead of deleting the backup', function () {
        var original = Buffer.from(fixture.buf), entry = 0x1a00, ret = 0x1a08, first = 0x1400;
        original[ret] = 0xc3;
        for (var i = 0; i < 33; i++) {
            var call = first + i * 6; original[call] = 0xe8; original.writeInt32LE(entry - call - 5, call + 1);
        }
        var t = fresh({ buf: original }); apply(t);
        var b = bytes(t);
        for (i = 0; i < 33; i++) { call = first + i * 6; b.writeInt32LE(ret - call - 5, call + 1); }
        fs.writeFileSync(t, b); var before = snapshot(t);
        assert(/restorable:\s+no.*legacy navmd/.test(cli(t, ['status'], null, false, 8000)));
        cli(t, ['revert', '--yes', '--drop-backup'], null, true, 8000); unchanged(t, before);
    });
    test('too many forwarder references refuse rather than treating the candidate as clean', function () {
        var original = Buffer.from(fixture.buf), call = 0x1600, entry = 0x1800, ret = 0x1a00;
        original[call] = 0xe8; original.writeInt32LE(entry - call - 5, call + 1); original[ret] = 0xc3;
        for (var i = 0; i < 65; i++) {
            var at = entry + i * 7;
            original[at] = 0x48; original[at + 1] = 0x8d; original[at + 2] = 0x0d;
            original.writeInt32LE((0x600000 + 0xf00) - (0x10000 + at + 7), at + 3);
        }
        var t = fresh({ buf: original }); apply(t); var b = bytes(t);
        b.writeInt32LE(ret - call - 5, call + 1); fs.writeFileSync(t, b); var before = snapshot(t);
        assert(/restorable:\s+no.*legacy navmd/.test(cli(t, ['status'], null, false, 8000)));
        cli(t, ['revert', '--yes', '--drop-backup'], null, true, 8000); unchanged(t, before);
    });
    test('global candidate-body budget refuses even when individual bodies fit', function () {
        var original = Buffer.from(fixture.buf), entry = 0x1000, ret = 0x1fff, first = 0xe00;
        original[ret] = 0xc3;
        for (var i = 0; i < 5; i++) {
            var call = first + i * 6; original[call] = 0xe8; original.writeInt32LE(entry - call - 5, call + 1);
        }
        var t = fresh({ buf: original }); apply(t); var b = bytes(t);
        for (i = 0; i < 5; i++) { call = first + i * 6; b.writeInt32LE(ret - call - 5, call + 1); }
        fs.writeFileSync(t, b); var before = snapshot(t);
        assert(/restorable:\s+no.*legacy navmd/.test(cli(t, ['status'], null, false, 8000)));
        cli(t, ['revert', '--yes', '--drop-backup'], null, true, 8000); unchanged(t, before);
    });
    test('corrupt metadata, backup, target and other-build fail without writes', function () {
        ['meta', 'backup', 'site', 'build'].forEach(function (mode) {
            var t = fresh(); apply(t, ['--navmd-on', '--navmd', anchor]);
            if (mode === 'meta') fs.writeFileSync(t + '.woc-orig.json', '{');
            if (mode === 'backup') { var b = bytes(t + '.woc-orig'); b[b.length - 1] ^= 1; fs.writeFileSync(t + '.woc-orig', b); }
            if (mode === 'site') { var c = bytes(t); c[fixture.at.navmdCall + 1] ^= 0x40; fs.writeFileSync(t, c); }
            if (mode === 'build') { var d = bytes(t); d[0x210] ^= 1; fs.writeFileSync(t, d); }
            var before = snapshot(t); apply(t, ['--navmd-off'], null, true); unchanged(t, before);
        });
    });
    test('historical-only identity refuses partial off and new on; full revert remains available', function () {
        var t = fresh(); apply(t, ['--navmd-on', '--navmd', anchor]);
        var hook = path.join(root, 'strict-locator.js');
        fs.writeFileSync(hook, 'var l=require(' + JSON.stringify(path.join(__dirname, '..', 'carplay_locate.js')) +
            '); var old=l.locate; l.locate=function(b,a){var c=old(b,a);if(a!==undefined)c.navmd={ok:false,reason:"future policy"};return c;};');
        var env = { NODE_OPTIONS: '--require ' + hook }, before = snapshot(t);
        apply(t, ['--navmd-off'], env, true); unchanged(t, before);
        apply(t, ['--navmd-on'], env, true); unchanged(t, before);
        cli(t, ['revert', '--yes'], env); assert(bytes(t).equals(fixture.buf));
    });
    test('yes and unproven gates do not write the target', function () {
        var t = fresh(), before = snapshot(t);
        cli(t, ['apply', '--panel', 'high', '--navmd-on', '--navmd', anchor, '--yes'], null, true); unchanged(t, before);
        cli(t, ['apply', '--panel', 'high', '--unproven', '--navmd-on', '--navmd', anchor], null, true); unchanged(t, before);
        cli(t, ['apply', '--panel', 'high', '--unproven', '--navmd-off', '--navmd', anchor], null, true); unchanged(t, before);
        apply(t, ['--navmd-on', '--navmd', anchor]); before = snapshot(t);
        cli(t, ['apply', '--panel', 'high', '--navmd-off'], null, true); unchanged(t, before);
    });
} finally { remove(root); }
