// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Optional navmd safety regressions. Mutations live here, not in the shared
 * synthetic fixture or the legacy locator suite. Node 8, no dependencies. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var locator = require('../carplay_locate.js');
var synthetic = require('./synthetic_carplay.js');
var anchor = 'forwardToHmi', count = 0;
var shifted = { pad: 0x180, codeVa: 0x18000, dataVa: 0x700000,
    dataAt: 0x2800, highViaJne: true, midFirst: true };
function check(name, fn) { fn(); count++; console.log('ok   ' + name); }
function put(b, p, hex) { Buffer.from(hex, 'hex').copy(b, p); }
function branch(b, p, target, op) { b[p] = op || 0xe8; b.writeInt32LE(target - p - 5, p + 1); }
function shortBranch(b, p, target, op) { b[p] = op || 0xeb; b.writeInt8(target - p - 2, p + 1); }
function caller(s, hex, callDelta, suffix) {
    var b = s.buf, p = s.at.navmdCall;
    b.fill(0, p, p + 16); put(b, p, hex);
    branch(b, p + callDelta, s.at.navmdForwarder);
    put(b, p + callDelta + 5, suffix || 'c3');
}
function forwarder(s, hex) {
    s.buf.fill(0, s.at.navmdForwarder + 7, s.at.navmdCall);
    put(s.buf, s.at.navmdForwarder + 7, hex);
}
function relocation(s, off) {
    /* Move the synthetic RELATIVE relocation off the required sink edit. */
    var d = s.at.dyn, b = s.buf, va = b.readUInt32LE(d + 8);
    var rela = va - 0x600000 + 0x2000;
    b.writeUInt32LE(0x10000 + off, rela); b.writeUInt32LE(0, rela + 4);
}
var mutations = [
    ['movabs immediate E8', function (s) {
        caller(s, '48b8', 2, '112233c3');
    }, /boundary|unsupported/],
    ['MOV imm32 E8', function (s) {
        var p = s.at.navmdCall; s.buf.fill(0, p, p + 16);
        s.buf[p] = 0xb8; branch(s.buf, p + 1, s.at.navmdForwarder);
        put(s.buf, p + 6, 'c3');
    }, /boundary|unsupported/],
    ['LEA disp32 E8', function (s) {
        caller(s, '488d0d', 3, 'c3');
    }, /boundary|unsupported/],
    ['operand-size prefixed call', function (s) { caller(s, '66', 1); }, /unsupported/],
    ['REX prefixed call', function (s) { caller(s, '48', 1); }, /unsupported/],
    ['repeated REX before movabs', function (s) { caller(s, '4848b8', 3); }, /unsupported/],
    ['address-size prefix', function (s) { caller(s, '67', 1); }, /unsupported/],
    ['unknown opcode before call', function (s) { caller(s, '0f0b', 2); }, /unsupported/],
    ['unsupported ModRM/SIB memory form', function (s) { caller(s, '488b0424', 4); }, /unsupported/],
    ['self-name LEA embedded in movabs is not an entry instruction', function (s) {
        var b = s.buf, p = s.at.navmdForwarder;
        var st = b.indexOf('void carplay::navi_handler::GuidanceMetadata');
        b.fill(0, p, s.at.navmdCall); put(b, p, '48b8488d0d0000000011c3');
        b.writeInt32LE(0x600000 + st - 0x2000 - (0x10000 + p + 9), p + 5);
    }, /self-name load/],
    ['unknown opcode in forwarder', function (s) { forwarder(s, '0f0bc3'); }, /unsupported/],
    ['RET imm16 is not bare RET', function (s) { forwarder(s, 'c20000'); }, /unsupported/],
    ['incoming E9 video tail jump', function (s) {
        branch(s.buf, s.at.onSuggestUi + 33, s.at.navmdForwarder, 0xe9);
    }, /incoming direct tail jump/],
    ['incoming E9 to decoded RET', function (s) {
        branch(s.buf, s.at.onSuggestUi + 33, s.at.navmdRet, 0xe9);
    }, /incoming direct tail jump/],
    ['incoming short tail jump', function (s) {
        shortBranch(s.buf, s.at.navmdCall + 6, s.at.navmdForwarder);
    }, /incoming direct tail jump/],
    ['outgoing E9 video tail jump', function (s) {
        forwarder(s, 'e900000000c3');
        branch(s.buf, s.at.navmdForwarder + 7, s.at.requestStream, 0xe9);
    }, /jump\/branch.*video/],
    ['outgoing E9 setStreamStatus tail jump', function (s) {
        forwarder(s, 'e900000000c3');
        branch(s.buf, s.at.navmdForwarder + 7, s.at.setStreamStatus, 0xe9);
    }, /jump\/branch.*video/],
    ['outgoing E9 onSuggestUi tail jump', function (s) {
        forwarder(s, 'e900000000c3');
        branch(s.buf, s.at.navmdForwarder + 7, s.at.onSuggestUi, 0xe9);
    }, /jump\/branch.*video/],
    ['outgoing short video tail jump', function (s) {
        forwarder(s, 'eb00c3');
        shortBranch(s.buf, s.at.navmdForwarder + 7, s.at.onSuggestUi);
    }, /jump\/branch.*video/],
    ['outgoing direct video call', function (s) {
        forwarder(s, 'e800000000c3');
        branch(s.buf, s.at.navmdForwarder + 7, s.at.setStreamStatus);
    }, /calls the video path/],
    ['bool consumed-return repro', function (s) {
        var st = s.buf.indexOf('void carplay::navi_handler::GuidanceMetadata');
        s.buf.write('bool', st, 'latin1'); forwarder(s, 'b801000000c3');
        caller(s, 'b800000000', 5, '85c00f94c0c3');
    }, /void signature/],
    ['void name still cannot authorize changed RAX returned to parent', function (s) {
        forwarder(s, 'b801000000c3');
    }, /return-value safety/],
    ['void name cannot authorize explicit consumed return', function (s) {
        caller(s, '', 0, '85c0c3');
    }, /unsupported|return-value safety/],
    ['XOR EAX alone cannot discard RDX', function (s) {
        forwarder(s, 'ba01000000c3'); caller(s, '', 0, '31c0c3');
    }, /return-value safety/],
    ['callee-saved write cannot be skipped', function (s) {
        forwarder(s, 'bb01000000c3'); caller(s, '', 0, '31c031d2c3');
    }, /return-value safety/],
    ['RSP write cannot be skipped', function (s) {
        forwarder(s, 'bc01000000c3'); caller(s, '', 0, '31c031d2c3');
    }, /return-value safety/],
    ['external CALL can change FP result despite clearing integer results', function (s) {
        forwarder(s, 'e800000000c3');
        branch(s.buf, s.at.navmdForwarder + 7, s.at.cmdCall);
        caller(s, '', 0, '31c031d2c3');
    }, /return-value safety/],
    ['trailing literal C3 is not decoded RET', function (s) {
        forwarder(s, 'c300000000c3000000');
    }, /non-padding after decoded ret/],
    ['RET byte embedded in MOV immediate', function (s) {
        forwarder(s, 'b80000c300');
    }, /unsupported|does not end in ret/],
    ['relocation covers actual decoded RET', function (s) {
        relocation(s, s.at.navmdRet);
    }, /relocation/, { relocSink: true }],
    ['relocation covers CALL', function (s) {
        relocation(s, s.at.navmdCall);
    }, /relocation/, { relocSink: true }],
    ['relocation covers boundary evidence before CALL', function (s) {
        caller(s, 'b911223344', 5);
        relocation(s, s.at.navmdCall);
    }, /relocation/, { relocSink: true }],
    ['rare relocated literal C3 repro', function (s) {
        s.buf.writeUInt32LE(7, 64 + 4); /* executable writable LOAD, no DT_TEXTREL */
        forwarder(s, 'c300000000c3000000');
        relocation(s, s.at.navmdForwarder + 8);
    }, /non-padding after decoded ret|relocation/, { relocSink: true }],
];

