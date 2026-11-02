// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* carplay_locate.js — finds the four carplay-patch edit sites (PATCH.md) in a
 * carplay build by code and data structure. Each site has to be found exactly
 * once and pass its semantic checks; otherwise that edit carries ok:false and
 * a short reason naming what was not found. File offsets and virtual
 * addresses are converted through the ELF program headers, and function
 * bounds come from the .eh_frame_hdr search table. The variant, self-start and
 * resolution sites are found from the functions that load their own name
 * strings, and a site a dynamic relocation would rewrite at load is refused.
 * It only reads the buffer.
 *
 * Node 8 on the unit, no dependencies.
 */
'use strict';

var SINK_STOCK = 'avb://media_transport.avb_streaming.15?mime_type=video/H264';
var SINK_NEXT = 'mCarPlay->GetDisplaySource(';
var REDIRECT = /^(file|udp|tcp):\/\/[^\0]+$/;
var IC_HIGH = 0, IC_MID = 1, OTHER = 2, NOT_ACTIVE = 3, SLOT = 7;
/* A function's own name string is loaded by its logging prologue, within
 * ENTRY bytes of its start; functions of one source file lie within NEAR. */
var ENTRY = 0x60, NEAR = 0x10000;

/* A 64-bit field of a file under 4 GiB, else null. */
function u64(buf, off) { return buf.readUInt32LE(off + 4) === 0 ? buf.readUInt32LE(off) >>> 0 : null; }

function parseElf(buf) {
    if (buf.length < 64 || buf.readUInt32BE(0) !== 0x7f454c46) return { reason: 'not an ELF file' };
    if (buf[4] !== 2 || buf[5] !== 1 || buf.readUInt16LE(18) !== 62) return { reason: 'not a 64-bit little-endian x86-64 ELF' };
    var phoff = u64(buf, 0x20), phentsize = buf.readUInt16LE(0x36), phnum = buf.readUInt16LE(0x38);
    if (phoff === null || phoff + phnum * phentsize > buf.length) return { reason: 'ELF program headers out of range' };
    var elf = { load: [], exec: null, eh: null, notes: [], dyn: null, dynBad: false };
    for (var i = 0; i < phnum; i++) {
        var o = phoff + i * phentsize, type = buf.readUInt32LE(o);
        var seg = { off: u64(buf, o + 8), va: u64(buf, o + 16), size: u64(buf, o + 32) };
        if (seg.off === null || seg.va === null || seg.size === null || seg.off + seg.size > buf.length) {
            if (type === 2) elf.dynBad = true;          /* a PT_DYNAMIC outside the file */
            continue;
        }
        if (type === 1) {                               /* PT_LOAD; PF_X marks the code */
            elf.load.push(seg);
            if ((buf.readUInt32LE(o + 4) & 1) && !elf.exec) elf.exec = { off: seg.off, end: seg.off + seg.size };
        } else if (type === 0x6474e550) elf.eh = seg;   /* PT_GNU_EH_FRAME */
        else if (type === 4) elf.notes.push(seg);       /* PT_NOTE */
        else if (type === 2) elf.dyn = seg;             /* PT_DYNAMIC */
    }
    if (!elf.exec) return { reason: 'no executable ELF segment' };
    return elf;
}

/* The GNU build-id of an ELF image as hex, or null: what tells one build
 * from another without locating anything. */
function elfBuildId(buf) {
    var elf = parseElf(buf);
    return elf.load ? buildId(buf, elf.notes) : null;
}

/* The GNU build-id note as hex, or null. */
function buildId(buf, notes) {
    for (var n = 0; n < notes.length; n++) {
        for (var o = notes[n].off, end = o + notes[n].size; o + 12 <= end;) {
            var namesz = buf.readUInt32LE(o), descsz = buf.readUInt32LE(o + 4);
            var desc = o + 12 + ((namesz + 3) & ~3);
            if (desc + descsz > end) break;
            if (buf.readUInt32LE(o + 8) === 3 && namesz === 4 && buf.toString('latin1', o + 12, o + 16) === 'GNU\0')
                return buf.toString('hex', desc, desc + descsz);
            o = desc + ((descsz + 3) & ~3);
        }
    }
    return null;
}

