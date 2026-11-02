// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Whether the decoder joined the phone's stream after it started.
 *
 * The phone sends SPS, PPS and an IDR only when a stream starts (PATCH.md
 * "Keyframe cadence"), so a decoder that missed the start, or gave up its
 * sequence (decoder_msdk.h), decodes nothing until the next stream. Sampled about once a second: while
 * the stream keeps arriving with no frame decoded and no SPS or IDR, the wait
 * grows from the first such sample. It is 0 once a frame decodes or the
 * stream stops arriving, and from a keyframe that arrives after the last
 * decoded frame (or before any) until a frame decodes: the stream carried a
 * keyframe and the decoder did not start or decode from it, which is not a
 * missed start. */
#ifndef WOC_KEYFRAME_WAIT_H
#define WOC_KEYFRAME_WAIT_H

#include <stdint.h>

namespace woc {

class KeyframeWait {
public:
    /* arrived: the stream's datagrams or bytes so far; decoded: frames
     * decoded so far; keyframes: SPS and IDR units seen so far. */
    void sample(int64_t now_ms, uint64_t arrived, uint64_t decoded, uint64_t keyframes)
    {
        const bool arriving = arrived != arrived_, progressed = decoded != decoded_;
        arrived_ = arrived;
        decoded_ = decoded;
        if (progressed) {
            since_ms_ = -1;
            fault_ = false;
            keyframes_ = keyframes;
            return;
        }
        if (keyframes != keyframes_)
            fault_ = true;
        if (!arriving)
            since_ms_ = -1;
        else if (since_ms_ < 0)
            since_ms_ = now_ms;
    }
    int64_t wait_ms(int64_t now_ms) const { return since_ms_ < 0 || fault_ ? 0 : now_ms - since_ms_; }

private:
    uint64_t arrived_ = 0, decoded_ = 0, keyframes_ = 0;   /* keyframes_: as of the last decoded frame */
    int64_t since_ms_ = -1;
    bool fault_ = false;
};

}  // namespace woc

#endif
