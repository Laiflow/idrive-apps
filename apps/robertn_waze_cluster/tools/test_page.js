// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
'use strict';
/**
 * Runs the app's source modules (mgu-app.json, the entry first) against
 * a fake SDK and HMI built from the shipped uiDescription.json, with its two
 * sockets pointed at tools/fakes.js.
 *
 *   node tools/build.js && node tools/test_page.js
 *
 * Covers: the page's buttons (Enable map, Disable map, Capture logs) match
 * application.xml and are the ones the app binds, with no Show or Stop; a page
 * opened while the map is up shows it; Disable map shown only while patched
 * and Enable map only while not; pressing every button sends the render
 * nothing; hiding the page closes both sockets; a page opened again reads
 * the render's current state; a pending patch shows its line with no Enable
 * or Disable, from the daemon and, before the daemon runs, from its marker;
 * the line naming the cluster setting the map needs is always on the page,
 * under the status.
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { FakeRender, FakePatch, RENDER_PAGE, RENDER_FPS } = require('./fakes.js');
const { RENDER_PATH, PATCH_PATH, PENDING_PATH, SIZE, SAFE } = require('../src/waze_cluster_control.js');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-app.json'), 'utf8'));
const PKG = path.join(__dirname, '..', MANIFEST.tree);
const UI_DIR = path.join(PKG, 'rhmiData', 'uiDescriptions', 'ID7');
const UI = JSON.parse(fs.readFileSync(path.join(UI_DIR, 'uiDescription.json'), 'utf8'));
const XML = fs.readFileSync(path.join(UI_DIR, 'application.xml'), 'utf8');
const APP_JSON = JSON.parse(fs.readFileSync(path.join(PKG, 'rhmiData', 'application.json'), 'utf8'));

/* short: macOS limits a socket path to 104 bytes */
const RSOCK = `/tmp/woc-pr-${process.pid}.sock`;
const PSOCK = `/tmp/woc-pp-${process.pid}.sock`;
const PENDING = `/tmp/woc-ppend-${process.pid}.json`;
const SOCKETS = { [RENDER_PATH]: RSOCK, [PATCH_PATH]: PSOCK };
const realConnect = net.connect;
const exit = process.exit.bind(process);
net.connect = (p, ...rest) => realConnect.call(net, SOCKETS[p] || p, ...rest);
const realRead = fs.readFileSync;
fs.readFileSync = (p, ...rest) => realRead.call(fs, p === PENDING_PATH ? PENDING : p, ...rest);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function until(what, check) {
    const deadline = Date.now() + 2000;
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (check()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out waiting for ${what}`));
            else setTimeout(poll, 10);
        };
        poll();
    });
}

/* ---- fake HMI, from the shipped uiDescription ----------------------------- */

class FakeComponent extends EventEmitter {
    constructor(id, desc) {
        super();
        this.id = Number(id);
        this.desc = desc;
        this.text = null;
        this.enabled = null;
        this.visible = (desc && desc.properties && desc.properties.Visible) ? desc.properties.Visible.value === 1 : null;
    }
    getId() { return this.id; }
    setValue(row, cell, value) { this.text = value; return Promise.resolve(); }
    setEnabled(enabled) { this.enabled = enabled; return Promise.resolve(); }
    setVisible(visible) { this.visible = visible; return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}

const byName = {};
Object.entries(UI.containers).forEach(([cid, cont]) => {
    byName[cont.name] = new FakeComponent(cid, cont);
    Object.entries(cont.components).forEach(([id, desc]) => {
        byName[desc.name] = new FakeComponent(id, desc);
    });
});
const rhmi = new EventEmitter();
rhmi.getByName = (name) => byName[name] || null;
rhmi.mapEntryState = () => Promise.resolve();
rhmi.openEntryState = () => Promise.resolve();

/* ---- fake SDK ----------------------------------------------------------------- */

const logs = [];
const logger = {};
['error', 'warn', 'info', 'verbose', 'debug'].forEach((level) => {
    logger[level] = (msg) => logs.push(`${level}: ${msg}`);
});

class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this._packageJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
        this.appDescription = APP_JSON;
        this.rhmiApplication = rhmi;
        this.startReason = 'ENTRY_POINT';
        this._initialized = false;
        this._appStatusService = null;
        const description = APP_JSON.application.entryPoints[0];
        this._entryPoints = [{
            entryPoint: { setText: () => Promise.resolve(), setIcon: () => Promise.resolve() },
            getDescription: () => description,
            init: () => Promise.resolve(),
            setAvailability: () => Promise.resolve()
        }];
    }
    start() { setImmediate(() => this.emit('initialized')); return Promise.resolve(); }
    getAppId() { return 'robertn_waze_cluster'; }
    getEntryPoints() { return this._entryPoints; }
    getLastExecutedEntryPointUuid() { return null; }
    initialized() { this._initialized = true; this._appStatusService = {}; return Promise.resolve(); }
    registerActive() { return Promise.resolve(); }
    registerInactive() { return Promise.resolve(); }
    registerHmiVisible() { return Promise.resolve(); }
    unregisterHmiVisible() { return Promise.resolve(); }
    destroyBundles() { return Promise.resolve(); }
}

const FAKE_MODULES = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => logger }
};

/* Loads the app's entry module (mgu-app.json's first) with the SDK's names
 * answered by the fakes, as the unit's link of the source package would. */
function runSource() {
    const Module = require('module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        return FAKE_MODULES[request] || load.call(this, request, parent, isMain);
    };
    require(path.join(__dirname, '..', MANIFEST.modules[0]));
}

/* ---- scenario ----------------------------------------------------------------- */

async function main() {
    const components = UI.containers['1'].components;
    const buttons = Object.entries(components).filter(([, d]) => d.type === 'button');
    const xmlButtons = [];
    const buttonPattern = /<component id="(\d+)" type="button"/g;
    let buttonMatch;
    while ((buttonMatch = buttonPattern.exec(XML))) xmlButtons.push(buttonMatch[1]);
    xmlButtons.sort();
    assert.deepStrictEqual(buttons.map(([id]) => id).sort(), xmlButtons, 'application.xml and uiDescription agree');
    assert.deepStrictEqual(buttons.map(([, d]) => d.name).sort(), ['wocCapture', 'wocDisable', 'wocEnable', 'wocNavmd', 'wocRestart']);
    assert(!buttons.some(([, d]) => /^(Show|Stop)$/.test(d.rows[0].Text.value)), 'no Show or Stop button');
    Object.entries(components).forEach(([id, desc]) => {
        assert(new RegExp('<component id="' + id + '" type="' + desc.type + '"').test(XML), 'XML component/type ' + id);
    });
    assert.strictEqual(components['36'].type, 'label');
    assert.strictEqual(components['36'].properties.Focusable.value, 0);
    /* The restart button ships hidden; it shows only while a patch is deferred. */
    assert.strictEqual(components['34'].properties.Visible.value, 0, 'wocRestart ships hidden');
    console.log('ok   page buttons: Enable map, Disable map, Restart (hidden), Capture logs; no Show or Stop');
    const setup = Object.entries(components).find(([, d]) => d.name === 'wocSetup');
    assert(setup && setup[0] === '21' && setup[1].type === 'label' && setup[1].properties.Visible.value === 1 &&
        setup[1].properties.Focusable.value === 0, 'wocSetup: a visible, unfocusable label right under wocStatus');
    assert(/<component id="20" type="label"[^]*?<\/component>\s*<component id="21" type="label" widget="LT_Label_1Row">\s*<property id="2" value="1"\/>/.test(XML),
        'application.xml: label 21, visible, right after the status');

    const render = new FakeRender(RSOCK);
    let patch = new FakePatch(PSOCK);
    await render.listen();
    await patch.listen();
    patch.res = SIZE;
    patch.safe = SAFE;
    patch.navmd = {state:'on'};
    patch.pending = 'apply';
    patch.announce('unknown', 'high', null, 'deferred');
    render.stream(true);
    await until('fake showing', () => render.state === 'showing');

    try {
        process.exit = (code) => { throw new Error(`process.exit(${code})`); };
        runSource();
        const status = byName.wocStatus;
        await until('fresh pending on', () => byName.wocNavmd.text === 'Suppress native guidance: On — reboot needed' &&
            byName.wocNavmdStatus.text === 'Guidance on disk: On — reboot needed' && !byName.wocNavmd.enabled);
        patch.navmd = {state:'off'}; patch._broadcast(patch._status());
        await until('fresh pending off', () => byName.wocNavmd.text === 'Suppress native guidance: Off — reboot needed');
        patch.navmd = null; patch.pending = null; patch.announce('patched', 'high', null);
        await until('page shows the map', () => status.text === `Showing: ${RENDER_PAGE} — ${RENDER_FPS}`);
        assert.strictEqual(byName.wocApplyWarning.text, 'Apply while parked; CarPlay may restart');
        assert(!logs.some((l) => /^error/.test(l)), logs.filter((l) => /^error/.test(l)).join('\n'));
        const bound = logs.filter((l) => l.startsWith('info: BIND OK: ')).map((l) => l.split(' ')[3]).sort();
        assert.deepStrictEqual(bound, ['wocCapture', 'wocDisable', 'wocEnable', 'wocNavmd', 'wocRestart'], 'bound buttons');
        assert.strictEqual(byName.wocRestart.visible, false, 'restart button hidden while the map shows');
        console.log('ok   a page opened while the map is up shows it');
        await until('the setup line', () => byName.wocSetup.text === 'Set Instrument cluster > Central display area to Map view');
        console.log('ok   the page says to set Instrument cluster > Central display area to Map view');

        await until('patched: Disable map only', () => byName.wocDisable.visible === true && byName.wocDisable.enabled === true &&
            byName.wocEnable.visible === false && byName.wocEnable.enabled === false);
        byName.wocDisable.emit('action');
        await until('reverted', () => patch.count('revert') === 1 && !patch.busy && patch.state === 'original');
        await until('original: Enable map only', () => byName.wocEnable.visible === true && byName.wocEnable.enabled === true &&
            byName.wocDisable.visible === false);
        ['wocEnable', 'wocCapture'].forEach((name) => byName[name].emit('action'));
        await until('apply and capture sent', () => patch.count('apply') === 1 && patch.count('capture-start') === 1 && !patch.busy);
        assert.deepStrictEqual(render.received, [], 'no command to the render');
        console.log('ok   Disable map while patched, Enable map while not; presses go to the patch daemon, none to the render');

        assert.strictEqual(byName.wocNavmd.enabled, false);
        assert(byName.wocNavmdStatus.text.includes('daemon does not report'));
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply')[0],
            {cmd:'apply',panel:'high',mode:'avb'});
        patch.navmd = {state:'off'};
        patch.announce('patched', 'high', null);
        await until('navmd off', () => byName.wocNavmd.text === 'Suppress native guidance: Off' && byName.wocNavmd.enabled);
        const applyCount = patch.count('apply');
        byName.wocNavmd.emit('action');
        await until('dirty setting', () => byName.wocNavmd.text.includes('On — not applied') &&
            byName.wocEnable.visible && byName.wocEnable.text === 'Apply settings');
        assert.strictEqual(byName.wocNavmdStatus.text, 'Guidance on disk: Off');
        assert.strictEqual(patch.count('apply'), applyCount, 'selection alone sends no command');
        await sleep(450); byName.wocNavmd.emit('action');
        await until('toggled back, no apply', () => byName.wocNavmd.text === 'Suppress native guidance: Off' && !byName.wocEnable.visible);
        await sleep(450); byName.wocNavmd.emit('action');
        await until('staged again', () => byName.wocNavmd.text.includes('On — not applied') && byName.wocEnable.visible);
        patch._broadcast(patch._status());
        await sleep(50);
        assert(byName.wocNavmd.text.includes('On — not applied'), 'refresh keeps dirty selection');
        await sleep(450); // enable action deduplication from the earlier legacy apply
        byName.wocEnable.emit('action');
        await until('busy preserves staged choice', () => status.text === 'Applying patch…' &&
            byName.wocNavmd.text.includes('On — not applied') && !byName.wocNavmd.enabled);
        await until('navmd on applied', () => patch.count('apply') === applyCount + 1 &&
            byName.wocNavmd.text === 'Suppress native guidance: On');
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply').slice(-1)[0],
            {cmd:'apply',panel:'high',mode:'avb',navmd:true});
        await sleep(450);
        byName.wocNavmd.emit('action');
        await until('dirty off', () => byName.wocNavmd.text.includes('Off — not applied') && byName.wocEnable.visible);
        await sleep(450);
        byName.wocEnable.emit('action');
        await until('navmd off applied', () => patch.count('apply') === applyCount + 2 &&
            byName.wocNavmd.text === 'Suppress native guidance: Off');
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply').slice(-1)[0],
            {cmd:'apply',panel:'high',mode:'avb',navmd:false});
        await sleep(450);
        byName.wocNavmd.emit('action');
        await until('staged for failing apply', () => byName.wocNavmd.text.includes('On — not applied'));
        patch.failApply = true;
        await sleep(450);
        byName.wocEnable.emit('action');
        await until('failed apply remains staged', () => status.text === 'Patch error: write failed' &&
            byName.wocNavmd.text.includes('On — not applied'));
        assert.deepStrictEqual(patch.received.filter((m) => m.cmd === 'apply').slice(-1)[0],
            {cmd:'apply',panel:'high',mode:'avb',navmd:true});
        patch.failApply = false;
        patch.announce('patched', 'high', null);
        await until('failure refresh preserves selection', () => byName.wocNavmd.text.includes('On — not applied'));
        patch.navmd = {state:'unavailable',reason:'No root-provisioned verified anchor'};
        patch._broadcast(patch._status());
        await until('unsupported reason', () => !byName.wocNavmd.enabled && byName.wocNavmdStatus.text.includes('verified anchor'));
        await sleep(450);
        byName.wocNavmd.emit('action');
        assert.strictEqual(patch.count('apply'), applyCount + 3);
        patch.navmd = {state:'unknown',reason:'verification failed'};
        patch._broadcast(patch._status());
        await until('unknown reason', () => !byName.wocNavmd.enabled && byName.wocNavmdStatus.text.includes('verification failed'));
        patch.navmd = null;
        patch._broadcast(patch._status());
        await until('old daemon', () => !byName.wocNavmd.enabled && byName.wocNavmdStatus.text.includes('daemon does not report'));
        patch.navmd = {state:'off'};
        patch._broadcast(patch._status());
        await until('option reavailable', () => byName.wocNavmd.enabled);
        await until('dirty before reconnect', () => byName.wocNavmd.text.includes('On — not applied'));
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('closed for dirty reconnect', () => patch._clients.size === 0);
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('dirty after reconnect', () => byName.wocNavmd.enabled && byName.wocNavmd.text.includes('On — not applied'));
        patch.deferApply = true;
        await sleep(450);
        byName.wocEnable.emit('action');
        await until('deferred option', () => status.text === 'Patch pending — reboot to activate' &&
            byName.wocNavmd.text.includes('not applied') && byName.wocNavmd.text.includes('reboot needed') &&
            byName.wocNavmdStatus.text.includes('on disk: On — reboot needed') && !byName.wocNavmd.enabled &&
            !byName.wocEnable.visible && byName.wocRestart.visible);
        patch.deferApply = false;
        patch.pending = null; patch.carplay = null; patch.state = 'patched';
        patch._broadcast(patch._status());
        await until('post reboot confirmed', () => byName.wocNavmd.text === 'Suppress native guidance: On' &&
            !byName.wocEnable.visible);
        patch.navmd = null;
        patch._broadcast(patch._status());
        console.log('ok   pre-option, on/off apply, unavailable/unknown and old daemon');

        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('sockets closed', () => render._clients.size === 0 && patch._clients.size === 0);
        console.log('ok   hiding the page closes both sockets');

        render.stream(false);
        patch.announce('patched', 'high', null);
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('page reads the current state', () => status.text === 'Patched — waiting for CarPlay');
        console.log('ok   a page opened again reads the render\'s current state');

        /* The patch the install wrote, from the daemon: its line, no Enable
         * or Disable, the restart offered. */
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('pending on screen', () => status.text === 'Patch pending — reboot to activate' &&
            byName.wocEnable.visible === false && byName.wocDisable.visible === false &&
            byName.wocRestart.visible === true && byName.wocRestart.enabled === true);
        console.log('ok   a pending patch from the daemon: its line, no Enable or Disable, the restart offered');

        /* Before the head-unit start that starts the daemon: from the marker. */
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: false });
        await until('closed', () => patch._clients.size === 0);
        await patch.close();
        fs.writeFileSync(PENDING, JSON.stringify({ action: 'apply' }) + '\n');
        byName.ST_OnlineApps_WazeCluster.emit('visible', { visible: true });
        await until('pending from the marker', () => status.text === 'Patch pending — reboot to activate' &&
            byName.wocEnable.visible === false && byName.wocDisable.visible === false && byName.wocRestart.visible === false);
        console.log('ok   installed, the daemon not yet running: the marker\'s pending patch, no buttons');

        /* The daemon up with the pending patch: the restart press reboots once. */
        patch = new FakePatch(PSOCK);
        await patch.listen();
        patch.pending = 'apply';
        patch.announce('unknown', 'high', 'patch written; takes effect at the next head-unit start', 'deferred');
        await until('restart offered', () => byName.wocRestart.visible === true && byName.wocRestart.enabled === true);
        byName.wocRestart.emit('action');
        await until('rebooted once', () => patch.reboots === 1);
        await until('restarting on screen', () => status.text === 'Restarting head unit…' && byName.wocRestart.enabled === false);
        console.log('ok   pressing the restart button reboots the unit once');
    } finally {
        await render.close();
        await patch.close();
        [RSOCK, PSOCK, PENDING].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* gone */ } });
    }
}

/* The app's sockets keep retrying, so the run ends here. */
main().then(() => {
    console.log('all passed');
    exit(0);
}, (err) => {
    console.log(`FAIL ${err && err.stack}`);
    exit(1);
});