/* The image: offset/address conversion, function bounds and code scans. */
function Image(buf, elf) {
    this.buf = buf;
    this.load = elf.load;
    this.exec = elf.exec;
    this.starts = funcStarts(buf, elf.eh);
    this.dyn = elf.dyn;
    this.dynBad = elf.dynBad;
    this.callIndex = null;
}
Image.prototype.va = function (off) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (off >= s.off && off < s.off + s.size) return s.va + (off - s.off);
    }
    return null;
};
Image.prototype.off = function (va) {
    for (var i = 0; i < this.load.length; i++) {
        var s = this.load[i];
        if (va >= s.va && va < s.va + s.size) return s.off + (va - s.va);
    }
    return null;
};
/* The function holding `off`, as file offsets { off, end }, or null. */
Image.prototype.func = function (off) {
    var va = this.va(off), s = this.starts, lo = 0, hi = s.length - 1, at = -1;
    while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (s[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) return null;
    var start = this.off(s[at]);
    var end = at + 1 < s.length ? this.off(s[at + 1]) : this.exec.end;
    return start === null || end === null || end > this.exec.end ? null : { off: start, end: end };
};
/* The target (file offset) of a rel32 branch whose 4-byte displacement is
 * at `pos` and whose next instruction starts at `next`. */
Image.prototype.rel = function (pos, next) {
    var va = this.va(next);
    return va === null ? null : this.off((va + this.buf.readInt32LE(pos)) >>> 0);
};
/* The `call rel32` instructions in [start, end): [{ at, to }]. */
Image.prototype.calls = function (start, end) {
    var out = [];
    for (var p = start; p + 5 <= end; p++) {
        if (this.buf[p] === 0xe8) { var to = this.rel(p + 1, p + 5); if (to !== null) out.push({ at: p, to: to }); }
    }
    return out;
};

/* The offsets of the `call rel32` instructions anywhere in the code
 * segment that reach `to`. */
Image.prototype.callers = function (to) {
    if (!this.callIndex) {
        var idx = {}, all = this.calls(this.exec.off, this.exec.end);
        all.forEach(function (c) { (idx[c.to] = idx[c.to] || []).push(c.at); });
        this.callIndex = idx;
    }
    return this.callIndex[to] || [];
};

/* Function start addresses from .eh_frame_hdr's search table (version 1,
 * eh_frame_ptr pcrel sdata4, fde_count udata4, table datarel sdata4: the GCC
 * encoding), sorted; empty when the build has no such table. */
function funcStarts(buf, eh) {
    if (!eh || eh.size < 12 || buf.readUInt32BE(eh.off) !== 0x011b033b) return [];
    var count = buf.readUInt32LE(eh.off + 8), table = eh.off + 12;
    if (table + count * 8 > eh.off + eh.size) return [];
    var starts = [];
    for (var i = 0; i < count; i++) starts.push((eh.va + buf.readInt32LE(table + i * 8)) >>> 0);
    return starts.sort(function (a, b) { return a - b; });
}

/* Offsets matching `pat` (bytes, null = any) in [start, end). */
function scan(buf, start, end, pat) {
    var out = [];
    for (var i = start; i + pat.length <= end; i++) {
        if (buf[i] !== pat[0]) continue;
        for (var j = 1; j < pat.length && (pat[j] === null || buf[i + j] === pat[j]); j++);
        if (j === pat.length) out.push(i);
    }
    return out;
}
function any(n) { var a = []; while (n--) a.push(null); return a; }

/* The NUL-terminated string at `off`. */
function stringAt(buf, off) { var end = buf.indexOf(0, off); return buf.toString('latin1', off, end < 0 ? buf.length : end); }

/* The one string that contains `key` and matches `re`: { off } or { err }. A
 * string starts after the last byte before it that is not printable ASCII. */
function namedString(buf, key, re, label) {
    var found = [], k = Buffer.from(key, 'latin1');
    for (var i = buf.indexOf(k); i >= 0; i = buf.indexOf(k, i + 1)) {
        var s = i;
        while (s > 0 && buf[s - 1] >= 0x20 && buf[s - 1] < 0x7f) s--;
        if (found.indexOf(s) < 0 && re.test(stringAt(buf, s))) found.push(s);
    }
    if (found.length === 1) return { off: found[0] };
    return { err: label + (found.length ? ' string found ' + found.length + ' times' : ' string not found') };
}

/* The rip-relative lea instructions (REX.W 8d, mod 00 rm 101) whose target is
 * one of `offs`: { off: [lea offsets] }. */
function leaRefs(im, offs) {
    var want = {}, out = {}, buf = im.buf;
    offs.forEach(function (o) { var va = im.va(o); if (va !== null) { want[va] = o; out[o] = []; } });
    for (var p = im.exec.off + 1; p + 6 <= im.exec.end; p++) {
        if (buf[p] !== 0x8d || (buf[p - 1] & 0xfb) !== 0x48 || (buf[p + 1] & 0xc7) !== 0x05) continue;
        var va = im.va(p + 6);
        var t = va === null ? null : want[(va + buf.readInt32LE(p + 2)) >>> 0];
        if (t !== undefined && t !== null) out[t].push(p - 1);
    }
    return out;
}

/* The one function referencing a string: { off, end } or { err }. */
function funcOfString(im, refs, str, label) {
    if (str.err) return str;
    var sites = refs[str.off] || [];
    if (!sites.length) return { err: label + ' string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) {
        var g = im.func(sites[i]);
        if (!g || g.off !== f.off) return { err: label + ' used by several functions' };
    }
    return f || { err: label + ' outside the function table' };
}

function hex32(n) { return Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]).toString('hex'); }

/* ---- Edit 1: the KI_KOMBI_VARIANT converter switch ---------------------- */

/* cmp byte [rdi],imm8 ; ja ; movzx eax,byte [rdi] ; lea rdx,[rip+table] ;
 * movsxd rax,[rdx+rax*4] ; add rax,rdx ; jmp rax. Several switches share the
 * shape; the converter is the one whose table decodes to the variant mapping. */
var SWITCH = [0x80, 0x3f, null, 0x77, null, 0x0f, 0xb6, 0x07, 0x48, 0x8d, 0x15, null, null, null, null,
    0x48, 0x63, 0x04, 0x82, 0x48, 0x01, 0xd0, 0xff, 0xe0];

/* The converter is the function loading its own name string
 * (`bool …codingToInternal(const …eKI_KOMBI_VARIANT&, …KombiVariant::Values&)`),
 * and its switch is the one in it. A switch elsewhere that decodes to the
 * same mapping is another copy of the converter, which the edit would leave
 * unpatched: refused. */
function locateVariant(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'variant: no function table' };
    var conv = funcOfString(im, refs, str.conv, NAMES.conv[2]);
    if (conv.err) return { ok: false, reason: conv.err };
    var inside = [], outside = 0;
    scan(im.buf, im.exec.off, im.exec.end, SWITCH).forEach(function (m) {
        var d = decodeSwitch(im, m);
        if (m >= conv.off && m < conv.end) inside.push(d);
        else if (d.ok) outside++;
    });
    if (outside) return { ok: false, reason: 'variant: converter switch also outside codingToInternal' };
    var good = inside.filter(function (t) { return t.ok; });
    if (good.length === 1) return good[0];
    if (good.length > 1) return { ok: false, reason: 'variant: converter switch found ' + good.length + ' times' };
    /* None decodes: a table large enough for the variant values is the
     * converter's, and its reason says what is wrong with it. */
    var sized = inside.filter(function (t) { return !t.small; });
    return sized.length === 1 ? sized[0] : { ok: false, reason: 'variant: converter switch not found' };
}

