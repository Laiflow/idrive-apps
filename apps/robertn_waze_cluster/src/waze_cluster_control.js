// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * waze_cluster_control - the app's client of the two native waze-on-cluster
 * sockets. No OAP runtime: the app opens both while its page is visible,
 * closes them when the page is hidden, and renders statusText(),
 * rows() and the connected() flags.
 *
 * LineSocket holds the connection: a Unix stream socket, newline-delimited
 * JSON, one object per line, with retry while open. One drives the render
 * control socket, one the root patch daemon.
 *
 *   Render control socket (RENDER_PATH; read only, the app sends nothing)
 *     tool -> app   {"ev":"status","state":"idle"|"starting"|"showing"|"frozen"|"error",
 *                    "target","page","reason"}   (idle's reason: why a live stream shows no map)
 *                   {"ev":"log","line"}      the backlog on connect, then each new line
 *                   {"ev":"slots",...}       ignored here
 *
 *   Patch daemon socket (PATCH_PATH; root helper, group tm_oap_app)
 *     app    -> daemon  {"cmd":"status"}
 *                       {"cmd":"apply","panel":"high","mode":"avb","navmd":true|false} (optional navmd)
 *                       {"cmd":"revert"}
 *                       {"cmd":"reboot"}  activate a deferred patch with a
 *                        normal reboot (only when carplay is "deferred")
 *     daemon -> app     {"ev":"status","state":"original"|"patched"|"unknown"|
 *                        "busy"|"error","panel":"high"|"mid"|null,"mode","res","safe",
 *                        "carplay","reason","pending","conflict","navmd"}
 *                       res "WxH" and safe "WxH+X+Y": the advertised size and
 *                       its safe area (a daemon before the safe area omits safe)
 *                       carplay "deferred": the patch is written but takes effect
 *                       only at the next head-unit start (a restart is needed)
 *                       pending "apply" | "revert": which change waits for it
 *                       conflict: why the install left carplay as it was
 *                       {"ev":"reboot-reply","ok":true|false,"reason"}
 *                       {"ev":"log","line"}  the backlog on connect, then each new line
 *
 *   Pending marker (PENDING_PATH; world-readable JSON {"action":"apply"|"revert"})
 *     written with the change, so a patch the install wrote is shown before the
 *     next head-unit start starts the daemon.
 *
 * The render runs from boot and maps the map into the native central-map slot
 * whenever the CarPlay stream flows, and takes it down when the stream stops,
 * whether or not this app is open; its status says which. Enable map applies
 * the one patch configuration (high panel, the resolution SIZE the render
 * displays with its guidance safe area SAFE, the stock media-bus sink), and
 * Disable map reverts it, which is what turns the map off. Installing the tool
 * writes the same patch, which takes effect at the next head-unit start. The
 * patch daemon is a new root service that may not be running until then, so
 * an unreachable patch socket is reported, not an error, and retried like the
 * render socket.
 */
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');

const RENDER_PATH = '/dev/shm/waze-on-cluster/ctl.sock';
const PATCH_PATH = '/dev/shm/waze-on-cluster/patch.sock';
const PENDING_PATH = '/dev/shm/waze-on-cluster/activation-pending';
const RETRY_MS = 1000;
const MAX_LINES = 30;
const OPERATION_TIMEOUT_MS = 120000;

/* The native central-map slot's size, which the patch advertises to the phone. */
const SIZE = '1088x480';
/* The safe area Enable map writes: where the phone keeps its guidance UI,
 * inside the part of the map the gauges leave visible. */
const SAFE = '504x368+286+72';

/* One newline-delimited-JSON stream socket, reconnecting while open.
 * link: 'down' | 'up' | 'absent' (ENOENT) | 'refused' (ECONNREFUSED) | 'failed'.
 * Emits 'connect' and 'close'; each parsed object goes to onMessage(msg). */
class LineSocket extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.path = o.path;
        this.retryMs = o.retryMs || RETRY_MS;
        this._log = o.log || { info() {}, warn() {} };
        this._onMessage = o.onMessage || function () {};
        this.link = 'down';
        this.linkCode = null;
        this._open = false;
        this._socket = null;
        this._buf = '';
        this._retryTimer = null;
    }

    open() {
        if (!this._open) {
            this._open = true;
            this._connect();
        }
    }

    close() {
        this._open = false;
        clearTimeout(this._retryTimer);
        this._retryTimer = null;
        if (this._socket) {
            /* forgotten here, so its late events cannot touch a new connection */
            this._socket.end();
            this._socket = null;
        }
        this.link = 'down';
    }

    connected() {
        return this.link === 'up';
    }

    send(obj) {
        if (this._socket && this.link === 'up') {
            this._socket.write(JSON.stringify(obj) + '\n');
        }
    }

    _connect() {
        if (!this._open || this._socket) {
            return;
        }
        const socket = net.connect(this.path);
        this._socket = socket;
        this._buf = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => {
            if (this._socket === socket) {
                this._log.info(`connected to ${this.path}`);
                this.link = 'up';
                this.linkCode = null;
                this.emit('connect');
            }
        });
        socket.on('data', (chunk) => {
            if (this._socket === socket) {
                this._onData(chunk);
            }
        });
        socket.on('error', (err) => {
            if (this._socket !== socket) {
                return;
            }
            const code = (err && err.code) || 'ERROR';
            this.link = code === 'ENOENT' ? 'absent' : code === 'ECONNREFUSED' ? 'refused' : 'failed';
            this.linkCode = code;
            this._log.warn(`${this.path}: ${code}`);
        });
        socket.on('close', () => {
            if (this._socket !== socket) {
                return;
            }
            this._socket = null;
            if (this.link === 'up') {
                this._log.info(`${this.path}: connection closed`);
                this.link = 'refused';
            }
            this.emit('close');
            this._retryTimer = setTimeout(() => {
                this._retryTimer = null;
                this._connect();
            }, this.retryMs);
        });
    }

    _onData(chunk) {
        this._buf += chunk;
        let nl;
        while ((nl = this._buf.indexOf('\n')) >= 0) {
            const line = this._buf.slice(0, nl).trim();
            this._buf = this._buf.slice(nl + 1);
            if (!line) {
                continue;
            }
            let msg = null;
            try {
                msg = JSON.parse(line);
            } catch (e) {
                this._log.warn(`bad line from ${this.path}: ${line.slice(0, 80)}`);
            }
            if (msg) {
                this._onMessage(msg, line);
            }
        }
    }
}

