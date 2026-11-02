/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for slot arbitration (slots.h): a slot is requested once while
 * any layer wants it and released only after none has for linger_ms, so
 * clients coming and going cause no display traffic; content of the stock
 * HMI is yielded to unless a layer contends, which retries on the 2/5/10/20/30
 * s ladder, reset after 30 s shown; content of anything else is always
 * yielded to; a slot the table names as held is not asked for; refusals and
 * no answer retry on the ladder; requests are spaced; the display service
 * going away takes every target down and its return maps the wanted ones
 * again after the settle time; two targets sharing a scene id are never up
 * together. With tables of one row per mapping, as the car reports them:
 * the holder is the row shown; a parked target stays mapped with no
 * timeout until shown; a contending target parked behind the stock HMI's
 * content unmaps it as the HMI, spaced 3, 10, 30 s, the count starting over
 * after 60 s shown or a release, never foreign content, never without a contending
 * layer, never in another slot; a released target is idle; a locked slot
 * coming back is asked for at once. Warm scenes: a target's scene is
 * published once and kept across releases, losses and the display service
 * going; a target with the same scene id takes it down only when it needs
 * the id. After a release the next request waits for the display's
 * confirmation and the renderer's unsubscription, at most 1 s; a fetch failing right after the publication is
 * asked again after 250 ms, three times, then on the ladder; a scene the
 * display removed is asked for again 2 s after, and a fetch failing within
 * 300 ms of that request is asked again after 1.5 s, four times, then on
 * the ladder. Rendering: a
 * shown scene its renderer subscribed to is verified; one not subscribed
 * 1.5 s after it was shown, or after the renderer unsubscribed, is released
 * and asked for again at once, then on the ladder, its scene kept; with no
 * subscription seen since start, nothing is verified or done. */
#include <cstdio>
#include <string>
#include <vector>

#include "../src/slots.h"

using namespace crs;

static int failures;
static std::vector<std::string> calls;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static std::string joined()
{
    std::string s;
    for (auto &c : calls) s += (s.empty() ? "" : "; ") + c;
    calls.clear();
    return s;
}

static bool calls_are(const std::string &want)
{
    const std::string got = joined();
    if (got == want)
        return true;
    std::printf("     got  \"%s\"\n     want \"%s\"\n", got.c_str(), want.c_str());
    return false;
}

struct FakePort : Port {
    bool up = true;
    bool confirm = true;
    bool available() const override { return up; }
    bool confirmed(const TargetSpec &) const override { return confirm; }
    void request(const TargetSpec &t) override { calls.push_back("request " + t.name); }
    void release(const TargetSpec &t) override { calls.push_back("release " + t.name); }
    void take_over(const TargetSpec &t, uint64_t content) override
    {
        char b[24];
        std::snprintf(b, sizeof b, "0x%llx", (unsigned long long)content);
        calls.push_back("take over " + t.name + " " + b);
    }
    void refresh_slots() override { calls.push_back("slots?"); }
};

struct FakeScenes : Scenes {
    bool fail = false;
    bool publish(const TargetSpec &t, std::string *err) override
    {
        calls.push_back("publish " + t.name);
        if (fail) *err = "refused";
        return !fail;
    }
    void unpublish(const TargetSpec &t) override { calls.push_back("unpublish " + t.name); }
    int resends = 0;
    void resent(const TargetSpec &, int64_t) override { resends++; }
};

static const uint64_t kMapScene = 0x010004f0, kPanelScene = 0x01000400;
static const uint64_t kMapSlot = 0x100, kPanelSlot = 0x203, kHudSlot = 0x323;
static const uint64_t kStockMap = 0x01000101;   /* an HmiMain3D scene */
static const uint64_t kHmiMap = 0x01000300;     /* the HMI's map in Map view (VERIFIED) */

struct Rig {
    FakePort port;
    FakeScenes scenes;
    SlotManager m{&port, &scenes};
    int64_t now = 100000;
    Rig()
    {
        TargetSpec map;
        map.name = "map"; map.slot = kMapSlot; map.scene_id = kMapScene; map.width = 1088; map.height = 480;
        map.linger_ms = 2000;
        map.take_over_stock = true;
        TargetSpec panel;
        panel.name = "panel"; panel.slot = kPanelSlot; panel.scene_id = kPanelScene; panel.width = 1920;
        panel.height = 720; panel.linger_ms = 3000;
        TargetSpec hud;
        hud.name = "hud"; hud.slot = kHudSlot; hud.scene_id = kPanelScene; hud.width = 800; hud.height = 480;
        m.add(map);
        m.add(panel);
        m.add(hud);
    }
    void run(int64_t ms, int64_t step = 10)
    {
        for (int64_t t = 0; t < ms; t += step) {
            now += step;
            m.tick(now);
        }
    }
    /* A report of one row: occupied, its content is shown. */
    void slot(uint64_t id, uint32_t status, uint64_t content)
    {
        SlotInfo s;
        s.slot = id; s.status = status; s.content = content; s.map_status = status == 2 ? 1 : 0;
        m.on_slots({s}, now);
    }
    /* A report of one slot as the car gives it: one row per mapping
     * (content, map status), the slot's status in each. */
    void rows(uint64_t id, uint32_t status, std::vector<std::pair<uint64_t, uint32_t>> mappings)
    {
        std::vector<SlotInfo> t;
        for (const auto &mp : mappings) {
            SlotInfo s;
            s.slot = id; s.status = status; s.content = mp.first; s.map_status = mp.second;
            t.push_back(s);
        }
        m.on_slots(t, now);
    }
    TargetState state(int i) const { return m.status(i).state; }
};