/* The switch at `m`: raw 9 -> IC_HIGH, 10 -> IC_MID, 0 -> NOT_ACTIVE, every
 * other raw value -> OTHER through one shared table value, and slot 7 that
 * OTHER value (stock) or slot 9's or 10's (patched). */
function decodeSwitch(im, m) {
    var buf = im.buf, n = buf[m + 2] + 1;
    if (n < 11) return { ok: false, small: true, reason: 'variant: converter table too small (' + n + ')' };
    var tableVa = im.va(m + 15);
    var table = tableVa === null ? null : im.off((tableVa + buf.readInt32LE(m + 11)) >>> 0);
    if (table === null || table + n * 4 > buf.length) return { ok: false, reason: 'variant: converter table out of range' };
    var vals = [], kinds = [];
    for (var i = 0; i < n; i++) {
        vals.push(buf.readUInt32LE(table + i * 4));
        var h = im.off((im.va(table) + buf.readInt32LE(table + i * 4)) >>> 0);
        /* each handler stores the internal value: mov dword [rsi],imm32 */
        if (h === null || h + 6 > buf.length || buf[h] !== 0xc7 || buf[h + 1] !== 0x06)
            return { ok: false, reason: 'variant: slot ' + i + ' handler not a store' };
        kinds.push(buf.readUInt32LE(h + 2));
    }
    if (kinds[9] !== IC_HIGH) return { ok: false, reason: 'variant: slot 9 is not IC_HIGH' };
    if (kinds[10] !== IC_MID) return { ok: false, reason: 'variant: slot 10 is not IC_MID' };
    if (kinds[0] !== NOT_ACTIVE) return { ok: false, reason: 'variant: slot 0 is not NOT_ACTIVE' };
    var other = null;
    for (var k = 1; k < n; k++) {
        if (k === 9 || k === 10 || k === SLOT) continue;
        if (kinds[k] !== OTHER) return { ok: false, reason: 'variant: slot ' + k + ' is not OTHER' };
        if (other !== null && vals[k] !== other) return { ok: false, reason: 'variant: OTHER slots differ' };
        other = vals[k];
    }
    if ([other, vals[9], vals[10]].indexOf(vals[SLOT]) < 0) return { ok: false, reason: 'variant: slot 7 not OTHER/IC_HIGH/IC_MID' };
    return { ok: true, table: table, slots: n, slot: table + SLOT * 4, original: other, high: vals[9], mid: vals[10] };
}

/* ---- Edit 2: the second-stream sink URL --------------------------------- */

/* The URL is its own string, followed after a NUL run by the string
 * `mCarPlay->GetDisplaySource( …`: the stock URL, or a redirect NUL-padded to
 * the stock URL's length. The slot ends at least one NUL and at most 16
 * alignment NULs before that string. */
function locateSink(buf) {
    var found = [], next = Buffer.from(SINK_NEXT, 'latin1'), len = SINK_STOCK.length;
    for (var i = buf.indexOf(next); i >= 0; i = buf.indexOf(next, i + 1)) {
        var e = i, s;
        while (e > 0 && buf[e - 1] === 0) e--;
        for (s = e; s > 0 && buf[s - 1] !== 0; s--);
        var url = buf.toString('latin1', s, e);
        if (s > 0 && i - s > len && i - s <= len + 16 && (url === SINK_STOCK || (REDIRECT.test(url) && url.length <= len))) found.push(s);
    }
    if (found.length === 0) return { ok: false, reason: 'sink: URL slot not found' };
    if (found.length > 1) return { ok: false, reason: 'sink: URL slot found ' + found.length + ' times' };
    return { ok: true, offset: found[0], len: len };
}

/* The slot is the string one `lea` loads; nothing loads a string inside it (a
 * merged string a rewrite would change). `refs` holds the slot's offsets. */
function sinkRefs(s, refs) {
    if (!s.ok) return s;
    function loads(o) { return (refs[o] || []).length; }
    if (loads(s.offset) !== 1) return { ok: false, reason: 'sink: URL slot loaded ' + loads(s.offset) + ' times (want 1)' };
    for (var i = 1; i < s.len; i++) if (loads(s.offset + i)) return { ok: false, reason: 'sink: another string inside the URL slot' };
    return s;
}

/* ---- Edit 3: the self-start call retarget ------------------------------- */

