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

// {"type":"cp"|"mate","value":int}, side-to-move-relative — gomachine's eval
// object (server.go evalObject/print_pv's mate-distance formula). `rawScore`
// is this engine's internal VALUE_MATE-relative score; mate scores compose
// correctly across negation so this formula is valid no matter which ply the
// score was produced at (see search.h's Result doc comment).
inline json eval_json(int rawScore) {
    if (is_mate_score(rawScore)) {
        int mateIn = (rawScore > 0) ? (VALUE_MATE - rawScore + 1) / 2
                                     : -(VALUE_MATE + rawScore) / 2;
        return json{{"type", "mate"}, {"value", mateIn}};
    }
    return json{{"type", "cp"}, {"value", rawScore}};
}

// obj[key] is present, non-null, and truthy.
inline bool jbool(const json& obj, const char* key) {
    return obj.contains(key) && !obj[key].is_null() && obj[key].get<bool>();
}

// obj[key] is present and non-null (i.e. the Go *int/*bool pointer would be non-nil).
inline bool jhas(const json& obj, const char* key) {
    return obj.contains(key) && !obj[key].is_null();
}