static void refcount_and_linger()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("a wanted target is published and requested", calls_are("publish map; request map") &&
                                                         r.state(0) == TargetState::Acquiring);
    r.m.on_shown(kMapScene, r.now);
    ok("and shown once the display says so", r.state(0) == TargetState::Shown && r.m.published(0));
    /* A second client, then the first leaving: still wanted (the compositor
     * ORs its layers), so nothing reaches the display. */
    r.m.want(0, true, false);
    r.run(5000);
    ok("layers coming and going while one wants it: no display traffic", calls_are(""));
    r.m.want(0, false, false);
    r.run(1000);
    ok("the last layer gone: lingering, still mapped", r.state(0) == TargetState::Lingering && calls_are(""));
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("wanted again within the linger: shown at once, no request",
       r.state(0) == TargetState::Shown && calls_are(""));
    r.m.want(0, false, false);
    r.run(1990);
    ok("not released before linger_ms", r.state(0) == TargetState::Lingering && calls_are(""));
    r.run(20);
    ok("released after linger_ms: released, its scene kept published", calls_are("release map") &&
           r.state(0) == TargetState::Idle && !r.m.requested(0) && r.m.published(0));
}

static void timeout_and_ladder()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    joined();
    r.run(4990);
    ok("no answer: still acquiring before 5 s", r.state(0) == TargetState::Acquiring);
    r.run(20);
    ok("no answer for 5 s: taken down, waiting 2 s",
       calls_are("release map") && r.state(0) == TargetState::Waiting &&
           r.m.status(0).retry_ms == r.now + 2000 - 10);
    r.run(1980);
    ok("nothing before the 2 s retry", calls_are(""));
    r.run(20);
    ok("requested again after 2 s", calls_are("request map"));
    r.m.on_refused(kMapScene, Refusal::Config, "E_DCSM_SLOTID_UNKNOWN", r.now);
    ok("a configuration refusal retries on the ladder (5 s)",
       calls_are("release map") && r.m.status(0).retry_ms == r.now + 5000 &&
           r.m.status(0).holder == Holder::None);
    const int64_t at = r.now;
    r.run(4000);
    r.m.on_shown(kMapScene, r.now);
    ok("a late answer to a request taken down is ignored", r.state(0) == TargetState::Waiting);
    r.run(1000);
    ok("next request at the 5 s step", calls_are("request map") && r.now - at == 5000);
}

static void stock_yield()
{
    Rig r;
    r.m.want(1, true, false);   /* an overlay: yields */
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    joined();
    /* The stock HMI maps its speech dialog over ours. */
    r.slot(kPanelSlot, 2, 0x01000400 + 1);
    r.m.on_lost(kPanelScene, "fetch removed", r.now);
    ok("taken by the stock HMI: down, waiting for the slot to be free",
       calls_are("release panel") && r.state(1) == TargetState::Waiting &&
           r.m.status(1).holder == Holder::Stock && r.m.status(1).retry_ms == -1);
    r.run(60000);
    const std::string polled = joined();
    ok("no request while the stock HMI holds it, the table polled every 5 s",
       polled.find("request") == std::string::npos && polled.find("slots?") != std::string::npos &&
           polled.size() <= std::string("slots?; ").size() * 12);
    r.slot(kPanelSlot, 1, 0);
    r.m.tick(r.now);
    ok("requested again once the slot is free", calls_are("request panel"));
}

static void stock_contend()
{
    Rig r;
    r.m.want(0, true, true);   /* the Waze map contends */
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    const int64_t steps[] = {2000, 5000, 10000, 20000, 30000, 30000};
    bool ladder = true;
    for (int64_t step : steps) {
        r.slot(kMapSlot, 2, kStockMap);
        r.m.on_lost(kMapScene, "fetch removed", r.now);
        joined();
        const int64_t at = r.now;
        r.run(step - 10);
        ladder = ladder && calls_are("");
        r.run(10);
        ladder = ladder && calls_are("request map") && r.now - at == step;
        r.m.on_shown(kMapScene, r.now);
        r.run(1000);
    }
    ok("contending with the stock map: retries after 2, 5, 10, 20, 30, 30 s", ladder);
    r.run(30000);
    r.slot(kMapSlot, 2, kStockMap);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    joined();
    ok("30 s shown resets the ladder to 2 s", r.m.status(0).retry_ms == r.now + 2000);
}

static void foreign_always_yields()
{
    Rig r;
    r.slot(kMapSlot, 2, 0x00007777);   /* content of an app outside the service */
    r.m.want(0, true, true);
    r.m.tick(r.now);
    ok("a slot held by a foreign app is not asked for, even contending",
       calls_are("slots?") && r.state(0) == TargetState::Waiting && r.m.status(0).holder == Holder::Foreign);
    r.run(20000);
    ok("still not asked for while it holds it", joined().find("request") == std::string::npos);
    r.slot(kMapSlot, 1, 0);
    r.m.tick(r.now);
    ok("asked for once it is free", calls_are("publish map; request map"));
}

static void idle_precheck()
{
    Rig r;
    r.slot(kPanelSlot, 2, 0x01000400);   /* our panel scene id, but not ours: the speech dialog */
    r.m.want(1, true, false);
    r.m.tick(r.now);
    ok("our scene id in the slot while we publish nothing is the stock HMI's: yield",
       r.state(1) == TargetState::Waiting && r.m.status(1).holder == Holder::Stock &&
           joined().find("request") == std::string::npos);
    r.m.want(1, true, true);
    r.m.tick(r.now);
    ok("a contending layer arriving while yielding retries on the ladder",
       r.m.status(1).retry_ms == r.now + 2000);
    r.m.want(1, false, false);
    r.run(2000);
    ok("nobody wants it when the timer passes: idle", r.state(1) == TargetState::Idle && calls_are(""));
}