var NAMES = {
    conv: ['codingToInternal(const CodingKOMBI_HUD::eKI_KOMBI_VARIANT&',
        /^bool (?:\w+::)*codingToInternal\(const (?:\w+::)*eKI_KOMBI_VARIANT&, (?:\w+::)*KombiVariant::Values&\)$/, 'variant: codingToInternal'],
    ss: ['AlternateDisplays::setStreamStatus(', /^void (?:\w+::)*AlternateDisplays::setStreamStatus\(/, 'self-start: setStreamStatus'],
    osu: ['AlternateDisplays::onSuggestUi()', /^void (?:\w+::)*AlternateDisplays::onSuggestUi\(\)$/, 'self-start: onSuggestUi'],
    rs: ['AlternateDisplays::requestStream()', /^void (?:\w+::)*AlternateDisplays::requestStream\(\)$/, 'self-start: requestStream'],
    showUi: ['mCinemoCarPlay->ShowUI(', /^mCinemoCarPlay->ShowUI\(/, 'self-start: ShowUI'],
    keyframe: ['mCinemoCarPlay->ForceKeyframe(', /^mCinemoCarPlay->ForceKeyframe\(/, 'self-start: ForceKeyframe'],
    ctor: ['ICSafeAreaProvider::ICSafeAreaProvider(', /^(?:\w+::)*ICSafeAreaProvider::ICSafeAreaProvider\(const (?:\w+::)*KombiVariant::Values&\)$/, 'resolution: ICSafeAreaProvider'],
};

/* The function loading `str` at its entry (its logging prologue): an inlined
 * copy or a split-off part loads it deeper. */
function entryFunc(im, refs, str, label) {
    var f = funcOfString(im, refs, str, label);
    if (f.err) return f;
    return refs[str.off].some(function (p) { return p - f.off < ENTRY; }) ? f : { err: label + ' name not loaded at the function entry' };
}

/* setStreamStatus, requestStream and onSuggestUi by their own function-name
 * strings, each loaded at its function's entry, the three within NEAR of each
 * other. requestStream must reference the ShowUI and ForceKeyframe checks,
 * call setStreamStatus, and be called directly from outside onSuggestUi (a
 * function in its own right, not a callback that inlined it). The site is
 * onSuggestUi's one call to either, with AVAILABLE (1) stored as its argument
 * just before it. */
function locateSelfstart(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'self-start: no function table' };
    var ss = entryFunc(im, refs, str.ss, NAMES.ss[2]);
    var rs = entryFunc(im, refs, str.rs, NAMES.rs[2]);
    var osu = entryFunc(im, refs, str.osu, NAMES.osu[2]);
    var err = ss.err || rs.err || osu.err || str.showUi.err || str.keyframe.err;
    if (err) return { ok: false, reason: err };
    if (Math.max(ss.off, rs.off, osu.off) - Math.min(ss.off, rs.off, osu.off) > NEAR)
        return { ok: false, reason: 'self-start: AlternateDisplays functions far apart' };
    if (!im.callers(rs.off).some(function (p) { return p < osu.off || p >= osu.end; }))
        return { ok: false, reason: 'self-start: requestStream not called directly' };
    function inRs(o) { return refs[o].some(function (p) { return p >= rs.off && p < rs.end; }); }
    if (!inRs(str.showUi.off) || !inRs(str.keyframe.off)) return { ok: false, reason: 'self-start: requestStream lacks ShowUI/keyframe' };
    if (!im.calls(rs.off, rs.end).some(function (c) { return c.to === ss.off; }))
        return { ok: false, reason: 'self-start: requestStream lacks setStreamStatus' };
    var sites = im.calls(osu.off, osu.end).filter(function (c) { return c.to === ss.off || c.to === rs.off; });
    if (sites.length !== 1) return { ok: false, reason: 'self-start: onSuggestUi call ' + (sites.length ? 'found ' + sites.length + ' times' : 'not found') };
    var at = sites[0].at;
    /* mov dword [rsp+disp8],1 */
    if (!scan(im.buf, Math.max(osu.off, at - 24), at, [0xc7, 0x44, 0x24, null, 0x01, 0x00, 0x00, 0x00]).length)
        return { ok: false, reason: 'self-start: call has no AVAILABLE argument' };
    var next = im.va(at + 5);
    return {
        ok: true, offset: at, setStreamStatus: ss.off, requestStream: rs.off, onSuggestUi: osu.off,
        original: 'e8' + hex32(im.va(ss.off) - next), patched: 'e8' + hex32(im.va(rs.off) - next)
    };
}

/* ---- Edit 4: the IC_HIGH geometry builder ------------------------------- */

/* mov [rdi+0x10],rdx (the mm pair, loaded earlier by movabs rdx) ;
 * movabs rax,px ; mov [rdi+8],rax ; mov [rdi+0x18],rax ;
 * movabs rax,safe1 ; mov [rdi+0x20],rax ; movabs rax,safe2 ; mov [rdi+0x28],rax */
var STORES = [0x48, 0x89, 0x57, 0x10, 0x48, 0xb8].concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x08, 0x48, 0x89, 0x47, 0x18, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x20, 0x48, 0xb8]).concat(any(8))
    .concat([0x48, 0x89, 0x47, 0x28]);

/* A geometry builder at `f`: a short function opening with `movabs rdx` (the
 * mm pair) and holding the stores once; its four immediates' offsets, or
 * null. */
function builder(im, f) {
    var fn = im.func(f), buf = im.buf;
    if (!fn || fn.off !== f || fn.end - fn.off > 0x80 || buf[f] !== 0x48 || buf[f + 1] !== 0xba) return null;
    var st = scan(buf, f, fn.end, STORES);
    return st.length === 1 && st[0] > f + 10 ? { builder: f, mm: f + 2, px: st[0] + 6, safe1: st[0] + 24, safe2: st[0] + 38 } : null;
}

/* The getters the builders' fields are read through: the small functions a
 * caller of the constructor calls after it, each reading one field of
 * `this` (mov rax,[rdi+d8] / mov eax,[rdi+d8] / movzx eax,word [rdi+d8]).
 * The edit writes pixel size (+0x18), view x,y (+0x20, +0x22), safe width
 * and height (+0x24) and safe x,y (+0x2c, +0x2e): the getters some caller
 * calls must read each of those, other fields besides, so the immediates
 * mean what the edit writes. */