class WazeClusterControl extends EventEmitter {
    /* options: renderPath, patchPath, pendingPath, retryMs, operationTimeoutMs,
     * log ({info, warn}). The timeout defaults to 120 s. Emits
     * 'change' whenever statusText() or the connected() flags may
     * have changed, and 'log' when the merged log lines changed. */
    constructor(options) {
        super();
        const o = options || {};
        this._log = o.log || { info() {}, warn() {} };
        this._pendingPath = o.pendingPath || PENDING_PATH;
        this._lastPatchCmd = 'apply';
        this._restartRequested = false;   /* a reboot was asked for; waiting for the unit to restart */
        this._navmdChoice = false;       /* pre-option defaults off */
        this._navmdDirty = false;
        this._operation = null;          /* sent operation awaiting authoritative status */
        this._operationTimeoutMs = o.operationTimeoutMs || OPERATION_TIMEOUT_MS;
        this._operationTimer = null;
        this._needsFreshStatus = false;
        this._outcomeUncertain = false;
        this.captureState = { state: 'unavailable' };
        this.renderStatus = null;   /* the render tool's last status while connected */
        this.patchStatus = null;    /* the patch daemon's last status while connected */
        this._lines = [];           /* merged log: [{src, text}], newest first */

        this.render = new LineSocket({
            path: o.renderPath || RENDER_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onRender(msg)
        });
        this.patch = new LineSocket({
            path: o.patchPath || PATCH_PATH,
            retryMs: o.retryMs,
            log: this._log,
            onMessage: (msg) => this._onPatch(msg)
        });

        /* On (re)connect each tool resends its backlog, so that source's lines
         * are dropped first to keep the merged log free of duplicates. */
        this.render.on('connect', () => this._onLinkChange('map', () => { this.renderStatus = null; }));
        this.render.on('close', () => { this.renderStatus = null; this.emit('change'); });
        this.patch.on('connect', () => {
            this._onLinkChange('patch', () => { this.patchStatus = null; });
            if (this._operation && !this._operation.deferred) this._armOperationTimer();
            if (this._needsFreshStatus) this.patch.send({ cmd: 'status' });
        });
        this.patch.on('close', () => { this._patchDisconnected(); this.emit('change'); });
    }

    /* Open both sockets, each reconnecting while open. */
    open() {
        this.render.open();
        this.patch.open();
    }

    /* Close both; the tools keep running. */
    close() {
        this.render.close();
        this.patch.close();
        this.renderStatus = null;
        this._patchDisconnected();
        this.emit('change');
    }