static void busy_refusal_unknown_holder()
{
    Rig r;
    r.m.want(1, true, false);
    r.m.tick(r.now);
    joined();
    r.m.on_refused(kPanelScene, Refusal::Busy, "E_DCSM_PRIOTOOLOW", r.now);
    ok("a busy refusal with no table: held by the stock HMI, yield",
       calls_are("release panel") && r.m.status(1).holder == Holder::Stock &&
           r.m.status(1).retry_ms == -1);
    r.run(100);
    ok("the slot table is asked for", calls_are("slots?"));
}

static void availability()
{
    Rig r;
    r.m.want(0, true, true);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.port.up = false;
    r.m.on_availability(false, r.now);
    r.m.tick(r.now);
    ok("display service gone: nothing sent, the scene kept, unavailable",
       calls_are("") && r.state(0) == TargetState::Unavailable && r.m.published(0) && !r.m.requested(0));
    r.run(10000);
    ok("nothing while it is gone", calls_are(""));
    r.port.up = true;
    r.m.on_availability(true, r.now);
    const int64_t at = r.now;
    r.run(990);
    ok("back: nothing during the settle time", calls_are("") && r.state(0) == TargetState::Idle);
    r.run(20);
    ok("requested again after it", calls_are("request map") && r.now - at >= 1000);
    r.m.want(1, false, false);
    ok("an unwanted target stays idle throughout", r.state(1) == TargetState::Idle);
}

static void shared_scene_id()
{
    Rig r;
    r.m.want(1, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    joined();
    r.m.want(2, true, false);   /* the HUD has the panel's scene id */
    r.run(5000);
    ok("a second target with a published scene id waits",
       r.state(2) == TargetState::Waiting && joined().find("hud") == std::string::npos);
    r.m.want(1, false, false);
    r.run(3100);
    const std::string c = joined();
    ok("and is requested once the first is idle",
       c.find("release panel") != std::string::npos &&
           c.find("publish hud; request hud") != std::string::npos);
}

static void request_gap()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_refused(kMapScene, Refusal::Transient, "E_FETCH_STATUS_FAILED", r.now);
    joined();
    r.m.want(0, false, false);
    r.run(2000);
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("after a refusal the ladder is not bypassed by the demand flapping",
       calls_are("request map") && r.now >= 100000 + 2000);
    r.m.on_refused(kMapScene, Refusal::Transient, "E_FETCH_STATUS_FAILED", r.now);
    joined();
    r.m.want(0, false, false);
    r.run(4000);
    r.m.want(0, true, false);
    r.run(500);
    ok("the next step is still 5 s", calls_are(""));
}

static void lost_while_lingering()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    r.m.want(0, false, false);
    r.m.tick(r.now);
    joined();
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    ok("lost while lingering: down and idle, no retry", calls_are("release map") &&
                                                           r.state(0) == TargetState::Idle);
}

static void scene_failure()
{
    Rig r;
    r.scenes.fail = true;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("a scene that cannot be published is not requested, and retried on the ladder",
       calls_are("publish map") && r.state(0) == TargetState::Waiting && r.m.status(0).retry_ms == r.now + 2000);
}

static void ladder_rechecks_the_table()
{
    Rig r;
    r.m.want(0, true, true);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    r.slot(kMapSlot, 2, kStockMap);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    joined();
    r.m.want(0, true, false);   /* the contending layer goes; a yielding one stays */
    r.run(3000);
    ok("on the ladder, the contending layer gone: the stock map's slot is not asked for",
       joined().find("request") == std::string::npos && r.m.status(0).holder == Holder::Stock &&
           r.m.status(0).retry_ms == -1);
}

static void lost_to_our_own_id()
{
    std::vector<std::string> evidence;
    auto shown_panel = [&](Rig &r) {
        r.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { evidence.push_back(evidence_name(e)); };
        r.m.want(1, true, false);
        r.m.tick(r.now);
        r.m.on_shown(kPanelScene, r.now);
        r.slot(kPanelSlot, 2, kPanelScene);   /* the table names our mapping */
        joined();
    };
    Rig a;
    shown_panel(a);
    a.m.on_lost(kPanelScene, "fetch removed", a.now);
    ok("lost while the table names our id: undecided, the table asked for, no evidence yet",
       a.m.status(1).state == TargetState::Waiting && evidence.empty() &&
           joined() == "release panel; slots?");
    a.slot(kPanelSlot, 2, kPanelScene);   /* after our unfetch it still names that id */
    a.m.tick(a.now);
    ok("the next report still names it: the stock HMI's (the speech dialog), yielded to, no evidence",
       a.m.status(1).holder == Holder::Stock && a.m.status(1).retry_ms == -1 && evidence.empty());

    Rig b;
    shown_panel(b);
    b.m.on_lost(kPanelScene, "fetch removed", b.now);
    b.slot(kPanelSlot, 1, 0);
    b.m.tick(b.now);
    ok("the next report shows it free: the loss was ours, evidence, and a retry after the removal wait",
       evidence.size() == 1 && evidence[0] == std::string("scene removed") && b.m.status(1).retry_ms == b.now + SlotManager::kRemovalWaitMs);

    Rig c;
    evidence.clear();
    shown_panel(c);
    c.m.on_lost(kPanelScene, "fetch removed", c.now);
    c.run(990);
    const bool waited = evidence.empty();
    c.run(20);
    ok("no report within 1 s: the loss was ours", waited && evidence.size() == 1);
    ok("and the wait counts from the loss", c.m.status(1).retry_ms == c.now - 1010 + SlotManager::kRemovalWaitMs);

    Rig d;
    std::vector<std::string> ev2;
    d.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { ev2.push_back(evidence_name(e)); };
    d.m.want(0, true, false);
    d.m.tick(d.now);
    d.m.on_shown(kMapScene, d.now);
    d.slot(kMapSlot, 1, kMapScene);   /* a removal: the slot available, our content still named */
    d.m.on_lost(kMapScene, "fetch removed", d.now);
    ok("removed with the slot shown available: evidence at once, and the removal wait",
       ev2.size() == 1 && d.m.status(0).retry_ms == d.now + SlotManager::kRemovalWaitMs);
}