var FIELDS = ['q18', 'w20', 'w22', 'q24', 'w2c', 'w2e'];
function fieldRead(im, f) {
    var fn = im.func(f), buf = im.buf, found = [];
    if (!fn || fn.off !== f || fn.end - fn.off > 0x40) return null;
    for (var p = f; p + 4 <= fn.end; p++) {
        if (buf[p] === 0x48 && buf[p + 1] === 0x8b && buf[p + 2] === 0x47) found.push('q' + buf[p + 3].toString(16));
        else if (buf[p] === 0x0f && buf[p + 1] === 0xb7 && buf[p + 2] === 0x47) found.push('w' + buf[p + 3].toString(16));
        else if (buf[p] === 0x8b && buf[p + 1] === 0x47 && buf[p - 1] !== 0x48) found.push('d' + buf[p + 2].toString(16));
    }
    return found.length === 1 ? found[0] : null;
}
function layoutRead(im, ctor) {
    return im.callers(ctor.off).some(function (at) {
        var fn = im.func(at);
        if (!fn) return false;
        var got = im.calls(at + 5, Math.min(fn.end, at + 0x100)).map(function (c) { return fieldRead(im, c.to); })
            .filter(function (r) { return r; });
        return FIELDS.every(function (f) { return got.indexOf(f) >= 0; });
    });
}

/* The variant check called at `c`: 'high' for `[rdi] == IC_HIGH`, 'mid' for
 * `[rdi] == IC_MID`, small functions doing mov eax,[rdi] ; test eax,eax ;
 * sete al (or cmp dword [rdi],0 ; sete al) and cmp dword [rdi],1 ; sete al. */
function checkKind(im, to) {
    var fn = im.func(to), buf = im.buf;
    if (!fn || fn.off !== to || fn.end - fn.off > 128) return null;
    if (scan(buf, fn.off, fn.end, [0x8b, 0x07, 0x85, 0xc0, 0x0f, 0x94, 0xc0]).length ||
        scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x00, 0x0f, 0x94, 0xc0]).length) return 'high';
    if (scan(buf, fn.off, fn.end, [0x83, 0x3f, 0x01, 0x0f, 0x94, 0xc0]).length) return 'mid';
    return null;
}

/* The start of the code run when the bool returned by the call at `at` is
 * true: test al,al within 8 bytes, then je (true falls through) or jne (true
 * jumps). */
function trueBranch(im, at, end) {
    var buf = im.buf, t = at + 5, j;
    while (t < Math.min(at + 13, end) && !(buf[t] === 0x84 && buf[t + 1] === 0xc0)) t++;
    if (buf[t] !== 0x84 || buf[t + 1] !== 0xc0) return null;
    j = t + 2;
    if (buf[j] === 0x74) return j + 2;
    if (buf[j] === 0x75) return j + 2 + buf.readInt8(j + 1);
    if (buf[j] === 0x0f && buf[j + 1] === 0x84) return j + 6;
    if (buf[j] === 0x0f && buf[j + 1] === 0x85) return im.rel(j + 2, j + 6);
    return null;
}

/* The ICSafeAreaProvider constructor `(const KombiVariant::Values&)` calls
 * two geometry builders within NEAR of it: the IC_HIGH one on the true branch
 * of its one call to the `variant == IC_HIGH` check, the IC_MID one on the
 * true branch of its one call to the `variant == IC_MID` check. A caller of
 * the constructor reads the fields the edit writes through their getters. */
function locateRes(im, str, refs) {
    if (!im.starts.length) return { ok: false, reason: 'resolution: no function table' };
    var ctor = funcOfString(im, refs, str.ctor, NAMES.ctor[2]);
    if (ctor.err) return { ok: false, reason: ctor.err };
    var calls = im.calls(ctor.off, ctor.end), builders = {}, checks = { high: [], mid: [] };
    calls.forEach(function (c) {
        if (builders[c.to] === undefined) builders[c.to] = builder(im, c.to);
        var k = checkKind(im, c.to);
        if (k) checks[k].push(c);
    });
    var found = Object.keys(builders).filter(function (k) { return builders[k]; });
    if (found.length !== 2) return { ok: false, reason: 'resolution: ' + found.length + ' geometry builders (want 2)' };
    function branchBuilder(kind) {
        if (checks[kind].length !== 1) return { err: 'resolution: IC_' + kind.toUpperCase() + ' check ' + (checks[kind].length ? 'called ' + checks[kind].length + ' times' : 'not found') };
        var branch = trueBranch(im, checks[kind][0].at, ctor.end);
        var c = calls.filter(function (x) { return branch !== null && x.at >= branch && x.at < branch + 16 && builders[x.to]; })[0];
        return c ? { to: c.to } : { err: 'resolution: IC_' + kind.toUpperCase() + ' builder not found' };
    }
    var high = branchBuilder('high'), mid = branchBuilder('mid');
    if (high.err || mid.err) return { ok: false, reason: high.err || mid.err };
    if (high.to === mid.to) return { ok: false, reason: 'resolution: IC_HIGH and IC_MID share a builder' };
    if (Math.abs(high.to - ctor.off) > NEAR || Math.abs(mid.to - ctor.off) > NEAR) return { ok: false, reason: 'resolution: builders far from the constructor' };
    if (!layoutRead(im, ctor)) return { ok: false, reason: 'resolution: geometry getters not found' };
    var b = builders[high.to];
    return { ok: true, builder: high.to, mm: b.mm, px: b.px, safe1: b.safe1, safe2: b.safe2 };
}

/* ---- relocations and version -------------------------------------------- */

/* The edits the loader would rewrite: all of them with text relocations or
 * relocations this cannot read (REL, RELR, or a dynamic segment or table
 * outside the file), else
 * those of `regions` ([edit, off, len]) that a relocation's 8 bytes (RELA or
 * PLT) overlap. { all: why or null, edits } */
