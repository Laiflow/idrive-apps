# robertn_waze_cluster

The HMI app for [waze-on-cluster](../../native/waze-on-cluster), which shows
the CarPlay cluster map (Waze, Apple Maps or Google Maps) on the instrument
cluster of an iDrive 7 (MGU) head unit. Everything is done from the HMI; no
shell is needed.

Install it from the catalog of
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
through the [mgu Store](https://github.com/robertnisipeanu/mgu-store). It requires
waze-on-cluster 0.8.1, which brings the cluster renderer and writes the
CarPlay patch as it installs; one head-unit start activates it. After that
the map is on the cluster whenever CarPlay streams it, whether or not this
app is open.

Set **Instrument cluster > Central display area** to **Map view**: the Waze
map replaces the stock map while CarPlay's cluster stream shows a map, and
the stock map is back when the stream ends or shows none. Until a navigation
app draws on the cluster (in Waze or Google Maps, once a route starts), the
stock map stays and the page shows `Waiting for the phone's map — start
navigation`. **Off** works too, with an empty centre
instead of the stock map. With Route preview or Assisted Driving View the
cluster's own content takes the centre. After changing the setting, CarPlay
may need reconnecting before the map returns: the change can freeze the
phone's cluster stream, and the page then shows `Map frozen — reconnect
CarPlay` while the stock map (in Off, an empty centre) shows.

To remove, remove the app in the Store, then the Waze tool, which reverts
the patch.

## The page

One `LT_State_Wide` page:

| Row | What it does |
|---|---|
| status | the patch and map state: `Patch pending — reboot to activate`, `Removal pending — reboot to finish`, `Original — enable the map`, `Not patched — <reason>`, `Applying patch…`, `Patched — waiting for CarPlay`, `Waiting for the phone's map — start navigation`, `Stream lost — reconnect CarPlay`, `Starting map…`, `Showing: Waze map — 16 frames/s …`, `Map frozen — reconnect CarPlay`, `Map error: …`, `Patch service unavailable (reboot may be needed)` |
| setup | `Set Instrument cluster > Central display area to Map view`, always shown |
| Suppress native guidance: On/Off | stages the optional setting locally; disabled with a reason when the daemon cannot verify availability |
| Guidance status | reports the daemon’s on-disk state or unavailable/unknown reason, separately from a staged choice |
| Apply while parked; CarPlay may restart | safety reminder; the app does not detect whether the vehicle is parked |
| Enable map / Apply settings | applies the patch and any available staged option; Apply settings also appears for a changed option on an already patched map |
| Disable map | reverts the patch, which turns the map off; shown while patched and no change is pending |
| Restart head unit | a normal system reboot; shown only while a written change waits for the next head-unit start |
| Capture logs (5 min) / Stop capture | a bounded DLT capture for diagnostics; start it, then reconnect CarPlay |
| 30 rows | both tools' log lines, newest first, tagged `map:` / `patch:` |

The suppression option defaults to **Off** until a supported daemon reports
its current on/off state. Changing it only stages a selection: it does not
send a patch command. A changed choice is marked `not applied`; a separate
line reports the on-disk state, not the running CarPlay state. Press **Enable map** (or **Apply settings** when the map
is already patched) to apply it. Turning it off restores only the optional
suppression edit; **Disable map** instead reverts the entire patch. Closing
this page never reverts anything. Apply only while parked; CarPlay may restart
when the daemon's recmgr conditions allow. The app does not detect driving
state. If activation is deferred, the page says a reboot is needed rather than
claiming the running process has changed. A staged selection survives status
refreshes and page reconnection while the app remains running, but is not
persisted across app process restarts. Toggling back to the reported on-disk
state cancels an unsubmitted change. If an operation has no confirming status
within two minutes, its outcome remains unconfirmed: the app reconnects and
requests fresh status before permitting another patch operation.

Suppression is unavailable without a root-provisioned, verified anchor; the
page displays the daemon's reason and never accepts or sends an anchor. An old
daemon that omits `navmd` also makes the option unavailable, but map apply
and revert retain their legacy behavior. An unknown or unavailable option
cannot be toggled and is omitted from apply requests.

`Starting map…` shows while the cluster renderer starts; a map error shows
only when the renderer stays unreachable for 15 s. Before the patch daemon
runs (right after the install), the pending patch is read from
`/dev/shm/waze-on-cluster/activation-pending`.

## The sockets

Unix stream sockets, newline-delimited JSON, group `tm_oap_app`. The app
holds them while its page is visible and retries each once a second; the
tools keep running when it closes them.

- **Render** `/dev/shm/waze-on-cluster/ctl.sock`, read-only:
  `{"ev":"status","state","target","page","reason","upload_cap_kb_per_s","upload_reason"}`
  (`state` idle, starting, showing, frozen or error), `{"ev":"log","line"}`.
- **Patch daemon** `/dev/shm/waze-on-cluster/patch.sock` (root). The app sends
  `{"cmd":"apply","panel":"high","mode":"avb","navmd":true|false}` when
  option status is known, otherwise the legacy `{"cmd":"apply","panel":"high","mode":"avb"}`; `{"cmd":"revert"}`,
  `{"cmd":"reboot"}`, `{"cmd":"capture-start"|"capture-stop"}`. The daemon sends
  `{"ev":"status","state","panel","mode","res","safe","carplay","reason","pending","conflict"}`
  plus optional `navmd: {"state":"on"|"off"|"unavailable"|"unknown","reason":…}`
  (`state` original, patched, unknown, busy or error; `carplay: "deferred"`
  while a change waits for the next start), `{"ev":"capture",…}`,
  `{"ev":"reboot-reply","ok","reason"}` and `{"ev":"log","line"}`.

A patch with another sink, panel, size (not `1088x480`) or safe area (not
`504x368+286+72`) shows `Patched — Enable map to update the patch`.

## Build and test

```sh
node tools/test_control.js           # the socket client against fake sockets
node tools/test_page.js              # the page against a fake SDK and HMI
node tools/build.js                  # robertn_waze_cluster@0.4.2.src.tgz
node tools/build.js --sdk <donor>    # also robertn_waze_cluster@0.4.2.tgz
```

The app ships as a source package (`mgu-app.json`; `"build": "unit"` in the
catalog). The repository carries no oap-sdk, which is BMW's: the head unit's
deploy tool links the app against the unit's own oap-sdk and takes the
package's entry point from the unit's own packages. To build the OAP tgz
locally, pass a donor bundle with `--sdk` (or `MGU_SDK_DONOR`), for example
the one `mgu-deploy.sh sdk-donor` takes from the unit. The tests need no
donor.

`node tools/fakes.js <render.sock> <patch.sock>` runs both fakes by hand;
Enter starts or stops a fake CarPlay stream.

| Path | |
|---|---|
| `src/robertn_waze_cluster.js` | the app |
| `src/waze_cluster_control.js` | both socket clients and the status logic |
| `tools/` | build, fakes, tests, icon |
| `robertn_waze_cluster@0.4.2/` | the package tree (manifest, RHMI UI, config) |

## License

GPL-3.0-or-later (`LICENSE`). Third-party files keep their own licenses.