static void lock_is_not_evidence()
{
    Rig r;
    std::vector<std::string> ev;
    r.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { ev.push_back(evidence_name(e)); };
    r.m.want(0, true, true);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.slot(kMapSlot, 0, kMapScene);   /* a door-open warning locks the slot */
    r.m.on_lost(kMapScene, "unmapped", r.now);
    r.run(1500);
    ok("a scene the display takes with a lock is not upload evidence", ev.empty());
    r.slot(kMapSlot, 1, 0);
    r.run(1100);
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.slot(kMapSlot, 1, 0);           /* removed with the slot free: the link */
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    ok("one removed with the slot free still is", ev.size() == 1 && ev[0] == std::string("scene removed"));

    Rig l;   /* lingering: the last layer stopped wanting it */
    std::vector<std::string> evl;
    l.m.on_evidence = [&](Evidence e, const std::string &, int64_t) { evl.push_back(evidence_name(e)); };
    l.m.want(1, true, false);
    l.m.tick(l.now);
    l.m.on_shown(kPanelScene, l.now);
    l.m.want(1, false, false);
    l.run(100);
    l.slot(kPanelSlot, 0, kPanelScene);
    l.m.on_lost(kPanelScene, "unmapped", l.now);
    ok("a lock while lingering is not evidence either", evl.empty());
}

static void slot_comes_back()
{
    Rig r;
    r.m.want(0, true, true);   /* contending, like the Waze map */
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    /* Three losses in a row climb the ladder to its 10 s step. */
    for (int k = 0; k < 3; k++) {
        r.slot(kMapSlot, 0, kMapScene);   /* a door-open warning disables the slot */
        r.m.on_lost(kMapScene, "unmapped", r.now);
        r.run(r.m.status(0).retry_ms - r.now + 10);
        r.m.on_shown(kMapScene, r.now);
        joined();
    }
    r.slot(kMapSlot, 0, kMapScene);
    r.m.on_lost(kMapScene, "unmapped", r.now);
    const int64_t lost = r.now;
    ok("a fourth loss in a row waits 20 s on the ladder", r.m.status(0).retry_ms == lost + 20000);
    joined();
    r.run(3000);   /* one report, before the loss: the display reports a slot only when it changes */
    ok("while the slot stays disabled, nothing is asked for", joined().find("request") == std::string::npos);
    r.slot(kMapSlot, 1, 0);           /* the door closed: the slot is free again */
    r.run(1100);
    ok("the slot free again after it was away: asked for at once, not after 20 s",
       joined().find("request map") != std::string::npos && r.now - lost < 5000);

    Rig v;
    v.m.want(0, true, true);
    v.m.tick(v.now);
    v.m.on_shown(kMapScene, v.now);
    v.slot(kMapSlot, 2, kMapScene);   /* the table names our mapping */
    joined();
    v.m.on_lost(kMapScene, "unmapped", v.now);   /* undecided: the table is asked for */
    v.slot(kMapSlot, 0, kMapScene);   /* its answer: disabled */
    v.run(20);
    v.slot(kMapSlot, 1, 0);
    v.run(1100);
    ok("a loss decided by the next report, the slot disabled then free: asked for at once",
       joined().find("request map") != std::string::npos);

    /* The table as the car reports slot 0x100: our entry and the stock
     * map's, with one slot status. */
    auto table = [](uint32_t status, uint32_t ours_map, uint32_t stock_map) {
        SlotInfo o, h;
        o.slot = h.slot = kMapSlot;
        o.status = h.status = status;
        o.content = kMapScene;
        h.content = 0x01000300;
        o.map_status = ours_map;
        h.map_status = stock_map;
        return std::vector<SlotInfo>{o, h};
    };
    Rig e;
    e.m.want(0, true, true);
    e.m.tick(e.now);
    e.m.on_shown(kMapScene, e.now);
    e.m.on_slots(table(2, 1, 0), e.now);   /* ours mapped, the stock entry listed but not mapped */
    joined();
    e.m.on_lost(kMapScene, "unmapped", e.now);
    e.m.on_slots(table(1, 0, 0), e.now);
    e.run(1500);
    ok("a stock entry listed beside ours but not mapped is not the slot away: the removal wait",
       joined().find("request") == std::string::npos);
    e.run(3600);
    e.m.on_shown(kMapScene, e.now);
    e.m.on_slots(table(2, 0, 1), e.now);   /* the stock map mapped over ours */
    joined();
    e.m.on_lost(kMapScene, "unmapped", e.now);
    e.m.on_slots(table(1, 0, 0), e.now);   /* and gone again */
    e.run(1100);
    ok("the stock map mapped there and gone again: asked for at once",
       joined().find("request map") != std::string::npos);

    Rig q;
    q.m.want(0, true, true);
    q.m.tick(q.now);
    q.m.on_shown(kMapScene, q.now);
    joined();
    q.slot(kMapSlot, 1, 0);           /* the display drops our scene and reports the slot free */
    q.m.on_lost(kMapScene, "unmapped", q.now);
    q.slot(kMapSlot, 1, 0);
    q.run(1500);
    ok("a slot reported free without having been away waits for the ladder",
       joined().find("request") == std::string::npos && q.m.status(0).retry_ms > q.now);
}