[{}, shifted].forEach(function (opts, index) {
    check('true CALL allowed, decoded RET, original/patched readback (' + index + ')', function () {
        var s = synthetic.build(opts), original = Buffer.from(s.buf), l = locator.locate(s.buf, anchor);
        assert(l.ok && l.navmd.ok, JSON.stringify(l));
        assert.strictEqual(l.navmd.offset, s.at.navmdCall);
        assert.strictEqual(l.navmd.ret, s.at.navmdRet);
        assert.strictEqual(l.navmd.original, s.at.navmdOriginal);
        assert.strictEqual(l.navmd.patched, s.at.navmdPatched);
        assert(s.buf.equals(original), 'locator must be read-only');
        put(s.buf, l.navmd.offset, l.navmd.patched);
        l = locator.locate(s.buf, anchor); assert(l.ok && l.navmd.ok, JSON.stringify(l));
        assert.strictEqual(l.navmd.offset, s.at.navmdCall);
        assert.strictEqual(l.navmd.original, s.at.navmdOriginal);
        assert.strictEqual(l.navmd.patched, s.at.navmdPatched);
        put(s.buf, l.navmd.offset, l.navmd.original); assert(s.buf.equals(original));
    });
});
check('true CALL after decoded movabs containing harmless E8/C3 bytes', function () {
    var s = synthetic.build({}); caller(s, '48b9e81122334455c377', 10);
    var l = locator.locate(s.buf, anchor); assert(l.navmd.ok, JSON.stringify(l.navmd));
    assert.strictEqual(l.navmd.offset, s.at.navmdCall + 10);
});
check('leaf GPR return clobber is allowed only with full discard suffix', function () {
    var s = synthetic.build({}); forwarder(s, 'b801000000c3'); caller(s, '', 0, '31c031d2c3');
    var l = locator.locate(s.buf, anchor); assert(l.navmd.ok, JSON.stringify(l.navmd));
    put(s.buf, l.navmd.offset, l.navmd.patched);
    assert(locator.locate(s.buf, anchor).navmd.ok);
});
check('without navmd, unsupported optional body does not block four original edits', function () {
    var s = synthetic.build({}); forwarder(s, '0f0bc3');
    var l = locator.locate(s.buf); assert(l.ok); assert.strictEqual(l.navmd, undefined);
    assert(locator.locate(synthetic.build({ noNavmd: true }).buf).ok);
});
mutations.forEach(function (m) {
    check(m[0] + ': locator refuses without buffer writes', function () {
        var s = synthetic.build(m[3] || {}); m[1](s);
        var before = Buffer.from(s.buf), l = locator.locate(s.buf, anchor);
        assert(l.ok, 'required edits unaffected: ' + JSON.stringify(l));
        assert(l.navmd && !l.navmd.ok, JSON.stringify(l.navmd));
        assert(m[2].test(l.navmd.reason), l.navmd.reason);
        assert(s.buf.equals(before), 'locator wrote input');
        assert(locator.locate(s.buf).ok, 'optional refusal must not gate required edits');
    });
});

