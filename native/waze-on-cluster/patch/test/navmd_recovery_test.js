// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* Regression tests for optional-edit recovery identity. Node 8, no deps.
 * Run: node patch/test/navmd_recovery_test.js */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var crypto = require('crypto');
var fixture = require('./synthetic_carplay.js').build();
var patch = path.join(__dirname, '..', 'carplay_patch.js');
var root = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-navmd-recovery-'));
var anchor = 'GuidanceMetadata', count = 0;
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function fresh(name) {
    var t = path.join(root, name);
    fs.writeFileSync(t, fixture.buf);
    return t;
}
function cli(t, args, env, fail) {
    var r = cp.spawnSync(process.execPath, [patch].concat(args, ['--target', t]), {
        env: Object.assign({}, process.env, { WOC_NAVMD_ANCHOR: '' }, env || {}), encoding: 'utf8', timeout: 20000
    });
    assert(!r.error, String(r.error));
    assert(fail ? r.status !== 0 : r.status === 0, args.join(' ') + '\n' + r.stdout + r.stderr);
    return r.stdout + r.stderr;
}
function apply(t, args, env) { return cli(t, ['apply', '--panel', 'high', '--unproven', '--yes'].concat(args || []), env); }
function meta(t) { return JSON.parse(fs.readFileSync(t + '.woc-orig.json', 'utf8')); }
function setMeta(t, m) { fs.writeFileSync(t + '.woc-orig.json', JSON.stringify(m)); }
function nav(b) { return b.slice(fixture.at.navmdCall, fixture.at.navmdCall + 5); }
function originalNav(t) { assert(nav(fs.readFileSync(t)).equals(nav(fixture.buf)), 'navmd should remain original'); }
function patchedNav(t) { assert(!nav(fs.readFileSync(t)).equals(nav(fixture.buf)), 'navmd should be dropped'); }
function dropped(t) { assert(!fs.existsSync(t + '.woc-orig')); assert(!fs.existsSync(t + '.woc-orig.json')); }
function test(name, fn) { fn(); count++; console.log('ok ' + name); }
function remove(p) {
    if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach(function (n) { remove(path.join(p, n)); }); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
}
try {
    test('environment-only status, apply, verify and revert', function () {
        var t = fresh('env'), env = { WOC_NAVMD_ANCHOR: anchor };
        assert(/navmd:\s+ORIGINAL/.test(cli(t, ['status'], env)));
        assert(/navmd:\s+.*ORIGINAL/.test(cli(t, ['probe'], env)));
        apply(t, [], env); patchedNav(t);
        assert(/navmd dropped/.test(cli(t, ['verify'], env)));
        cli(t, ['revert', '--yes'], env); assert(fs.readFileSync(t).equals(fixture.buf));
    });
    test('empty explicit flag refuses before backup or target write, even with environment', function () {
        ['', '   '].forEach(function (value, i) {
            var t = fresh('empty' + i), args = ['apply', '--panel', 'high', '--unproven', '--navmd'];
            if (value !== null) args.push(value);
            args.push('--yes');
            assert(/non-empty anchor/.test(cli(t, args, { WOC_NAVMD_ANCHOR: anchor }, true)));
            assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
        });
    });
    test('bare --navmd uses environment but refuses without it', function () {
        var t = fresh('bare-env'); apply(t, ['--navmd'], { WOC_NAVMD_ANCHOR: anchor }); patchedNav(t);
        cli(t, ['revert', '--yes', '--drop-backup']); assert(fs.readFileSync(t).equals(fixture.buf));
        t = fresh('bare-no-env');
        cli(t, ['apply', '--panel', 'high', '--unproven', '--navmd', '--yes'], null, true);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('explicit apply persists validated schema; printed ordinary revert restores all edits', function () {
        var t = fresh('printed'), out = apply(t, ['--navmd', anchor]), m = meta(t), n = m.navmd;
        assert.strictEqual(n.schema, 1); assert.strictEqual(n.anchor, anchor);
        assert.strictEqual(n.offset, fixture.at.navmdCall); assert.strictEqual(n.original, nav(fixture.buf).toString('hex'));
        assert.strictEqual(n.patched, nav(fs.readFileSync(t)).toString('hex'));
        assert.strictEqual(n.sha256_original, sha(fixture.buf)); assert.strictEqual(n.buildId, m.buildId);
        assert(/navmd:\s+DROPPED/.test(cli(t, ['status'])));
        assert(/navmd:\s+.*DROPPED/.test(cli(t, ['probe'])));
        assert(/navmd dropped/.test(cli(t, ['verify'])));
        var printed = /^revert:\s+carplay_patch.js (.*)$/m.exec(out);
        assert(printed); assert(printed[1].indexOf('--navmd') === -1);
        var r = cp.spawnSync(process.execPath, [patch].concat(printed[1].split(' ')), {
            encoding: 'utf8', env: Object.assign({}, process.env, { WOC_NAVMD_ANCHOR: '' })
        });
        assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert(fs.readFileSync(t).equals(fixture.buf));
        cli(t, ['revert', '--yes', '--drop-backup']); dropped(t);
    });
    test('ordinary --drop-backup restores navmd before discarding recovery authority', function () {
        var t = fresh('drop'); apply(t, ['--navmd', anchor]);
        cli(t, ['revert', '--yes', '--drop-backup']); assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('core-only backup can acquire navmd; core reapply preserves it without site mismatch', function () {
        var t = fresh('add'); apply(t); originalNav(t); assert.strictEqual(meta(t).navmd, undefined);
        var backup = fs.readFileSync(t + '.woc-orig');
        apply(t, ['--navmd', anchor]); patchedNav(t); assert(fs.readFileSync(t + '.woc-orig').equals(backup));
        cli(t, ['apply', '--panel', 'mid', '--yes']); patchedNav(t);
        apply(t); patchedNav(t); cli(t, ['revert', '--yes', '--drop-backup']);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('recorded but restored navmd is not newly enabled by core-only apply', function () {
        var t = fresh('opt-in'); apply(t, ['--navmd', anchor]); cli(t, ['revert', '--yes']);
        apply(t); originalNav(t); assert(/navmd original/.test(cli(t, ['verify'])));
        cli(t, ['revert', '--yes']); assert(fs.readFileSync(t).equals(fixture.buf));
    });
    test('legacy already-patched no-op apply refreshes recovery identity', function () {
        var t = fresh('legacy'); apply(t, ['--navmd', anchor]); var m = meta(t); delete m.navmd; setMeta(t, m);
        var before = fs.readFileSync(t);
        assert(/nothing to do/.test(apply(t, ['--navmd', anchor])));
        assert(fs.readFileSync(t).equals(before)); assert.strictEqual(meta(t).navmd.anchor, anchor);
        cli(t, ['revert', '--yes', '--drop-backup']); assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('same-site anchor synonyms preserve identity; conflicting requests refuse without changes', function () {
        var t = fresh('synonym'); apply(t, ['--navmd', anchor]);
        apply(t, ['--navmd', 'forwardToHmi']);
        assert.strictEqual(meta(t).navmd.anchor, anchor); patchedNav(t);
        var before = fs.readFileSync(t), mb = fs.readFileSync(t + '.woc-orig.json');
        cli(t, ['apply', '--panel', 'mid', '--yes', '--navmd', 'NotAForwarder'], null, true);
        cli(t, ['revert', '--yes', '--drop-backup', '--navmd', 'NotAForwarder'], null, true);
        assert(fs.readFileSync(t).equals(before)); assert(fs.readFileSync(t + '.woc-orig.json').equals(mb));
        cli(t, ['revert', '--yes', '--drop-backup', '--navmd', 'forwardToHmi']);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('a different VALID site cannot replace recorded navmd identity or evade revert', function () {
        /* Extend the helper in memory only: never change the shared fixture. */
        var source = fs.readFileSync(path.join(__dirname, 'synthetic_carplay.js'), 'utf8');
        source = source.replace(/fn\('gmd'\); label\('gmfcall'\); call\('gmf'\); b\(0xc3\);/g,
            "fn('gmd'); label('gmfcall'); call('gmf'); b(0xc3); fn('gmfOther'); lea(0x48, 0x0d, 's.gmfOther'); b(0xc3); fn('gmdOther'); call('gmfOther'); b(0xc3);");
        source = source.replace("if (!o.noNavmd) str('s.gmf',", "str('s.gmfOther', 'void carplay::navi_handler::AlternateMetadata::forwardToHmi(const Guidance&)'); if (!o.noNavmd) str('s.gmf',");
        var mod = { exports: {} }; new Function('require', 'module', source)(require, mod);
        var f = mod.exports.build(), t = fresh('different-valid'); fs.writeFileSync(t, f.buf);
        var loc = require('../carplay_locate.js');
        var first = loc.locate(f.buf, anchor).navmd, second = loc.locate(f.buf, 'AlternateMetadata').navmd;
        assert(first.ok && second.ok); assert.notStrictEqual(first.offset, second.offset);
        apply(t, ['--navmd', anchor]); var before = fs.readFileSync(t), mb = fs.readFileSync(t + '.woc-orig.json');
        cli(t, ['apply', '--panel', 'mid', '--navmd', 'AlternateMetadata', '--yes'], null, true);
        cli(t, ['revert', '--navmd', 'AlternateMetadata', '--yes', '--drop-backup'], null, true);
        assert(fs.readFileSync(t).equals(before)); assert(fs.readFileSync(t + '.woc-orig.json').equals(mb));
        cli(t, ['revert', '--yes', '--drop-backup']); assert(fs.readFileSync(t).equals(f.buf)); dropped(t);
    });
    test('future locator hardening allows historical full recovery, but never a new unsafe apply', function () {
        var t = fresh('future-policy'); apply(t, ['--navmd', anchor]);
        var hook = path.join(root, 'strict-locator.js');
        fs.writeFileSync(hook, "var l=require(" + JSON.stringify(path.join(__dirname, '..', 'carplay_locate.js')) +
            "); var old=l.locate; l.locate=function(b,a){var c=old(b,a);if(a!==undefined)c.navmd={ok:false,reason:'test stricter future policy'};return c;};");
        var env = { NODE_OPTIONS: '--require ' + hook };
        assert(/restorable: yes/.test(cli(t, ['status'], env)));
        cli(t, ['apply', '--panel', 'mid', '--yes'], env); patchedNav(t);
        var before = fs.readFileSync(t);
        cli(t, ['apply', '--panel', 'high', '--navmd', anchor, '--yes'], env, true);
        assert(fs.readFileSync(t).equals(before));
        /* Full restore, not a partial core write followed by verification failure. */
        cli(t, ['revert', '--yes', '--drop-backup'], env);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
        t = fresh('future-legacy'); apply(t, ['--navmd', anchor]); var m = meta(t); delete m.navmd; setMeta(t, m);
        before = fs.readFileSync(t);
        assert(/restorable: no.*legacy navmd needs --navmd/.test(cli(t, ['status'], env)));
        cli(t, ['revert', '--yes', '--drop-backup'], env, true);
        cli(t, ['revert', '--navmd', anchor, '--yes', '--drop-backup'], env, true);
        assert(fs.readFileSync(t).equals(before)); assert(fs.existsSync(t + '.woc-orig'));
    });
    test('validated legacy call-to-ret difference refuses anchorless restore/drop without inferring identity', function () {
        var t = fresh('legacy-refusal'); apply(t, ['--navmd', anchor]);
        var m = meta(t); delete m.navmd; setMeta(t, m); var before = fs.readFileSync(t);
        assert(/restorable: no.*legacy navmd needs --navmd/.test(cli(t, ['status'])));
        cli(t, ['revert', '--yes'], null, true);
        cli(t, ['revert', '--yes', '--drop-backup'], null, true);
        assert(fs.readFileSync(t).equals(before)); assert(fs.existsSync(t + '.woc-orig'));
        assert.strictEqual(meta(t).navmd, undefined);
        cli(t, ['revert', '--navmd', anchor, '--yes', '--drop-backup']);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
    });
    test('explicit force recovers an unsafe legacy edit from verified full backup and discards unrelated edits', function () {
        var f = require('./synthetic_carplay.js').build(), t = fresh('force-legacy');
        /* A legacy caller consumes the return value: new navmd policy rejects
         * it even though old call-to-RET patchers could write the displacement. */
        Buffer.from([0x85, 0xc0, 0xc3]).copy(f.buf, f.at.navmdCall + 5);
        assert.strictEqual(require('../carplay_locate.js').locate(f.buf, anchor).navmd.ok, false);
        fs.writeFileSync(t, f.buf); apply(t); assert.strictEqual(meta(t).navmd, undefined);
        var oldPatched = fs.readFileSync(t); Buffer.from(f.at.navmdPatched, 'hex').copy(oldPatched, f.at.navmdCall);
        oldPatched[oldPatched.length - 17] = 0xa7; fs.writeFileSync(t, oldPatched);
        cli(t, ['revert', '--navmd', anchor, '--yes', '--drop-backup'], null, true);
        assert(fs.readFileSync(t).equals(oldPatched)); assert(fs.existsSync(t + '.woc-orig'));
        cli(t, ['revert', '--navmd', anchor, '--force', '--yes', '--drop-backup']);
        assert(fs.readFileSync(t).equals(f.buf)); dropped(t);
    });
    test('unrelated edits survive core reapply and anchorless region-wise restore', function () {
        var t = fresh('unrelated'); apply(t, ['--navmd', anchor]);
        var b = fs.readFileSync(t), off = b.length - 17; b[off] = 0xa7; fs.writeFileSync(t, b);
        cli(t, ['apply', '--panel', 'mid', '--yes']); patchedNav(t);
        cli(t, ['revert', '--yes', '--drop-backup']);
        var expected = Buffer.from(fixture.buf); expected[off] = 0xa7;
        assert(fs.readFileSync(t).equals(expected)); dropped(t);
    });
    test('stored recoveryOnly cannot force full restore or discard unrelated edits', function () {
        [true, 'true', 1, {}].forEach(function (value, i) {
            var t = fresh('stored-runtime-flag' + i); apply(t, ['--navmd', anchor]);
            var m = meta(t); m.navmd.recoveryOnly = value; setMeta(t, m);
            var b = fs.readFileSync(t), off = b.length - 1; b[off] = 0x55; fs.writeFileSync(t, b);
            cli(t, ['revert', '--yes']);
            var expected = Buffer.from(fixture.buf); expected[off] = 0x55;
            assert(fs.readFileSync(t).equals(expected), 'stored runtime flag must not select full restore');
            assert(fs.existsSync(t + '.woc-orig'));
        });
    });
    test('unsafe requested anchors refuse before first backup/write and cannot drop a legacy backup', function () {
        var t = fresh('unsafe');
        cli(t, ['apply', '--panel', 'high', '--unproven', '--yes', '--navmd', 'NotAForwarder'], null, true);
        assert(fs.readFileSync(t).equals(fixture.buf)); dropped(t);
        apply(t, ['--navmd', anchor]); var m = meta(t); delete m.navmd; setMeta(t, m);
        var before = fs.readFileSync(t);
        cli(t, ['revert', '--navmd', 'NotAForwarder', '--yes', '--drop-backup'], null, true);
        assert(fs.readFileSync(t).equals(before)); assert(fs.existsSync(t + '.woc-orig'));
        cli(t, ['revert', '--navmd', anchor, '--yes', '--drop-backup']); assert(fs.readFileSync(t).equals(fixture.buf));
    });
    test('corrupted, mismatched and unsupported records never authorize restore or backup deletion', function () {
        var mutations = [
            function (m) { m.navmd.anchor = 'NotAForwarder'; },
            function (m) { m.navmd.anchor = ''; },
            function (m) { m.navmd.anchor = 'void'; },
            function (m) { m.navmd.anchor = 12; },
            function (m) { m.navmd.offset++; },
            function (m) { m.navmd.original = m.navmd.patched; },
            function (m) { m.navmd.patched = m.navmd.original; },
            function (m) { m.navmd.sha256_original = new Array(65).join('0'); },
            function (m) { m.navmd.buildId = 'wrong-build'; },
            function (m) { m.navmd.schema = 2; },
            function (m) { m.navmd.proof.name = 'void other::Thing::skip()'; },
            function (m) { m.navmd.proof.nameLoad++; },
            function (m) { m.navmd.proof.forwarder++; },
            function (m) { m.navmd.proof.ret++; },
            function (m) { m.navmd = null; },
            function (m) { m.sha256_original = new Array(65).join('0'); },
            function (m) { m.buildId = 'wrong-build'; }
        ];
        mutations.forEach(function (mutate, i) {
            var t = fresh('corrupt' + i); apply(t, ['--navmd', anchor]); var m = meta(t); mutate(m); setMeta(t, m);
            var before = fs.readFileSync(t), mb = fs.readFileSync(t + '.woc-orig.json');
            assert(/restorable: no/.test(cli(t, ['status'])));
            assert(/patchable: no/.test(cli(t, ['probe'])));
            cli(t, ['verify'], null, true);
            cli(t, ['revert', '--yes', '--force', '--drop-backup'], null, true);
            cli(t, ['apply', '--panel', 'mid', '--yes'], null, true);
            assert(fs.readFileSync(t).equals(before)); assert(fs.readFileSync(t + '.woc-orig.json').equals(mb));
            assert(fs.existsSync(t + '.woc-orig'));
        });
    });
    test('metadata write failure occurs before target write', function () {
        var t = fresh('write-failure'); apply(t); var before = fs.readFileSync(t);
        fs.mkdirSync(t + '.woc-orig.json.tmp');
        cli(t, ['apply', '--panel', 'high', '--navmd', anchor, '--yes'], null, true);
        assert(fs.readFileSync(t).equals(before)); originalNav(t);
        assert.strictEqual(meta(t).navmd, undefined); assert(fs.existsSync(t + '.woc-orig'));
    });
    console.log('\n' + count + ' navmd recovery checks passed');
} finally { remove(root); }