static void multi_row_holder()
{
    Rig a;
    /* The stock map shown, ours still listed (unmapped) after it: the last
     * row is not the holder. */
    a.rows(kMapSlot, 2, {{kHmiMap, 1}, {kMapScene, 0}});
    a.m.want(0, true, false);
    a.m.tick(a.now);
    ok("rows like the car's: the shown row holds the slot, whatever comes last",
       a.state(0) == TargetState::Waiting && a.m.status(0).holder == Holder::Stock &&
           joined().find("request") == std::string::npos);
    a.rows(kMapSlot, 1, {{kHmiMap, 0}, {kMapScene, 0}});
    a.m.tick(a.now);
    ok("every row listed unmapped: free, asked for", calls_are("publish map; request map"));

    Rig b;
    b.rows(kMapSlot, 2, {{0x00007777, 0}, {kHmiMap, 1}});
    b.m.want(0, true, true);
    b.m.tick(b.now);
    ok("a foreign row listed but not shown does not hold it: the stock map does, and is contended",
       calls_are("publish map; request map"));

    Rig c;
    c.rows(kMapSlot, 2, {{kHmiMap, 3}, {0x00007777, 1}});
    c.m.want(0, true, true);
    c.m.tick(c.now);
    ok("a foreign row shown, the stock map parked: foreign holds it, yielded to even contending",
       c.m.status(0).holder == Holder::Foreign && joined().find("request") == std::string::npos);
}

/* The map requested and parked behind the stock map: (ours, 3), (stock, 1). */
static void park(Rig &r, bool contend, uint64_t holder = kHmiMap)
{
    r.m.want(0, true, contend);
    r.m.tick(r.now);
    r.rows(kMapSlot, 2, {{holder, 1}, {kMapScene, 3}});
    r.m.on_parked(kMapScene, r.now);
}

static void parked_then_shown()
{
    Rig r;
    park(r, false);
    ok("map status 3: parked behind the stock HMI, the table asked for",
       r.state(0) == TargetState::Parked && r.m.status(0).holder == Holder::Stock &&
           r.m.status(0).reason == "parked behind stock" && r.m.published(0) &&
           calls_are("publish map; request map; slots?"));
    r.run(30000);
    const std::string c = joined();
    ok("parked for 30 s: no timeout, no release, no request, no take-over without a contending layer",
       r.state(0) == TargetState::Parked && c.find("release") == std::string::npos &&
           c.find("request") == std::string::npos && c.find("take over") == std::string::npos);
    r.rows(kMapSlot, 2, {{kHmiMap, 0}, {kMapScene, 1}});
    r.m.on_shown(kMapScene, r.now);
    ok("the stock map unmapped: ours shown (3 -> 1)", r.state(0) == TargetState::Shown && calls_are(""));
    r.rows(kMapSlot, 2, {{kHmiMap, 1}, {kMapScene, 3}});
    r.m.on_parked(kMapScene, r.now);
    ok("shown, then 1 -> 3: parked again, still mapped", r.state(0) == TargetState::Parked &&
                                                            calls_are("slots?") && r.m.published(0));
    r.m.want(0, false, false);
    r.m.tick(r.now);
    ok("parked and nobody wants it: released at once, idle", calls_are("release map") &&
                                                                r.state(0) == TargetState::Idle);

    Rig u;
    u.m.want(0, true, false);
    u.m.tick(u.now);
    joined();
    u.m.on_parked(kMapScene, u.now);
    ok("parked before the table names a holder: parked, holder unknown",
       u.state(0) == TargetState::Parked && u.m.status(0).holder == Holder::None &&
           u.m.status(0).reason == "parked");
    u.rows(kMapSlot, 2, {{kHmiMap, 1}, {kMapScene, 3}});
    ok("the table names it: parked behind stock", u.m.status(0).holder == Holder::Stock &&
                                                     u.m.status(0).reason == "parked behind stock");
}

static void take_over()
{
    Rig r;
    park(r, true);
    joined();
    r.m.tick(r.now);
    ok("contending, parked behind the stock map: it is unmapped as the HMI at once",
       calls_are("take over map 0x1000300; slots?"));
    ok("the next take-over wakes the loop", r.m.wake_in_ms(r.now) == 3000);
    /* The stock map stays on top: the take-overs back off. */
    const int64_t gaps[] = {3000, 10000, 30000, 30000};
    bool spaced = true;
    for (int64_t gap : gaps) {
        const int64_t at = r.now;
        r.run(gap - 10);
        spaced = spaced && joined().find("take over") == std::string::npos;
        r.run(10);
        spaced = spaced && joined().find("take over map 0x1000300") != std::string::npos && r.now - at == gap;
    }
    ok("still behind it: again after 3, 10, 30, 30 s", spaced);
    r.rows(kMapSlot, 2, {{kHmiMap, 3}, {kMapScene, 1}});
    r.m.on_shown(kMapScene, r.now);
    ok("promoted: shown, the HMI's map parked behind ours", r.state(0) == TargetState::Shown);
    r.run(20000);
    r.rows(kMapSlot, 2, {{kHmiMap, 1}, {kMapScene, 3}});
    r.m.on_parked(kMapScene, r.now);
    joined();
    r.run(5000);
    ok("on top again after 20 s shown: the count goes on (30 s after the last)",
       joined().find("take over") == std::string::npos);
    r.rows(kMapSlot, 2, {{kHmiMap, 3}, {kMapScene, 1}});
    r.m.on_shown(kMapScene, r.now);
    r.run(60000);
    r.rows(kMapSlot, 2, {{kHmiMap, 1}, {kMapScene, 3}});
    r.m.on_parked(kMapScene, r.now);
    joined();
    r.m.tick(r.now);
    ok("after 60 s shown the count starts over: at once",
       joined().find("take over map 0x1000300") != std::string::npos);
    r.run(2990);
    ok("and 3 s to the next", joined().find("take over") == std::string::npos);

    Rig s;
    park(s, true);
    s.m.tick(s.now);
    s.run(3000);
    const int64_t second = s.now;
    ok("two take-overs: the next would wait 10 s", joined().find("take over map 0x1000300; slots?; take over") !=
                                                       std::string::npos);
    s.m.want(0, false, false);
    s.m.tick(s.now);
    s.run(1000);
    park(s, true);   /* the stream back, the stock map shown again because of our release */
    joined();
    s.run(1990);
    const bool spaced3 = joined().find("take over") == std::string::npos;
    s.run(1100);
    ok("released and asked for again: the count starts over, 3 s after the last take-over",
       spaced3 && joined().find("take over map 0x1000300") != std::string::npos && s.now - second < 4200);

    Rig f;
    park(f, true, 0x00007777);
    f.run(60000);
    ok("parked behind foreign content: never unmapped", joined().find("take over") == std::string::npos &&
                                                           f.state(0) == TargetState::Parked);

    Rig n;
    park(n, false);
    n.run(10000);
    n.m.want(0, true, true);
    n.m.tick(n.now);
    ok("no take-over until a layer contends; then at once",
       joined().find("take over map 0x1000300") != std::string::npos);

    Rig o;
    o.m.want(0, true, true);
    o.m.tick(o.now);
    o.rows(kPanelSlot, 2, {{kHmiMap, 1}});   /* the stock map shown in another slot */
    o.rows(kMapSlot, 2, {{kMapScene, 3}});
    o.m.on_parked(kMapScene, o.now);
    o.run(10000);
    ok("stock content shown only in another slot: never unmapped", joined().find("take over") == std::string::npos);

    Rig p;
    p.m.want(1, true, true);   /* the panel does not take over */
    p.m.tick(p.now);
    p.rows(kPanelSlot, 2, {{0x01000401, 1}, {kPanelScene, 3}});
    p.m.on_parked(kPanelScene, p.now);
    p.run(10000);
    ok("a target without take_over_stock never unmaps", joined().find("take over") == std::string::npos &&
                                                           p.state(1) == TargetState::Parked);
}