var invalidAnchors = ['/.*', '/', ' /.*', '\t/.*', '   '];
invalidAnchors.forEach(function (badAnchor) {
    check('empty/blank substring ' + JSON.stringify(badAnchor) + ': bounded pure locator refuses', function () {
        /* Run the pure locator in a child too: a regression must fail on timeout,
         * never hang this test process inside namedString's empty-key scan. */
        var script = "var assert = require('assert');" +
            "var locator = require(" + JSON.stringify(path.join(__dirname, '../carplay_locate.js')) + ");" +
            "var synthetic = require(" + JSON.stringify(path.join(__dirname, 'synthetic_carplay.js')) + ");" +
            "var s = synthetic.build({}), before = Buffer.from(s.buf);" +
            "var l = locator.locate(s.buf, process.argv[1]);" +
            "assert(l.ok && l.navmd && !l.navmd.ok, JSON.stringify(l));" +
            "assert(/anchor substring/.test(l.navmd.reason), l.navmd.reason);" +
            "assert(s.buf.equals(before), 'locator wrote input');";
        var r = cp.spawnSync(process.execPath, ['-e', script, badAnchor],
            { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
        assert.ifError(r.error);
        assert.strictEqual(r.signal, null, 'locator timed out or was killed');
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    });
});

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'navmd-safety-'));
function cli(args, timeout) {
    return cp.spawnSync(process.execPath, [path.join(__dirname, '../carplay_patch.js')].concat(args),
        { encoding: 'utf8', timeout: timeout || 0, killSignal: 'SIGKILL',
            env: Object.assign({}, process.env, { WOC_NAVMD_ANCHOR: '' }) });
}
try {
    invalidAnchors.forEach(function (badAnchor, i) {
        check('empty/blank substring ' + JSON.stringify(badAnchor) + ': bounded CLI refuses without writes', function () {
            var dir = path.join(tmp, 'invalid-anchor-' + i); fs.mkdirSync(dir);
            var target = path.join(dir, 'carplay'), s = synthetic.build({});
            fs.writeFileSync(target, s.buf); var files = fs.readdirSync(dir);
            var r = cli(['apply', '--target', target, '--panel', 'high', '--unproven', '--navmd', badAnchor, '--yes'], 5000);
            assert.ifError(r.error);
            assert.strictEqual(r.signal, null, 'CLI timed out or was killed');
            assert(r.status !== 0, r.stdout + r.stderr);
            assert(/navmd/.test(r.stdout + r.stderr), r.stdout + r.stderr);
            assert(fs.readFileSync(target).equals(s.buf), 'target changed');
            assert.deepStrictEqual(fs.readdirSync(dir), files, 'backup or temporary file created');
        });
    });
    mutations.forEach(function (m, i) {
        check(m[0] + ': real CLI apply refuses before target/backup/temp writes', function () {
            var dir = path.join(tmp, 'mutation-' + i); fs.mkdirSync(dir);
            var target = path.join(dir, 'carplay'), s = synthetic.build(m[3] || {}); m[1](s);
            fs.writeFileSync(target, s.buf); var files = fs.readdirSync(dir);
            var r = cli(['apply', '--target', target, '--panel', 'high', '--unproven', '--navmd', anchor, '--yes']);
            assert(r.status !== 0, r.stdout + r.stderr);
            assert(/navmd/.test(r.stdout + r.stderr), r.stdout + r.stderr);
            assert(fs.readFileSync(target).equals(s.buf), 'target changed');
            assert.deepStrictEqual(fs.readdirSync(dir), files, 'backup or temporary file created');
        });
    });
    check('real CLI applies and verifies shifted navmd, persisted-anchor readback', function () {
        var dir = path.join(tmp, 'valid'); fs.mkdirSync(dir);
        var target = path.join(dir, 'carplay'), s = synthetic.build(shifted); fs.writeFileSync(target, s.buf);
        var r = cli(['apply', '--target', target, '--panel', 'high', '--unproven', '--navmd', anchor, '--yes']);
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        var b = fs.readFileSync(target), l = locator.locate(b, anchor);
        assert(l.ok && l.navmd.ok, JSON.stringify(l));
        assert.strictEqual(b.toString('hex', l.navmd.offset, l.navmd.offset + 5), l.navmd.patched);
        r = cli(['verify', '--target', target, '--navmd', anchor]);
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert(fs.readFileSync(target + '.woc-orig').equals(s.buf));
        r = cli(['verify', '--target', target]);
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        assert(/navmd dropped/.test(r.stdout), r.stdout);
        r = cli(['apply', '--target', target, '--panel', 'mid', '--yes']);
        assert.strictEqual(r.status, 0, r.stdout + r.stderr);
        l = locator.locate(fs.readFileSync(target), anchor);
        assert(l.navmd.ok && fs.readFileSync(target).toString('hex', l.navmd.offset, l.navmd.offset + 5) === l.navmd.patched);
        /* Also fail if a relocated target is encountered in already-patched state. */
        var rel = synthetic.build({ relocSink: true });
        relocation(rel, rel.at.navmdRet); put(rel.buf, rel.at.navmdCall, rel.at.navmdPatched);
        assert(!locator.locate(rel.buf, anchor).navmd.ok);
    });
} finally {
    /* Node 8 has no fs.rmSync/recursive rmdir; only our own temp files. */
    fs.readdirSync(tmp).forEach(function (d) {
        var dir = path.join(tmp, d);
        fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
        fs.rmdirSync(dir);
    });
    fs.rmdirSync(tmp);
}
console.log('\n' + count + ' navmd safety checks passed');