function relocated(im, regions) {
    var out = { all: null, edits: [] };
    if (im.dynBad) { out.all = 'relocations not readable'; return out; }
    if (!im.dyn) return out;
    var buf = im.buf, d = {}, rel = [];
    for (var o = im.dyn.off; o + 16 <= im.dyn.off + im.dyn.size; o += 16) {
        var tag = u64(buf, o);
        if (tag === 0) break;
        if (tag !== null) d[tag] = u64(buf, o + 8);
    }
    if (d[22] !== undefined || (d[30] & 4)) { out.all = 'text relocations'; return out; }      /* DT_TEXTREL, DF_TEXTREL */
    if (d[17] !== undefined || d[36] !== undefined) { out.all = 'relocations not readable'; return out; }   /* DT_REL, DT_RELR */
    [[7, 8], [23, 2]].forEach(function (t) {                                  /* DT_RELA/RELASZ, DT_JMPREL/PLTRELSZ */
        if (d[t[0]] === undefined) return;
        var at = d[t[0]] === null ? null : im.off(d[t[0]]), n = d[t[1]] || 0;
        if (at === null || at + n > buf.length) { out.all = 'relocations not readable'; return; }
        for (var r = at; r + 24 <= at + n; r += 24) { var v = u64(buf, r); if (v !== null) rel.push(v); }
    });
    if (out.all) return out;
    regions.forEach(function (g) {
        var va = im.va(g[1]);
        if (va !== null && rel.some(function (v) { return v + 8 > va && v < va + g[2]; }) && out.edits.indexOf(g[0]) < 0) out.edits.push(g[0]);
    });
    return out;
}

/* The carplay version its debug source paths name, or null. */
function version(buf) {
    var re = /\/usr\/src\/debug\/carplay\/([0-9][0-9.]*)\+/g, text = buf.toString('latin1'), m, seen = [];
    while ((m = re.exec(text))) if (seen.indexOf(m[1]) < 0) seen.push(m[1]);
    return seen.length === 1 ? seen[0] : null;
}

/* ---- Edit 5 (optional): the guidance-metadata forward call ---------------- */

/* Optional-only, deliberately small x86-64 whitelist, NOT a disassembler.
 * Encoding reference: Intel SDM Vol. 2, Instruction Format; CALL/JMP/RET,
 * LEA, MOV and XOR (REX, ModRM, displacement and immediate sizes):
 * https://cdrdv2-public.intel.com/835757/325383-sdm-vol-2abcd.pdf
 * Only the forms below are supported. Legacy prefixes, extra REX prefixes,
 * memory operands other than RIP-relative LEA, indirect control flow and
 * unknown opcodes fail closed. Never reuse this for the four legacy scans.
 * Decoding starts at the function-table entry, never at a candidate E8/C3.
 */
function navmdInstruction(im, p, end) {
    var b = im.buf, op = b[p], n = 0, kind = 'other', to = null, dest = null;
    if (op === 0x90) { n = 1; kind = 'nop'; }
    else if (op === 0xc3) { n = 1; kind = 'ret'; }
    else if (op === 0xe8 || op === 0xe9) {
        n = 5; kind = op === 0xe8 ? 'call' : 'jump';
        if (p + n <= end) to = im.rel(p + 1, p + n);
    } else if (op === 0xeb || (op >= 0x70 && op <= 0x7f)) {
        n = 2; kind = 'jump';
        if (p + n <= end) to = im.off(im.va(p + n) + b.readInt8(p + 1));
    } else if (op === 0x0f && b[p + 1] >= 0x80 && b[p + 1] <= 0x8f) {
        n = 6; kind = 'jump';
        if (p + n <= end) to = im.rel(p + 2, p + n);
    } else if (op >= 0xb8 && op <= 0xbf) { n = 5; dest = op - 0xb8; } /* MOV r32,imm32 */
    else if (op >= 0x48 && op <= 0x4f && b[p + 1] >= 0xb8 && b[p + 1] <= 0xbf) {
        n = 10; dest = b[p + 1] - 0xb8 + ((op & 1) ? 8 : 0);
    } /* REX.W MOV r64,imm64: its E8/C3 bytes are data */
    else if ((op === 0x48 || op === 0x4c) && b[p + 1] === 0x8d && (b[p + 2] & 0xc7) === 0x05) {
        n = 7; kind = 'lea'; dest = ((b[p + 2] >> 3) & 7) + (op === 0x4c ? 8 : 0);
        /* mod=00, r/m=101: RIP + disp32, no SIB */
    } else if ((op === 0x31 || op === 0x33) && (b[p + 1] & 0xc0) === 0xc0) {
        n = 2; kind = 'xor'; dest = op === 0x31 ? (b[p + 1] & 7) : ((b[p + 1] >> 3) & 7);
        /* only register-register XOR r32,r32 */
    }
    return n && p + n <= end ? { at: p, end: p + n, kind: kind, to: to, dest: dest } : null;
}

/* A single straight-line body ending at a decoded RET, followed ONLY by
 * alignment bytes. In particular, a trailing C3 in a literal is not a RET.
 * Branching/indirect bodies are outside this optional edit's supported set. */
function navmdBody(im, f) {
    var ins = [], p = f.off;
    while (p < f.end) {
        var d = navmdInstruction(im, p, f.end);
        if (!d) return { err: 'unsupported instruction encoding at ' + p };
        ins.push(d); p = d.end;
        if (d.kind === 'ret') {
            for (var q = p; q < f.end; q++)
                if ([0, 0x90, 0xcc].indexOf(im.buf[q]) < 0)
                    return { err: 'non-padding after decoded ret' };
            return { ins: ins, ret: d.at, end: d.end };
        }
        if (d.kind === 'jump') return { err: 'direct jump/branch in body (video-path safety not proven)' };
    }
    return { err: 'forwarder does not end in ret' };
}

