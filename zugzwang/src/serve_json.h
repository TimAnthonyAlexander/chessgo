#pragma once
// Small shared helpers for the HTTP serve layer's JSON handlers (serve_handlers.cpp).
#include "vendor/json.hpp"
#include "types.h"
#include <string>

using json = nlohmann::json;

// Thrown by a handler to produce a specific HTTP status + gomachine-shaped
// {"error": "..."} body (mirrors server.writeErr). Caught centrally in
// serve.cpp's route wrapper; anything else escaping a handler is an
// unexpected bug and becomes a 500 "internal engine error" (mirrors
// server.recoverPanics — panic->500 in Go, exception->500 here).
struct ApiError {
    int code;
    std::string message;
};

// Centipawns reported for a tablebase win (negated for a loss).
//
// A Syzygy verdict is NOT an evaluation: internally it is VALUE_TB_WIN (31497), and
// emitting that raw is how a tablebase win rendered as "+314.97" on the eval bar for
// thirty moves — every consumer divides the cp by 100. The truth is carried by the
// separate `tb` field below; this number exists only so that a client which does not
// know about `tb` still shows something honest.
//
// 1000 (= +10.00) and not something bigger, on purpose:
//   * frontend/src/components/EvalBar.tsx already clamps its bar geometry at ±1000, so
//     a TB win pegs the bar exactly at the end with no client change needed;
//   * ten pawns reads as "completely winning" to a human and is a value the engine can
//     genuinely produce, so nothing downstream has to special-case it to stay sane;
//   * it bounds the damage for any consumer that ignores `tb` — a stray TB score
//     perturbs an ACPL/accuracy number by 10 pawns instead of 315.
// It is deliberately NOT distinguishable from a genuine +10.00 by magnitude. That is
// what `tb` is for. (SF makes the opposite trade in its UCI output — `cp 20000 - plies`,
// ~/sf18-arm/src/uci.cpp:531-541 — because a UCI GUI has no room for a second field.
// zugzwang's own UCI output is left alone for exactly that reason; this is the JSON API.)
constexpr int TB_EVAL_CP = 1000;

// {"type":"cp"|"mate","value":int}[,"tb":"win"|"loss"], side-to-move-relative —
// gomachine's eval object (server.go evalObject/print_pv's mate-distance formula),
// plus the optional `tb` discriminator. `rawScore` is this engine's internal
// VALUE_MATE-relative score; mate scores compose correctly across negation so this
// formula is valid no matter which ply the score was produced at (see search.h's
// Result doc comment).
//
// `tb` is ADDITIVE and optional: `type` stays "cp" and `value` stays a usable number,
// so a client built before this field existed keeps working (there is a shipped iOS
// build in the wild). A new `type` enum value would have broken exactly those clients.
// Only "win"/"loss" are ever emitted — the engine has no distinct internal value for a
// tablebase DRAW (a drawn or cursed-win probe comes back as an ordinary small cp, which
// is correct as an evaluation), so there is nothing to discriminate.
inline json eval_json(int rawScore) {
    if (is_mate_score(rawScore)) {
        int mateIn = (rawScore > 0) ? (VALUE_MATE - rawScore + 1) / 2
                                     : -(VALUE_MATE + rawScore) / 2;
        return json{{"type", "mate"}, {"value", mateIn}};
    }
    if (is_tb_score(rawScore)) {
        const bool win = rawScore > 0;
        return json{{"type", "cp"}, {"value", win ? TB_EVAL_CP : -TB_EVAL_CP},
                    {"tb", win ? "win" : "loss"}};
    }
    return json{{"type", "cp"}, {"value", rawScore}};
}

// {type,value} for a source that already split mate out of the score — the variants
// (Duck, Crazyhouse, Antichess, Secret Queen) and the opening book all carry a signed
// mate-in-N alongside a centipawn score, so there is no VALUE_MATE arithmetic to do.
//
// The TB branch of eval_json still applies. Only Secret Queen can actually reach it
// (it leases the real NNUE Search::Context — secretqueen_bot.h — so a <=5-man position
// gets a Syzygy verdict like standard chess does); the other three run their own
// searches over their own eval and cannot produce a TB-band score. Routing all of them
// through here anyway is what makes "no eval this server emits carries |cp| >= 31000"
// a property of the boundary rather than of each call site.
inline json eval_json_parts(int mate, int cp) {
    if (mate != 0) return json{{"type", "mate"}, {"value", mate}};
    return eval_json(cp);
}

// obj[key] is present, non-null, and truthy.
inline bool jbool(const json& obj, const char* key) {
    return obj.contains(key) && !obj[key].is_null() && obj[key].get<bool>();
}

// obj[key] is present and non-null (i.e. the Go *int/*bool pointer would be non-nil).
inline bool jhas(const json& obj, const char* key) {
    return obj.contains(key) && !obj[key].is_null();
}
