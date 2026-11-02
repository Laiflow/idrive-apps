// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "freeze_watch.h"

#include <algorithm>
#include <cstdlib>

namespace woc {

ChangeSampler::ChangeSampler(uint32_t w, uint32_t h, uint32_t step, uint32_t threshold)
    : w_(w), h_(h), step_(step ? step : 1), threshold_(threshold),
      last_((size_t)((w + step_ - 1) / step_) * ((h + step_ - 1) / step_))
{
}

bool ChangeSampler::changed(const uint8_t *y)
{
    bool diff = !have_;
    size_t i = 0;
    uint32_t hist[256] = {};
    for (uint32_t r = 0; r < h_; r += step_) {
        const uint8_t *row = y + (size_t)r * w_;
        for (uint32_t c = 0; c < w_; c += step_, i++) {
            if (!diff && (uint32_t)std::abs((int)row[c] - (int)last_[i]) > threshold_)
                diff = true;
            last_[i] = row[c];
            hist[row[c]]++;
        }
    }
    /* the most samples any band of 2 * threshold + 1 levels holds */
    const uint32_t band = std::min<uint32_t>(2 * threshold_ + 1, 256);
    size_t in = 0, most = 0;
    for (uint32_t v = 0; v < 256; v++) {
        in += hist[v];
        if (v >= band)
            in -= hist[v - band];
        most = std::max(most, in);
    }
    blank_ = i && (i - most) * 1000 <= i;
    have_ = true;
    return diff;
}

void FreezeWatch::frame(int64_t now_ms, bool changed, bool blank)
{
    if (live_) {
        add(now_ms, changed, blank);
        return;
    }
    before_.push_back(Seen{now_ms, changed, blank});
    while (now_ms - before_.front().ms > kLiveLagMs)
        before_.pop_front();
}

void FreezeWatch::add(int64_t now_ms, bool changed, bool blank)
{
    framed_ = true;
    pictured_ = pictured_ || !blank;
    if (!blank)
        blank_since_ms_ = -1;
    else if (blank_since_ms_ < 0)
        blank_since_ms_ = now_ms;
    if (changed || !blank || unchanged_since_ms_ < 0) {
        unchanged_since_ms_ = now_ms;
        times_.clear();
        return;
    }
    times_.push_back(now_ms);
    while (!times_.empty() && now_ms - times_.front() > (int64_t)cfg_.ms)
        times_.pop_front();
}

void FreezeWatch::live(bool on, int64_t now_ms)
{
    if (on == live_)
        return;
    live_ = on;
    reset();
    if (on)
        for (const Seen &s : before_)
            if (now_ms - s.ms <= kLiveLagMs)
                add(s.ms, s.changed, s.blank);
    before_.clear();
}

void FreezeWatch::reset()
{
    framed_ = pictured_ = false;
    blank_since_ms_ = -1;
    unchanged_since_ms_ = -1;
    times_.clear();
}

bool FreezeWatch::frozen(int64_t now_ms) const
{
    const int64_t blank_ms = (int64_t)cfg_.ms * (pictured_ ? 1 : 3);
    if (!cfg_.ms || unchanged_since_ms_ < 0 || now_ms - unchanged_since_ms_ < blank_ms)
        return false;
    /* frames still coming at min_fps over the last ms: a stream that slowed
     * down or stopped is static, not frozen */
    size_t recent = 0;
    for (int64_t t : times_)
        if (now_ms - t <= (int64_t)cfg_.ms)
            recent++;
    return recent * 1000 >= (size_t)cfg_.min_fps * cfg_.ms;
}

Picture FreezeWatch::picture(int64_t now_ms) const
{
    if (!framed_)
        return Picture::None;
    if (!pictured_ || (blank_since_ms_ >= 0 && now_ms - blank_since_ms_ >= (int64_t)cfg_.blank_ms))
        return Picture::Blank;
    return Picture::Shown;
}

void FrameTally::frame(int64_t now_ms, bool changed, bool blank)
{
    if (since_ms_ < 0) {
        since_ms_ = now_ms;
        m_ = Minute();
    }
    m_.frames++;
    if (changed)
        m_.changed++;
    m_.blank = blank;
}

bool FrameTally::take(int64_t now_ms, Minute *out)
{
    if (since_ms_ < 0 || now_ms - since_ms_ < kMinuteMs)
        return false;
    *out = m_;
    since_ms_ = -1;
    return true;
}

}  // namespace woc