    _patchDisconnected() {
        this.patchStatus = null;
        this._restartRequested = false;
        this._stopOperationTimer();
        if (this._operation) this._operation.reconnect = true;
    }

    _stopOperationTimer() {
        if (this._operationTimer) clearTimeout(this._operationTimer);
        this._operationTimer = null;
    }

    _armOperationTimer() {
        this._stopOperationTimer();
        this._operationTimer = setTimeout(() => {
            this._operationTimer = null;
            if (!this._operation || this._operation.deferred) return;
            this._operation = null;
            this._outcomeUncertain = true;
            this._needsFreshStatus = true;
            this.patchStatus = null;
            /* Drop the old socket so buffered pre-request statuses cannot be
             * mistaken for the refresh. The new connection requests status. */
            if (this.patch._open) {
                this.patch.close();
                this.patch.open();
            } else if (this.connectedPatch()) {
                this.patch.send({ cmd: 'status' });
            }
            this.emit('change');
        }, this._operationTimeoutMs);
        if (this._operationTimer.unref) this._operationTimer.unref();
    }

    _finishOperation() {
        this._stopOperationTimer();
        this._operation = null;
    }

    connectedRender() {
        return this.render.connected();
    }

    connectedPatch() {
        return this.patch.connected();
    }

    /* ---- controls ---- */
    _navmdState() {
        const nav = this.patchStatus && this.patchStatus.navmd;
        return nav && ['on', 'off', 'unavailable', 'unknown'].includes(nav.state) ? nav.state : 'unavailable';
    }

    canToggleNavmd() {
        const ps = this.patchStatus;
        return !!(this.connectedPatch() && ps && !this._restartRequested && !this._operation &&
            !this._needsFreshStatus && !this.pending() && ps.state !== 'busy' && ['on', 'off'].includes(this._navmdState()));
    }

    toggleNavmd() {
        if (!this.canToggleNavmd()) return;
        this._navmdChoice = !this._navmdChoice;
        this._navmdDirty = this._navmdChoice !== (this._navmdState() === 'on');
        this.emit('change');
    }

    navmdText() {
        const state = this._navmdState();
        if (this._navmdDirty) {
            return 'Suppress native guidance: ' + (this._navmdChoice ? 'On' : 'Off') +
                ' — not applied' + (this.pending() ? ' (reboot needed)' : '');
        }
        if (!['on', 'off'].includes(state)) {
            return 'Suppress native guidance: ' + (state === 'unknown' ? 'Unknown' : 'Unavailable');
        }
        return 'Suppress native guidance: ' + (this._navmdChoice ? 'On' : 'Off') +
            (this.pending() ? ' — reboot needed' : '');
    }

    navmdStatusText() {
        const state = this._navmdState();
        const nav = this.patchStatus && this.patchStatus.navmd;
        if (!['on', 'off'].includes(state)) {
            const fallback = !this.connectedPatch() ? 'patch service disconnected' :
                !this.patchStatus ? 'waiting for patch status' :
                !nav ? 'daemon does not report this option' :
                'no root-provisioned verified anchor or status cannot be verified';
            return 'Guidance status: ' + (state === 'unknown' ? 'Unknown' : 'Unavailable') +
                ' — ' + ((nav && typeof nav.reason === 'string' && nav.reason) || fallback);
        }
        return 'Guidance on disk: ' + (state === 'on' ? 'On' : 'Off') +
            (this.pending() ? ' — reboot needed' : '');
    }

    enableButtonText() {
        return this.patchStatus && this.patchStatus.state === 'patched' ? 'Apply settings' : 'Enable map';
    }

    enableMap() {
        if (!this.canEnable()) return;
        this._lastPatchCmd = 'apply';
        this._outcomeUncertain = false;
        const msg = { cmd: 'apply', panel: 'high', mode: 'avb' };
        if (['on', 'off'].includes(this._navmdState())) msg.navmd = this._navmdChoice;
        this._operation = { cmd: 'apply', choice: msg.navmd, sawBusy: false, reconnect: false };
        this._armOperationTimer();
        this.patch.send(msg);
        this.emit('change');
    }

    disableMap() {
        if (!this.canDisable()) return;
        this._lastPatchCmd = 'revert';
        this._outcomeUncertain = false;
        this._operation = { cmd: 'revert', sawBusy: false, reconnect: false };
        this._armOperationTimer();
        this.patch.send({ cmd: 'revert' });
        this.emit('change');
    }

