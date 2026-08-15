#pragma once

// Compile-time NNUE-backend switch (Wave 4 of the SF-net experiment; see
// docs/tasks/open/sf-net-experiment.md §A and docs/sfnet-wave4.md).
//
// The SF-net backend ships as a SEPARATE BINARY (a build-time -DSFNET_BACKEND, never
// a runtime flag/pointer), so this is a plain type alias resolved at compile time —
// never an indirect/virtual call on the do_move/undo_move hot path, and with
// SFNET_BACKEND undefined it resolves to EXACTLY NNUE::AccStack, so our own net's
// generated code is untouched (see docs/sfnet-wave4.md's byte-identical proof:
// golden_check 38/38 + perft_test, both with SFNET_BACKEND undefined).
//
// NNUE::AccStack and SFNet::AccStack implement the SAME six-method interface
// (AccStack(); reset(pos); push(pos); push_delta(oldb, pos); pushNull(); pop();
// eval(pos)) — see nnue_accumulator.h and sfnet.h — so every call site that goes
// through EngineAccStack compiles unchanged under either backend.
namespace NNUE { class AccStack; }
namespace SFNet { class AccStack; }

#ifdef SFNET_BACKEND
using EngineAccStack = SFNet::AccStack;
#else
using EngineAccStack = NNUE::AccStack;
#endif
