#include "nnue_accumulator.h"
#include "nnue_internal.h"
#include "nnue_net.h"
#include "nnue_features.h"
#include "position.h"

#include <cstring>
#include <cstdio>
#include <cstdlib>

namespace NNUE {

namespace {

// ftAdd / ftSub — add or subtract feature f's int16 FT weight column into a half.
// Mirrors gomachine ftAdd/ftSub (enriched.go): W0i is feature-major, W0i[f*H + i].
// int16 wraparound add/sub, exactly as the from-scratch buildAccHalf.
inline void ft_add(int16_t* acc, int f) {
    const int16_t* col = g_net.W0i.data() + static_cast<std::size_t>(f) * H;
    for (int i = 0; i < H; ++i) acc[i] += col[i];
}
inline void ft_sub(int16_t* acc, int f) {
    const int16_t* col = g_net.W0i.data() + static_cast<std::size_t>(f) * H;
    for (int i = 0; i < H; ++i) acc[i] -= col[i];
}

} // namespace

AccStack::AccStack() : slots_(NumSlots), counts_(static_cast<std::size_t>(InputTotal), 0) {
    for (Slot& s : slots_) {
        s.fw.reserve(MaxActive);
        s.fb.reserve(MaxActive);
    }
    scratch_.base.reserve(MaxActive);
    scratch_.threat.reserve(MaxActive);
}

void AccStack::enumerate_flat(const Position& pos, Color persp, std::vector<int>& out) {
    active_features(pos, persp, scratch_); // fills scratch_.base + scratch_.threat
    out.clear();
    out.insert(out.end(), scratch_.base.begin(), scratch_.base.end());
    out.insert(out.end(), scratch_.threat.begin(), scratch_.threat.end());
}

void AccStack::build_half(int16_t* acc, const std::vector<int>& feats) const {
    const int16_t* B0 = g_net.B0i.data();
    for (int i = 0; i < H; ++i) acc[i] = B0[i];
    for (int f : feats) ft_add(acc, f);
}

// apply_diff: count-array multiset symmetric difference, byte-identical in RESULT to a
// from-scratch build of `child` (int16 column adds commute & associate). Decrement
// counts for parent features, increment for child, then apply the net per-feature delta,
// touching only active indices and zeroing them back out for the next call.
void AccStack::apply_diff(int16_t* acc, const std::vector<int>& parent, const std::vector<int>& child) {
    int16_t* c = counts_.data();
    for (int f : parent) --c[f];
    for (int f : child)  ++c[f];

    auto apply = [&](const std::vector<int>& list) {
        for (int f : list) {
            int d = c[f];
            if (d == 0) continue;
            if (d > 0) { for (; d > 0; --d) ft_add(acc, f); }
            else       { for (; d < 0; ++d) ft_sub(acc, f); }
            c[f] = 0; // handled: cancels dups + leaves counts_ zeroed for the next call
        }
    };
    apply(parent);
    apply(child);
}

void AccStack::reset(const Position& pos) {
    sp_ = 0;
    Slot& s = slots_[0];
    enumerate_flat(pos, WHITE, s.fw);
    enumerate_flat(pos, BLACK, s.fb);
    build_half(s.w, s.fw);
    build_half(s.b, s.fb);
}

void AccStack::push(const Position& pos) {
    Slot& src = slots_[sp_];
    Slot& dst = slots_[sp_ + 1];
    enumerate_flat(pos, WHITE, dst.fw);
    enumerate_flat(pos, BLACK, dst.fb);
    std::memcpy(dst.w, src.w, sizeof(dst.w));
    std::memcpy(dst.b, src.b, sizeof(dst.b));
    apply_diff(dst.w, src.fw, dst.fw);
    apply_diff(dst.b, src.fb, dst.fb);
    ++sp_;
}

void AccStack::pushNull() {
    Slot& src = slots_[sp_];
    Slot& dst = slots_[sp_ + 1];
    std::memcpy(dst.w, src.w, sizeof(dst.w));
    std::memcpy(dst.b, src.b, sizeof(dst.b));
    dst.fw = src.fw; // child of a null node diffs against these (== parent's set)
    dst.fb = src.fb;
    ++sp_;
}

int AccStack::eval(const Position& pos) {
    Slot& top = slots_[sp_];

#ifdef NNUE_ASSERT
    // From-scratch rebuild of both halves — the incremental halves must match int16-exact.
    int16_t rw[H], rb[H];
    std::vector<int> fw, fb;
    fw.reserve(MaxActive);
    fb.reserve(MaxActive);
    enumerate_flat(pos, WHITE, fw);
    enumerate_flat(pos, BLACK, fb);
    build_half(rw, fw);
    build_half(rb, fb);
    for (int i = 0; i < H; ++i) {
        if (top.w[i] != rw[i] || top.b[i] != rb[i]) {
            std::fprintf(stderr,
                "NNUE acc drift sp=%d i=%d w(inc=%d fresh=%d) b(inc=%d fresh=%d) fen=%s\n",
                sp_, i, top.w[i], rw[i], top.b[i], rb[i], pos.fen().c_str());
            std::abort();
        }
    }
#endif

    return NNUE::eval_from_halves(top.w, top.b, pos);
}

} // namespace NNUE