    /* True while the daemon reports a written patch that takes effect only at
     * the next head-unit start (a restart is needed to activate it). On a unit
     * where carplay restarts at once this never holds, so no restart is shown. */
    restartNeeded() {
        const ps = this.patchStatus;
        return !!(ps && ps.carplay === 'deferred');
    }

    restartRequested() {
        return this._restartRequested;
    }

    /* The change waiting for the next head-unit start: "apply", "revert",
     * "unknown" (a daemon that does not say which), or null. From the daemon,
     * else from its marker, which the install writes before the daemon runs. */
    pending() {
        const ps = this.patchStatus;
        if (this.patch.link === 'up') {
            return ps && ps.pending ? ps.pending : ps && ps.carplay === 'deferred' ? 'unknown' : null;
        }
        let marker = null;
        try {
            marker = JSON.parse(fs.readFileSync(this._pendingPath, 'utf8'));
        } catch (e) {
            return null;
        }
        return marker && (marker.action === 'apply' || marker.action === 'revert') ? marker.action : null;
    }

    /* A patch other than the one Enable map writes: another capture sink,
     * panel, size or safe area, from an older app. */
    _outdated(ps) {
        return !!((ps.mode && ps.mode !== 'avb') || (ps.panel && ps.panel !== 'high') ||
            (ps.res && ps.res !== SIZE) || (ps.safe && ps.safe !== SAFE));
    }

    /* Enable map is offered for an original (never patched, or reverted), an
     * unknown or failed state, or an outdated patch, with nothing pending. */
    canEnable() {
        const ps = this.patchStatus;
        if (!this.connectedPatch() || this._restartRequested || !ps || this._needsFreshStatus || this.pending() || this._operation) {
            return false;
        }
        return ['original', 'unknown', 'error'].includes(ps.state) || (ps.state === 'patched' && (this._outdated(ps) ||
            (this._navmdDirty && ['on', 'off'].includes(this._navmdState()))));
    }

    /* Disable map is offered for a patch, or a state that may be one, with
     * nothing pending. */
    canDisable() {
        const ps = this.patchStatus;
        if (!this.connectedPatch() || this._restartRequested || !ps || this._needsFreshStatus || this.pending() || this._operation) {
            return false;
        }
        return ['patched', 'unknown', 'error'].includes(ps.state);
    }

    /* Ask the daemon to activate the pending patch with a normal system reboot.
     * Guarded: only when a restart is actually needed and not already asked. */
    requestRestart() {
        if (!this.restartNeeded() || this._restartRequested) {
            return;
        }
        this._restartRequested = true;
        this.patch.send({ cmd: 'reboot' });
        this.emit('change');
    }

    capture() {
        const active = ['opening', 'open'].includes(this.captureState.state);
        this.patch.send({ cmd: active ? 'capture-stop' : 'capture-start' });
    }

    captureButtonText() {
        return ['opening', 'open'].includes(this.captureState.state) ? 'Stop capture' : 'Capture logs (5 min)';
    }

    captureText() {
        const s = this.captureState;
        if (s.state === 'unavailable') return 'Logs: update Waze tool and reboot to enable capture';
        if (s.state === 'open') return 'Logs: recording — reconnect CarPlay now';
        if (s.state === 'opening') return 'Logs: checking and opening capture…';
        if (s.state === 'closing') return 'Logs: restoring tracing mode…';
        if (s.error) return `Logs: ${s.error}`;
        return 'Logs: capture stopped; saved markers available in diagnostics';
    }

