/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
/* Host test for the upload governor (governor.h): a scene the display
 * removes lowers the cap one 500 KB/s step at once, no single error of
 * another kind does; evidence that adds up within the window lowers it one
 * step, then waits out the cooldown; it stops at the 2000 KB/s floor; healthy
 * upload raises it one step a minute, idle time neither counting nor
 * resetting, any evidence resetting; a step down soon after a step up
 * doubles the wait for the next one, and a settled period restores it; a
 * step down a removal took holds the cap 10 min; evidence with no upload
 * going is not counted; the reason names the evidence. */
#include <cstdio>
#include <string>

#include "../src/governor.h"

using namespace crs;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

static const uint64_t KB = 1024;

struct Rig {
    Governor g{GovernorConfig()};
    int64_t now = 1000000;
    bool changed = false;
    Rig() { g.activity(now); }   /* writes going */
    /* ms of ticks every 100 ms, with writes going when active. */
    void run(int64_t ms, bool active)
    {
        for (int64_t t = 0; t < ms; t += 100) {
            now += 100;
            if (active)
                g.activity(now);
            changed = g.tick(now) || changed;
        }
    }
    uint64_t kb() const { return g.cap() / KB; }
    /* Two heartbeat silences at once: a step down that holds nothing. */
    void stall()
    {
        g.evidence(Evidence::LinkStall, now);
        g.evidence(Evidence::LinkStall, now);
    }
};

static void no_single_error()
{
    Rig r;
    const Evidence all[] = {Evidence::LinkStall, Evidence::FlushFailure, Evidence::WriteRefused, Evidence::SlowFlush};
    bool held = true;
    for (Evidence e : all) {
        r.g.evidence(e, r.now);
        r.run(31000, true);
        held = held && r.kb() == 5500;
    }
    ok("starts at 5500 KB/s; no single event of another kind than a removal lowers it", held && !r.changed);
}

static void removal_steps_down()
{
    Rig r;
    r.g.evidence(Evidence::Removal, r.now, "map: taken: fetch removed");
    r.run(100, true);
    ok("one removal while writes go: one step down at once, to 5000", r.kb() == 5000);
    ok("the reason names it and the hold", r.g.reason() == "lowered from 5500 KB/s: in 30 s, 1 x scene removed; held 10 min");
    r.g.evidence(Evidence::Removal, r.now);
    r.run(14000, true);
    ok("another within the 15 s cooldown waits for it", r.kb() == 5000);
    r.run(1100, true);
    ok("then steps once more", r.kb() == 4500);
}

static void evidence_adds_up()
{
    Rig r;
    r.g.evidence(Evidence::LinkStall, r.now);
    r.run(20000, true);
    r.g.evidence(Evidence::FlushFailure, r.now);
    r.run(100, true);
    ok("a heartbeat silence and a refused flush 20 s apart: still one short", r.kb() == 5500);
    r.g.evidence(Evidence::SlowFlush, r.now);
    r.run(100, true);
    ok("a slow flush makes 6: one step down, to 5000", r.kb() == 5000);
    ok("the reason names the evidence", r.g.reason().find("1 x heartbeat replies silent") != std::string::npos &&
                                            r.g.reason().find("from 5500") != std::string::npos);
    for (int i = 0; i < 6; i++)
        r.g.evidence(Evidence::SlowFlush, r.now);
    r.run(14000, true);
    ok("within the 15 s cooldown it holds", r.kb() == 5000);
    r.run(1100, true);
    ok("after it, the evidence still in the window steps it again", r.kb() == 4500);
    r.g.evidence(Evidence::SlowFlush, r.now);
    r.run(29000, true);
    r.g.evidence(Evidence::SlowFlush, r.now);
    r.run(2000, true);
    ok("events further apart than the window do not add up", r.kb() == 4500);
    Rig q;
    q.g.evidence(Evidence::FlushFailure, q.now);
    q.g.evidence(Evidence::WriteRefused, q.now);
    q.g.evidence(Evidence::FlushFailure, q.now);
    q.run(100, true);
    ok("three failures together step it down", q.kb() == 5000);
    Rig s;
    s.g.evidence(Evidence::LinkStall, s.now);
    s.run(5000, true);
    s.g.evidence(Evidence::LinkStall, s.now);
    s.run(100, true);
    ok("two heartbeat silences step it down", s.kb() == 5000);
}

