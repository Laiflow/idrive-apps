/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright (C) 2026 Robert Nisipeanu */
#include "governor.h"

#include <algorithm>
#include <cstdio>
#include <map>

#include "log.h"

namespace crs {

namespace {

int weight(Evidence e)
{
    switch (e) {
    case Evidence::Removal: return Governor::kThreshold;
    case Evidence::LinkStall: return 3;
    case Evidence::FlushFailure:
    case Evidence::WriteRefused: return 2;
    default: return 1;
    }
}

std::string kb(uint64_t bps)
{
    return std::to_string((unsigned long long)(bps / 1024)) + " KB/s";
}

}  // namespace

const char *evidence_name(Evidence e)
{
    switch (e) {
    case Evidence::Removal: return "scene removed";
    case Evidence::LinkStall: return "heartbeat replies silent";
    case Evidence::FlushFailure: return "flush refused";
    case Evidence::WriteRefused: return "setData refused";
    default: return "slow flush";
    }
}

Governor::Governor(const GovernorConfig &cfg) : cfg_(cfg), cap_(cfg.max_bps)
{
    if (cfg_.floor_bps > cfg_.max_bps)
        cfg_.floor_bps = cfg_.max_bps;
    if (cfg_.step_bps == 0)
        cfg_.step_bps = 1;
    reason_ = cfg_.max_bps ? "ceiling" : "no limit";
}

void Governor::evidence(Evidence e, int64_t now_ms, const std::string &detail)
{
    /* Only what happens while writes go says the link falls behind them. */
    if (last_active_ms_ < 0 || now_ms - last_active_ms_ > kActiveMs) {
        log_info("upload: %s%s%s (no upload going: not counted)", evidence_name(e), detail.empty() ? "" : ": ",
                 detail.c_str());
        return;
    }
    events_.push_back(Event{now_ms, e, detail});
    healthy_ms_ = 0;
    log_info("upload: %s%s%s (window %d of %d points)", evidence_name(e), detail.empty() ? "" : ": ", detail.c_str(),
             score(now_ms), kThreshold);
}

void Governor::activity(int64_t now_ms)
{
    last_active_ms_ = now_ms;
}

void Governor::prune(int64_t now_ms)
{
    while (!events_.empty() && now_ms - events_.front().at > kWindowMs)
        events_.pop_front();
}

int Governor::score(int64_t now_ms)
{
    prune(now_ms);
    int s = 0;
    for (const Event &e : events_)
        s += weight(e.kind);
    return s;
}

std::string Governor::summary() const
{
    std::map<Evidence, int> n;
    for (const Event &e : events_)
        n[e.kind]++;
    std::string s;
    for (const auto &kv : n)
        s += (s.empty() ? "" : ", ") + std::to_string(kv.second) + " x " + evidence_name(kv.first);
    return s;
}

/* A removal in the window holds the cap kRemovalHoldMs from now_ms; the
 * reason's suffix for it. */
std::string Governor::hold(int64_t now_ms)
{
    for (const Event &e : events_) {
        if (e.kind == Evidence::Removal) {
            hold_until_ms_ = now_ms + kRemovalHoldMs;
            return "; held " + std::to_string(kRemovalHoldMs / 60000) + " min";
        }
    }
    return "";
}

bool Governor::tick(int64_t now_ms)
{
    if (cfg_.max_bps == 0)
        return false;   /* no limit to steer */
    const int64_t dt = last_tick_ms_ < 0 ? 0 : std::max<int64_t>(0, now_ms - last_tick_ms_);
    last_tick_ms_ = now_ms;
    const int s = score(now_ms);

    if (s >= kThreshold && now_ms >= cooldown_until_ms_) {
        if (cap_ <= cfg_.floor_bps) {
            reason_ = "at the floor; in " + std::to_string(kWindowMs / 1000) + " s: " + summary() + hold(now_ms);
            events_.clear();
            cooldown_until_ms_ = now_ms + kCooldownMs;
            return false;
        }
        const uint64_t was = cap_;
        cap_ = cap_ > cfg_.floor_bps + cfg_.step_bps ? cap_ - cfg_.step_bps : cfg_.floor_bps;
        if (last_up_ms_ >= 0 && now_ms - last_up_ms_ < kProbationMs)
            recover_ms_ = std::min(recover_ms_ * 2, kRecoverMaxMs);
        reason_ = "lowered from " + kb(was) + ": in " + std::to_string(kWindowMs / 1000) + " s, " + summary() +
                  hold(now_ms);
        log_warn("upload: cap %s, %s", kb(cap_).c_str(), reason_.c_str());
        events_.clear();
        cooldown_until_ms_ = now_ms + kCooldownMs;
        last_down_ms_ = now_ms;
        healthy_ms_ = 0;
        return true;
    }

    if (last_down_ms_ >= 0 && now_ms - last_down_ms_ >= kSettledMs)
        recover_ms_ = kRecoverMs;
    /* Healthy time: writes going and nothing in the window. Idle time
     * proves nothing either way. */
    if (s == 0 && last_active_ms_ >= 0 && now_ms - last_active_ms_ <= kActiveMs)
        healthy_ms_ += dt;
    if (cap_ < cfg_.max_bps && healthy_ms_ >= recover_ms_ && now_ms >= hold_until_ms_) {
        const uint64_t was = cap_;
        cap_ = std::min(cap_ + cfg_.step_bps, cfg_.max_bps);
        reason_ = "raised from " + kb(was) + " after " + std::to_string(recover_ms_ / 1000) + " s healthy";
        log_info("upload: cap %s, %s", kb(cap_).c_str(), reason_.c_str());
        last_up_ms_ = now_ms;
        healthy_ms_ = 0;
        return true;
    }
    return false;
}

}  // namespace crs