/* Enumerate POSSIBLE direct incoming edges, including tail jumps. These are
 * rejection candidates only: an E8 inside an immediate cannot authorize an
 * edit. Every accepted call is subsequently decoded from its caller entry.
 * Extra ambiguous edges (even embedded data) intentionally cause refusal. */
function navmdEdges(im, targets) {
    var out = [], b = im.buf;
    for (var p = im.exec.off; p < im.exec.end; p++) {
        var op = b[p], n = 0, disp = 0, call = false;
        if (op === 0xe8 || op === 0xe9) { n = 5; disp = 1; call = op === 0xe8; }
        else if (op === 0xeb || (op >= 0x70 && op <= 0x7f)) { n = 2; disp = 1; }
        else if (op === 0x0f && b[p + 1] >= 0x80 && b[p + 1] <= 0x8f) { n = 6; disp = 2; }
        if (!n || p + n > im.exec.end) continue;
        var next = im.va(p + n);
        var to = next === null ? null : im.off(next + (n === 2 ? b.readInt8(p + disp) : b.readInt32LE(p + disp)));
        if (targets.indexOf(to) >= 0) out.push({ at: p, to: to, call: call });
    }
    return out;
}

/* A strict void self-name is necessary, but not sufficient: a mismatched
 * caller can consume RAX even for void ABI. The accepted caller suffix is
 * NOP* [XOR EAX,EAX; XOR EDX,EDX] NOP* RET, nothing else. For the bare-RET
 * suffix, also require a leaf forwarder made ONLY of NOPs and RIP-relative
 * LEAs to non-return caller-saved registers: stock and patched leave RAX/RDX
 * (and FP return registers/flags) identical. Thus CALL;RET synthetic dispatchers
 * remain supported without assuming that their absent signature means void.
 * The explicit zeroing suffix instead discards both integer return registers;
 * only leaf bodies writing caller-saved GPRs are then allowed, so FP return
 * registers are unchanged as well (an external CALL could change them).
 * All other shapes are refused.
 */
function navmdReturnSafe(im, body, caller, at) {
    /* Never skip a write to stack/callee-saved state, even for a void name. */
    if (body.ins.some(function (d) { return d.dest !== null && [0, 1, 2, 6, 7, 8, 9, 10, 11].indexOf(d.dest) < 0; }))
        return false;
    var suffix = caller.ins.filter(function (d) { return d.at > at; });
    var useful = suffix.filter(function (d) { return d.kind !== 'nop'; });
    if (useful.length === 3 && useful[0].kind === 'xor' && useful[1].kind === 'xor' && useful[2].kind === 'ret' &&
        im.buf[useful[0].at] === 0x31 && im.buf[useful[0].at + 1] === 0xc0 &&
        im.buf[useful[1].at] === 0x31 && im.buf[useful[1].at + 1] === 0xd2)
        return !body.ins.some(function (d) { return d.kind === 'call'; });
    if (useful.length !== 1 || useful[0].kind !== 'ret') return false;
    return body.ins.every(function (d) {
        if (d.kind === 'ret' || d.kind === 'nop') return true;
        if (d.kind !== 'lea') return false;
        return d.dest !== 0 && d.dest !== 2; /* no return-register write */
    });
}

/* The optional call retarget requires a decoded self-name load and RET,
 * decoded incoming CALL boundary, no incoming tail jumps and no video-trio
 * caller/callee. Unsupported encodings or return use refuse only Edit 5. */