static void floor()
{
    Rig r;
    for (int i = 0; i < 20; i++) {
        r.g.evidence(Evidence::Removal, r.now);
        r.run(16000, true);
    }
    ok("persistent evidence: down in 500 KB/s steps to the 2000 KB/s floor, not below", r.kb() == 2000);
    ok("and says so", r.g.reason().find("floor") != std::string::npos);
}

static void recovery()
{
    Rig r;
    r.stall();
    r.run(100, true);
    r.stall();
    r.run(15100, true);
    ok("stepped down twice", r.kb() == 4500);
    /* A step down starts the window empty: the healthy time counts from it. */
    r.run(58900, true);
    ok("no step up before 60 s of healthy upload", r.kb() == 4500);
    r.run(1100, true);
    ok("one step up after it", r.kb() == 5000 && r.g.reason().find("raised from 4500") != std::string::npos);
    r.run(30000, false);   /* writes stop: the first second after them still counts */
    r.run(58000, true);
    ok("idle time does not count toward it", r.kb() == 5000);
    r.run(2100, true);
    ok("and does not reset it: the next step after another 60 s of upload", r.kb() == 5500);
    r.run(600000, true);
    ok("never above the ceiling", r.kb() == 5500);
}

static void evidence_resets_health()
{
    Rig r;
    r.stall();
    r.run(100, true);
    r.run(70000, true);
    ok("recovered once", r.kb() == 5500);
    r.stall();
    r.run(100, true);
    r.run(30100, true);   /* the window empties */
    r.run(40000, true);
    r.g.evidence(Evidence::SlowFlush, r.now);
    r.run(35000, true);
    ok("a single event resets the healthy time without lowering", r.kb() == 5000);
}

static void probation()
{
    Rig r;
    r.stall();
    r.run(100, true);
    r.run(30000 + 60000 + 200, true);
    ok("stepped down and back up", r.kb() == 5500 && r.g.recover_ms() == 60000);
    r.stall();
    r.run(100, true);
    ok("the raised level failing within a minute doubles the wait to 120 s",
       r.kb() == 5000 && r.g.recover_ms() == 120000);
    r.run(100000, true);
    ok("so it is not tried again after 60 s", r.kb() == 5000);
    r.run(25000, true);
    ok("but after 120 s", r.kb() == 5500);
    r.run(600000, true);
    ok("ten minutes with no step down restores the 60 s wait", r.g.recover_ms() == 60000);
}

static void removal_holds()
{
    Rig r;
    r.g.evidence(Evidence::Removal, r.now);
    r.run(100, true);
    r.run(9 * 60000, true);
    ok("a removal's step down: no step up for 9 min of healthy upload", r.kb() == 5000);
    r.run(60000, true);
    ok("one step up once 10 min have passed", r.kb() == 5500);
    Rig s;
    s.stall();
    s.run(100, true);
    s.run(61000, true);
    ok("a step down without a removal: up after a minute", s.kb() == 5500);
    Rig f;
    for (int i = 0; i < 7; i++) {
        f.stall();
        f.run(16000, true);
    }
    const bool at_floor = f.kb() == 2000;
    f.g.evidence(Evidence::Removal, f.now);
    f.run(100, true);
    const bool said = f.g.reason().find("at the floor") == 0 && f.g.reason().find("held 10 min") != std::string::npos;
    f.run(9 * 60000, true);
    ok("a removal at the floor holds it there too", at_floor && said && f.kb() == 2000);
}

static void idle_link()
{
    Rig r;
    r.run(2000, false);
    for (int i = 0; i < 4; i++)
        r.g.evidence(Evidence::Removal, r.now);
    r.run(100, false);
    ok("evidence with no upload going is not counted", r.kb() == 5500 && r.g.score(r.now) == 0);
    r.run(100, true);
    r.g.evidence(Evidence::Removal, r.now);
    r.run(100, true);
    ok("while writes go it is", r.kb() == 5000);
}

static void unlimited()
{
    GovernorConfig c;
    c.max_bps = 0;
    c.floor_bps = 0;
    Governor g(c);
    int64_t now = 0;
    for (int i = 0; i < 10; i++)
        g.evidence(Evidence::Removal, now);
    g.tick(now + 100);
    ok("no ceiling (0): stays unlimited", g.cap() == 0);
}

int main()
{
    no_single_error();
    removal_steps_down();
    evidence_adds_up();
    floor();
    recovery();
    evidence_resets_health();
    probation();
    removal_holds();
    idle_link();
    unlimited();
    std::printf(failures ? "%d FAILED\n" : "all ok\n", failures);
    return failures ? 1 : 0;
}