static void fallback_and_lock()
{
    Rig r;
    park(r, true);
    r.m.tick(r.now);
    r.rows(kMapSlot, 2, {{kHmiMap, 3}, {kMapScene, 1}});
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.m.want(0, false, false);
    r.run(2010);
    ok("the stream ended: released after the linger, idle (the display shows the parked stock map)",
       calls_are("release map") && r.state(0) == TargetState::Idle);
    r.rows(kMapSlot, 2, {{kHmiMap, 1}});
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("then a yielding layer: the stock map's slot is not asked for",
       r.state(0) == TargetState::Waiting && r.m.status(0).holder == Holder::Stock);

    Rig l;
    l.m.want(0, true, true);
    l.m.tick(l.now);
    l.rows(kMapSlot, 2, {{kMapScene, 1}, {kHmiMap, 3}});
    l.m.on_shown(kMapScene, l.now);
    joined();
    /* A door opens: the slot locked, every mapping unmapped. */
    l.rows(kMapSlot, 0, {{kMapScene, 0}, {kHmiMap, 0}});
    l.m.on_lost(kMapScene, "unmapped", l.now);
    l.run(500);
    ok("a lock: down, waiting on the ladder", l.state(0) == TargetState::Waiting &&
                                                 joined().find("request") == std::string::npos);
    l.rows(kMapSlot, 1, {{kHmiMap, 0}});
    l.run(600);
    ok("the lock gone: asked for at once", calls_are("request map") && l.m.status(0).retry_ms < 0);

    Rig q;
    park(q, false);
    joined();
    q.rows(kMapSlot, 0, {{kHmiMap, 0}, {kMapScene, 0}});
    q.m.on_lost(kMapScene, "unmapped", q.now);
    ok("a lock while parked: down and waiting", calls_are("release map") &&
                                                   q.state(0) == TargetState::Waiting);
    q.rows(kMapSlot, 1, {{kHmiMap, 0}});
    q.run(1100);
    ok("free again: asked for at once", calls_are("request map"));
}

static void wake()
{
    Rig r;
    ok("no timer when idle", r.m.wake_in_ms(r.now) == -1);
    r.m.want(0, true, false);
    r.m.tick(r.now);
    ok("acquiring wakes at the start timeout", r.m.wake_in_ms(r.now) == 5000);
    r.m.on_shown(kMapScene, r.now);
    r.m.want(0, false, false);
    r.m.tick(r.now);
    ok("lingering wakes at its end", r.m.wake_in_ms(r.now) == 2000);
}

static const std::string kRenderer = "00000000-0000-0000-0000-000000000001";

static void warm_scenes()
{
    Rig r;
    r.m.want(1, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    joined();
    r.m.want(1, false, false);
    r.run(3100);
    ok("released after its linger: the panel's scene stays published",
       calls_are("release panel") && r.m.published(1) && !r.m.requested(1));
    r.m.want(1, true, false);
    r.m.tick(r.now);
    ok("wanted again: requested, nothing published", calls_are("request panel") && r.m.requested(1));
    r.m.on_shown(kPanelScene, r.now);
    r.m.want(1, false, false);
    r.run(3100);
    joined();
    r.m.want(2, true, false);
    r.m.tick(r.now);
    ok("the HUD (the panel's scene id) wanted: the panel's released scene unpublished, then the HUD's published",
       calls_are("unpublish panel; publish hud; request hud") && !r.m.published(1) && r.m.published(2));
    r.m.want(1, true, false);
    r.run(100);
    ok("the panel wanted while the HUD is requested: it waits, the HUD's scene untouched",
       calls_are("") && r.state(1) == TargetState::Waiting && r.m.published(2));
}

/* The panel yields to the stock HMI (waiting for the slot to be free) while
 * the HUD, with the panel's scene id, is shown: the slot coming free must not
 * take the HUD's scene. */
static void shared_scene_in_use()
{
    Rig r;
    r.slot(kPanelSlot, 2, 0x01000101);
    r.m.want(1, true, false);
    r.run(100);
    ok("the panel yields to the stock HMI, waiting for the slot",
       r.state(1) == TargetState::Waiting && r.m.status(1).retry_ms < 0 && calls_are("slots?"));
    r.m.want(2, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kPanelScene, r.now);
    ok("the HUD is shown", calls_are("publish hud; request hud") && r.state(2) == TargetState::Shown);
    r.slot(kPanelSlot, 1, 0);
    r.run(3000);
    ok("the slot free: the panel waits, the HUD's scene and request untouched",
       calls_are("") && r.state(1) == TargetState::Waiting &&
           r.m.status(1).reason == "scene id in use by another target" && r.state(2) == TargetState::Shown &&
           r.m.published(2) && r.m.requested(2) && !r.m.requested(1));
    r.m.want(2, false, false);
    r.run(3100);
    ok("the HUD released: the panel takes the scene id",
       calls_are("release hud; unpublish hud; publish panel; request panel") && r.m.requested(1));
}

/* A fresh retry's early request goes only from its wait. */
static void fresh_retry_cleared()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    const int64_t asked = r.now;
    r.run(10);
    r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
    r.m.want(0, false, false);
    r.run(300);
    ok("unwanted during the 250 ms retry: idle", r.state(0) == TargetState::Idle);
    joined();
    r.m.want(0, true, false);
    while (r.now - asked < 990)
        r.run(10);
    ok("wanted again: no request within 1 s of the last", calls_are(""));
    r.run(10);
    ok("then requested", calls_are("request map") && r.now - asked == 1000);
}