function locateNavmd(im, anchor, trio) {
    if (!im.starts.length) return { ok: false, reason: 'navmd: no function table' };
    if (!anchor) return { ok: false, reason: 'navmd: no anchor given' };
    if (trio.err) return { ok: false, reason: 'navmd: ' + trio.err };
    var sep = anchor.indexOf('/'), re = null, key = sep < 0 ? anchor : anchor.slice(0, sep);
    /* An empty Buffer search never advances beyond EOF; refuse before namedString. */
    if (!key.trim()) return { ok: false, reason: 'navmd: anchor substring must not be empty or whitespace-only' };
    if (sep >= 0) {
        try { re = new RegExp(anchor.slice(sep + 1)); }
        catch (e) { return { ok: false, reason: 'navmd: bad anchor regex: ' + e.message }; }
    }
    var str = namedString(im.buf, key, re || /./, 'navmd: ' + key);
    if (str.err) return { ok: false, reason: str.err };
    var refs = leaRefs(im, [str.off]), sites = refs[str.off] || [];
    if (!sites.length) return { ok: false, reason: 'navmd: anchor string not referenced' };
    var f = im.func(sites[0]);
    for (var i = 1; f && i < sites.length; i++) {
        var g = im.func(sites[i]);
        if (!g || g.off !== f.off) return { ok: false, reason: 'navmd: anchor used by several functions' };
    }
    if (!f) return { ok: false, reason: 'navmd: forwarder outside the function table' };
    if (!/^void (?:[A-Za-z_]\w*::)+[A-Za-z_]\w*\([^()]*\)$/.test(stringAt(im.buf, str.off)))
        return { ok: false, reason: 'navmd: forwarder self-name is not an unambiguous void signature' };
    if (trio.list.indexOf(f.off) >= 0) return { ok: false, reason: 'navmd: forwarder is on the video path' };
    var body = navmdBody(im, f);
    if (body.err) return { ok: false, reason: 'navmd: forwarder ' + body.err };
    if (!sites.some(function (p) {
        return p - f.off < ENTRY && body.ins.some(function (d) { return d.at === p && d.kind === 'lea'; });
    })) return { ok: false, reason: 'navmd: self-name load is not a decoded entry instruction' };
    for (var j = 0; j < body.ins.length; j++)
        if (body.ins[j].kind === 'call' && trio.list.indexOf(body.ins[j].to) >= 0)
            return { ok: false, reason: 'navmd: forwarder calls the video path' };
    var e = body.ret, retVa = im.va(e), edges = navmdEdges(im, [f.off, e]);
    if (edges.some(function (c) { return !c.call; }))
        return { ok: false, reason: 'navmd: incoming direct tail jump/branch to forwarder or ret' };
    if (edges.length !== 1)
        return { ok: false, reason: 'navmd: forwarder called ' + edges.length + ' times (want 1)' };
    var at = edges[0], caller = im.func(at.at);
    if (!caller) return { ok: false, reason: 'navmd: caller outside the function table' };
    if (trio.list.indexOf(caller.off) >= 0) return { ok: false, reason: 'navmd: caller is on the video path' };
    var cb = navmdBody(im, caller);
    if (cb.err) return { ok: false, reason: 'navmd: caller ' + cb.err };
    if (!cb.ins.some(function (d) { return d.at === at.at && d.kind === 'call' && d.to === at.to; }))
        return { ok: false, reason: 'navmd: candidate call is not a decoded instruction boundary' };
    if (!navmdReturnSafe(im, body, cb, at.at))
        return { ok: false, reason: 'navmd: caller return-value safety not proven' };
    var next = im.va(at.at + 5);
    if (next === null || retVa === null) return { ok: false, reason: 'navmd: call site/ret at the end of the image' };
    /* Protect both the edit and its evidence, including the RET byte that
     * the loader must not rewrite. The legacy four-edit checks stay intact. */
    var proof = relocated(im, [['navmd', f.off, body.end - f.off],
        ['navmd', caller.off, cb.end - caller.off], ['navmd', str.off, stringAt(im.buf, str.off).length + 1]]);
    if (proof.all || proof.edits.length)
        return { ok: false, reason: 'navmd: ' + (proof.all || 'a dynamic relocation over the edit or decoded safety evidence') };
    return { ok: true, offset: at.at, caller: caller.off, forwarder: f.off, ret: e,
             original: 'e8' + hex32(im.va(f.off) - next), patched: 'e8' + hex32(retVa - next) };
}

/* All four sites: { elf: true|false, reason (not an ELF / why), buildId,
 * version, variant, sink, selfstart, res }, each edit { ok, reason } plus its
 * offsets and stock/patched values. ok is true when every edit was found.
 * With `navmdAnchor` (Edit 5), the result also carries `navmd`: an optional
 * edit that never takes part in ok — a build without the anchor string, or
 * without an anchor at all, simply has no navmd edit to offer. */
function locate(buf, navmdAnchor) {
    var elf = parseElf(buf);
    var none = { ok: false, reason: 'not located' };
    if (!elf.load) return { ok: false, elf: false, reason: elf.reason, buildId: null, version: null, variant: none, sink: none, selfstart: none, res: none };
    var im = new Image(buf, elf), str = {}, offs = [], sink = locateSink(buf);
    Object.keys(NAMES).forEach(function (k) {
        str[k] = namedString(buf, NAMES[k][0], NAMES[k][1], NAMES[k][2]);
        if (!str[k].err) offs.push(str[k].off);
    });
    if (sink.ok) for (var i = 0; i < sink.len; i++) offs.push(sink.offset + i);
    var refs = leaRefs(im, offs);
    var selfstart = locateSelfstart(im, str, refs);
    var out = { elf: true, buildId: buildId(buf, elf.notes), version: version(buf), variant: locateVariant(im, str, refs), sink: sinkRefs(sink, refs),
                selfstart: selfstart, res: locateRes(im, str, refs) };
    var regions = [];
    if (out.variant.ok) regions.push(['variant', out.variant.slot, 4]);
    if (out.sink.ok) regions.push(['sink', out.sink.offset, out.sink.len]);
    if (out.selfstart.ok) regions.push(['selfstart', out.selfstart.offset, 5]);
    if (out.res.ok) [out.res.mm, out.res.px, out.res.safe1, out.res.safe2].forEach(function (o) { regions.push(['res', o, 8]); });
    var hit = relocated(im, regions), label = { variant: 'variant', sink: 'sink', selfstart: 'self-start', res: 'resolution' };
    Object.keys(label).forEach(function (e) {
        if (out[e].ok && (hit.all || hit.edits.indexOf(e) >= 0))
            out[e] = { ok: false, reason: label[e] + ': ' + (hit.all || 'a dynamic relocation over the edit') };
    });
    if (navmdAnchor !== undefined && navmdAnchor !== '') {
        out.navmd = locateNavmd(im, navmdAnchor,
            selfstart.ok ? { list: [selfstart.setStreamStatus, selfstart.requestStream, selfstart.onSuggestUi] }
                         : { err: 'the video-path check needs the self-start sites' });
        if (out.navmd.ok) {
            var nhit = relocated(im, [['navmd', out.navmd.offset, 5]]);
            if (nhit.all || nhit.edits.indexOf('navmd') >= 0)
                out.navmd = { ok: false, reason: 'navmd: ' + (nhit.all || 'a dynamic relocation over the edit') };
        }
    }
    var failed = [out.variant, out.sink, out.selfstart, out.res].filter(function (e) { return !e.ok; });
    out.ok = failed.length === 0;
    if (failed.length) out.reason = failed.map(function (e) { return e.reason; }).join('; ');
    return out;
}

module.exports = { locate: locate, buildId: elfBuildId, SINK_STOCK: SINK_STOCK };
