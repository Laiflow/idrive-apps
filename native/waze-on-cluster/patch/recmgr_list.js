// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/* Whether recmgr loaded a service's restart entry this boot, shared by patchd
 * and the boot-recovery watcher. recmgr reboots the head unit when a service
 * its restart list does not name stops, and it reads the list
 * (/etc/recmgr-restartlist.conf) only at boot. A service counts as listed when
 * its name is in both [Whitelist] and [WhitelistExitSuccess] of the list as it
 * stood at boot: the file itself while it is older than the boot, else the
 * copy mgu-deploy saved before this boot's first write (recmgr-at-boot.json).
 * This is the rule mgu-deploy uses.
 *
 * Node 8 on the unit. No dependencies.
 */
var fs = require('fs');

var RECMGR_CONF = process.env.WOC_RECMGR_CONF || '/etc/recmgr-restartlist.conf';
var RECMGR_AT_BOOT = process.env.WOC_RECMGR_AT_BOOT || '/var/opt/mgu-deploy/recmgr-at-boot.json';
var PROC_STAT = process.env.WOC_PROC_STAT || '/proc/stat';
var BOOT_ID = process.env.WOC_BOOT_ID || '/proc/sys/kernel/random/boot_id';

function recmgrHas(text, name) {
    var has = { Whitelist: false, WhitelistExitSuccess: false }, section = '';
    text.split('\n').forEach(function (line) {
        line = line.trim();
        if (/^\[.*\]$/.test(line)) { section = line.slice(1, -1); return; }
        if (has.hasOwnProperty(section) && line === name) has[section] = true;
    });
    return has.Whitelist && has.WhitelistExitSuccess;
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } }

/* recmgr loaded name's entry this boot. */
function recmgrLoaded(name) {
    var cur = readText(RECMGR_CONF);
    if (cur === null || !recmgrHas(cur, name)) return false;
    var at = null;
    try { at = JSON.parse(readText(RECMGR_AT_BOOT)); } catch (e) {}
    var boot = (readText(BOOT_ID) || '').trim();
    if (at && at.boot && at.boot === boot) return recmgrHas(at.text || '', name);
    var btime = /^btime (\d+)$/m.exec(readText(PROC_STAT) || '');
    if (!btime) return false;
    try { return fs.statSync(RECMGR_CONF).mtime.getTime() < parseInt(btime[1], 10) * 1000; } catch (e) { return false; }
}

module.exports = { recmgrHas: recmgrHas, recmgrLoaded: recmgrLoaded };