static void release_confirmation()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    joined();
    r.port.confirm = false;
    r.m.want(0, false, false);
    while (r.state(0) != TargetState::Idle)
        r.run(10);
    const int64_t released = r.now;
    r.m.want(0, true, false);
    r.run(500);
    ok("wanted again before the display confirms the release: not asked for", calls_are("release map"));
    ok("woken when the wait for the confirmation ends", r.m.wake_in_ms(r.now) == released + 1000 - r.now);
    r.port.confirm = true;
    r.m.tick(r.now);
    ok("confirmed: asked for at once", calls_are("request map"));

    r.m.on_shown(kMapScene, r.now);
    r.port.confirm = false;
    r.m.want(0, false, false);
    while (r.state(0) != TargetState::Idle)
        r.run(10);
    const int64_t again = r.now;
    joined();
    r.m.want(0, true, false);
    r.run(990);
    ok("never confirmed: nothing for 1 s", calls_are(""));
    r.run(10);
    ok("then asked for anyway", calls_are("request map") && r.now - again == 1000);

    /* Subscriptions observable: the renderer's unsubscription is awaited
     * too (it follows the display's confirmation by about 150 ms). */
    r.m.on_subscription(kMapScene, true, false, kRenderer, r.now);
    r.m.on_shown(kMapScene, r.now);
    r.port.confirm = true;
    r.m.want(0, false, false);
    while (r.state(0) != TargetState::Idle)
        r.run(10);
    const int64_t third = r.now;
    joined();
    r.m.want(0, true, false);
    r.run(150);
    ok("confirmed, the renderer still subscribed: not asked for", calls_are(""));
    r.m.on_subscription(kMapScene, false, false, kRenderer, r.now);
    r.m.tick(r.now);
    ok("the renderer unsubscribed: asked for at once", calls_are("request map") && r.now - third == 150);
    r.m.on_shown(kMapScene, r.now);
    r.m.on_subscription(kMapScene, true, false, kRenderer, r.now);
    r.m.want(0, false, false);
    while (r.state(0) != TargetState::Idle)
        r.run(10);
    const int64_t fourth = r.now;
    joined();
    r.m.want(0, true, false);
    r.run(990);
    ok("a renderer that stays subscribed: nothing for 1 s", calls_are(""));
    r.run(10);
    ok("then asked for anyway", calls_are("request map") && r.now - fourth == 1000);
}

static void fresh_fetch_failed()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    joined();
    bool quick = true;
    for (int k = 0; k < SlotManager::kFreshRetries; k++) {
        r.run(10);
        r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
        const int64_t at = r.now;
        quick = quick && calls_are("release map");
        r.run(240);
        quick = quick && calls_are("");
        r.run(10);
        quick = quick && calls_are("request map") && r.now - at == 250;
    }
    ok("a fetch failing right after the publication: asked again after 250 ms, three times", quick);
    r.run(10);
    r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
    int64_t at = r.now;
    joined();
    r.run(1990);
    ok("the fourth: the ladder", calls_are(""));
    r.run(10);
    ok("its first step, 2 s", calls_are("request map") && r.now - at == 2000);
    r.m.on_shown(kMapScene, r.now);
    r.run(40000);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    r.run(5000);
    r.run(500);
    joined();
    r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
    at = r.now;
    joined();
    r.run(4990);
    ok("a fetch failing long after the publication: the ladder at once", calls_are(""));
    r.run(10);
    ok("its next step, 5 s", calls_are("request map") && r.now - at == 5000);
}

/* On the car: the KOMBI removed the shown map scene, failed the fetch asked
 * 2 s later within 125 ms, and took the one asked 7 s after the removal:
 * asked at 2 s and again 1.5 s after each quick failure, the fourth retry
 * comes at about 8.5 s. */