    /* ---- status ---- */
    /* The patch state gates the flow, then the render state drives the line. */
    statusText() {
        const p = this.patch.link;
        if (this._needsFreshStatus) return 'Operation unconfirmed — refreshing patch status…';
        if (p === 'down') {
            return 'Connecting…';
        }
        const pending = this.pending();
        if (pending === 'apply' && !this._restartRequested) {
            return 'Patch pending — reboot to activate';
        }
        if (pending === 'revert' && !this._restartRequested) {
            return 'Removal pending — reboot to finish';
        }
        if (p !== 'up') {
            return 'Patch service unavailable (reboot may be needed)';
        }
        if (this._restartRequested) {
            return 'Restarting head unit…';
        }
        const ps = this.patchStatus;
        if (this._operation && !this._operation.sawBusy && !this._operation.reconnect) {
            return this._operation.cmd === 'revert' ? 'Reverting patch…' : 'Applying patch…';
        }
        const state = ps && ps.state;
        if (state === 'busy') {
            return this._lastPatchCmd === 'revert' ? 'Reverting patch…' : 'Applying patch…';
        }
        if (state === 'error') {
            return 'Patch error' + (ps.reason ? `: ${ps.reason}` : '');
        }
        /* A change written by a daemon that does not say which. */
        if (pending) {
            return `Restart needed — ${ps.reason || 'restart to activate the map patch'}`;
        }
        if (this._outcomeUncertain) return 'Operation unconfirmed — check status before retrying';
        if (state === 'original') {
            return ps.conflict ? `Not patched — ${ps.conflict}` : 'Original — enable the map';
        }
        /* Any state other than patched (unknown, or one this app does not know)
         * needs Enable map, which applies every edit the daemon has. */
        if (state !== 'patched') {
            return ps && ps.conflict ? `Patch state unknown — ${ps.conflict}` : 'Patch state unknown — enable the map';
        }
        /* A unit patched by an older app can sit on another capture sink,
         * panel, size or safe area; the stream then misses the render, or the
         * guidance UI sits under the gauges. Enable map re-applies the current
         * patch. */
        if (this._outdated(ps)) {
            return 'Patched — Enable map to update the patch';
        }
        /* patched: the render tool owns the line */
        if (this.render.link !== 'up') {
            return 'Patched — map service unavailable';
        }
        const rs = this.renderStatus;
        switch (rs && rs.state) {
        case 'starting':
            return 'Starting map…';
        case 'showing':
            return `Showing: ${rs.page || 'Waze map'}` + (rs.reason ? ` — ${rs.reason}` : '');
        case 'error':
            return 'Map error' + (rs.reason ? `: ${rs.reason}` : '');
        case 'frozen':
            return 'Map frozen — reconnect CarPlay';
        default:
            return (rs && rs.reason) || 'Patched — waiting for CarPlay';
        }
    }

    /* Up to MAX_LINES merged log rows, newest first, each tagged by source. */
    rows() {
        return this._lines.map((l) => `${l.src}: ${l.text}`);
    }

    /* ---- internals ---- */
    _onLinkChange(src, reset) {
        this._lines = this._lines.filter((l) => l.src !== src);
        reset();
        this.emit('log');
        this.emit('change');
    }

    _onRender(msg) {
        if (msg.ev === 'status') {
            this.renderStatus = msg;
            this.emit('change');
        } else if (msg.ev === 'log') {
            this._addLine('map', String(msg.line));
            this.emit('log');
        }
    }

    _onPatch(msg) {
        if (msg.ev === 'capture') {
            this.captureState = msg.capture;
            this.emit('change');
        } else if (msg.ev === 'status') {
            this.patchStatus = msg;
            this._needsFreshStatus = false;
            const op = this._operation;
            if (op && msg.state === 'busy') op.sawBusy = true;
            if (op && msg.state === 'error') {
                this._finishOperation();
            } else if (op && msg.state !== 'busy' && (op.sawBusy || op.reconnect)) {
                if (op.cmd === 'apply' && op.sawBusy && typeof op.choice === 'boolean' &&
                    msg.state === 'patched' && !this.pending() &&
                    this._navmdState() === (op.choice ? 'on' : 'off') &&
                    this._navmdChoice === op.choice) {
                    this._navmdDirty = false;
                    this._finishOperation();
                } else if (op.cmd === 'apply' && this.pending()) {
                    /* Reconcile after reboot, never claim the running process changed now. */
                    op.reconnect = true;
                    op.deferred = true;
                    this._stopOperationTimer();
                } else {
                    if (!op.sawBusy) this._outcomeUncertain = true;
                    this._finishOperation();
                }
            }
            /* An operation error does not invalidate a verified disk probe. */
            if (!this._navmdDirty && !this._operation && ['on', 'off'].includes(this._navmdState()) &&
                msg.state !== 'busy') {
                this._navmdChoice = this._navmdState() === 'on';
            }
            this.emit('change');
        } else if (msg.ev === 'reboot-reply') {
            /* A refused request (nothing pending, busy, or already restarting)
             * clears the asked flag so the button returns. A successful one
             * leaves it set until the unit restarts. */
            if (!msg.ok) {
                this._restartRequested = false;
            }
            this.emit('change');
        } else if (msg.ev === 'log') {
            this._addLine('patch', String(msg.line));
            this.emit('log');
        }
    }

    _addLine(src, line) {
        this._lines.unshift({ src, text: line });
        if (this._lines.length > MAX_LINES) {
            this._lines.length = MAX_LINES;
        }
    }
}

module.exports = {
    WazeClusterControl, LineSocket,
    RENDER_PATH, PATCH_PATH, PENDING_PATH, MAX_LINES,
    SIZE, SAFE
};