static void removal_retry()
{
    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.m.on_shown(kMapScene, r.now);
    r.run(40000);
    r.m.on_lost(kMapScene, "fetch removed", r.now);
    const int64_t removed = r.now;
    joined();
    r.run(1990);
    ok("a scene the display removed: not asked for again within 2 s", calls_are(""));
    r.run(10);
    ok("then asked for", calls_are("request map") && r.now - removed == 2000);
    bool quick = true;
    for (int k = 0; k < SlotManager::kNotReadyRetries; k++) {
        r.run(130);
        r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
        const int64_t at = r.now;
        quick = quick && calls_are("release map") && r.m.status(0).reason == "refused: E_FETCH_STATUS_FAILED";
        r.run(1490);
        quick = quick && calls_are("");
        r.run(10);
        quick = quick && calls_are("request map") && r.now - at == 1500;
    }
    ok("a fetch failing within 300 ms of it: not ready, asked again after 1.5 s, four times", quick);
    ok("no resend charged while the display fails the fetches", r.scenes.resends == 0);
    r.run(130);
    r.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", r.now);
    const int64_t at = r.now;
    joined();
    r.run(4990);
    ok("the fifth: the ladder's next step", calls_are(""));
    r.run(10);
    ok("5 s", calls_are("request map") && r.now - at == 5000);
    r.m.on_shown(kMapScene, r.now);
    ok("charged once when the display takes it", r.scenes.resends == 1);

    Rig s;   /* failing later than 300 ms after the request: a refusal, the ladder */
    s.m.want(0, true, false);
    s.m.tick(s.now);
    s.m.on_shown(kMapScene, s.now);
    s.run(40000);
    s.m.on_lost(kMapScene, "fetch removed", s.now);
    s.run(5000);
    s.run(400);
    joined();
    s.m.on_refused(kMapScene, Refusal::FetchFailed, "E_FETCH_STATUS_FAILED", s.now);
    ok("a slow failure after a removal is not 'not ready': the ladder",
       s.m.status(0).retry_ms == s.now + 5000);

    Rig h;   /* the stock map taking the slot is not a removal by the display */
    h.m.want(0, true, true);
    h.m.tick(h.now);
    h.m.on_shown(kMapScene, h.now);
    h.slot(kMapSlot, 2, kStockMap);
    h.m.on_lost(kMapScene, "fetch removed", h.now);
    ok("a slot the stock HMI takes: the ladder's 2 s", h.m.status(0).retry_ms == h.now + 2000);
}

static void rendering()
{
    Rig n;
    n.m.want(0, true, false);
    n.m.tick(n.now);
    n.m.on_shown(kMapScene, n.now);
    joined();
    n.run(10000);
    ok("no subscription line since start: shown, not observable, nothing done",
       n.m.status(0).rendering == Rendering::Unobservable && n.state(0) == TargetState::Shown && calls_are("") &&
           n.m.renderer_text(n.now).find("not observable") != std::string::npos);

    Rig r;
    r.m.want(0, true, false);
    r.m.tick(r.now);
    r.run(100);
    r.m.on_subscription(kMapScene, true, false, kRenderer, r.now);
    r.run(300);
    ok("subscribed at the fetch, before the map: not counted yet", r.m.status(0).rendering == Rendering::None);
    r.m.on_shown(kMapScene, r.now);
    joined();
    ok("shown: verified at once", r.m.status(0).rendering == Rendering::Verified);
    r.run(10000);
    ok("and kept, nothing done", calls_are("") && r.state(0) == TargetState::Shown &&
                                    r.m.status(0).rendering == Rendering::Verified);
    r.m.on_subscription(kMapScene, false, false, kRenderer, r.now);
    r.m.tick(r.now);
    ok("the renderer unsubscribing while shown: checking", r.m.status(0).rendering == Rendering::Checking &&
                                                               r.m.wake_in_ms(r.now) == SlotManager::kVerifyMs);
    r.run(1000);
    r.m.on_subscription(kMapScene, true, false, kRenderer, r.now);
    r.run(1000);
    ok("subscribed again within 1.5 s: verified, nothing done",
       r.m.status(0).rendering == Rendering::Verified && calls_are(""));
    r.m.on_renderer_gone(kRenderer, r.now);
    r.m.tick(r.now);
    r.run(1490);
    ok("the renderer gone: not subscribed for 1.49 s, still shown",
       calls_are("") && r.state(0) == TargetState::Shown && r.m.status(0).rendering == Rendering::Checking);
    r.run(20);
    ok("at 1.5 s: released and asked for again at once, the scene kept",
       calls_are("release map; request map") && r.m.published(0) && r.state(0) == TargetState::Acquiring);
    r.run(200);
    r.m.on_shown(kMapScene, r.now);
    const int64_t shown = r.now;
    r.run(1510);
    ok("shown again, still not subscribed: released, on the ladder (2 s) this time",
       calls_are("release map") && r.state(0) == TargetState::Waiting &&
           r.m.status(0).retry_ms == shown + SlotManager::kVerifyMs + 2000);
    r.run(2000);
    ok("asked for again at the step", calls_are("request map"));
    r.m.on_subscription(kMapScene, true, false, kRenderer, r.now);
    r.run(100);
    r.m.on_shown(kMapScene, r.now);
    ok("subscribed: verified", r.m.status(0).rendering == Rendering::Verified && r.m.published(0));

    Rig u;
    u.m.on_subscription(0x01000300, true, false, kRenderer, u.now);   /* no target of ours publishes it */
    u.m.want(0, true, false);
    u.m.tick(u.now);
    u.m.on_shown(kMapScene, u.now);
    u.m.on_subscription(kMapScene, true, true, kRenderer, u.now);     /* a scene the client does not know */
    joined();
    u.run(1600);
    ok("a subscription line of any scene makes subscriptions observable; one the client did not know is not ours",
       calls_are("release map; request map"));
}

int main()
{
    refcount_and_linger();
    timeout_and_ladder();
    stock_yield();
    stock_contend();
    foreign_always_yields();
    idle_precheck();
    busy_refusal_unknown_holder();
    availability();
    shared_scene_id();
    request_gap();
    lost_while_lingering();
    scene_failure();
    ladder_rechecks_the_table();
    lost_to_our_own_id();
    lock_is_not_evidence();
    slot_comes_back();
    multi_row_holder();
    parked_then_shown();
    take_over();
    fallback_and_lock();
    wake();
    warm_scenes();
    shared_scene_in_use();
    fresh_retry_cleared();
    release_confirmation();
    fresh_fetch_failed();
    removal_retry();
    rendering();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
