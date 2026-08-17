// Wave 4 gate for the SF-net backend's incremental accumulator (see
// docs/tasks/open/sf-net-experiment.md §C and docs/sfnet-wave4.md): walks a real
// do_move/undo_move tree from each of the 560 corpus FENs (plus targeted edge-case
// FENs added HERE — sfnet_corpus.epd itself is audited and stays stable), driving
// SFNet::AccStack exactly the way the engine's search does (attach via
// Position::set_nnue_acc, let do_move/undo_move push/push_delta/pop it via
// EngineAccStack), and at every interior node compares the incremental
// (psqt, positional) pair against SFNet::evaluate_raw()'s from-scratch oracle.
//
//   make sfnet_acc_test
//   ./test/sfnet_acc_test ~/sf18-arm/src/nn-c288c895ea92.nnue test/sfnet_corpus.epd [--depth N]
//
// Must be built with -DSFNET_BACKEND — EngineAccStack (src/engine_backend.h) has to
// resolve to SFNet::AccStack for Position::set_nnue_acc(&stack) to accept an
// SFNet::AccStack*. The Makefile target does this.
//
// This does NOT rely solely on -DNNUE_ASSERT's hard abort-on-drift (which would kill
// the process on the first failure and give no node/failure count): every node's
// comparison is done explicitly via AccStack::eval_pair() (Wave 4, test-only accessor)
// vs SFNet::evaluate_raw(), so a real drift is COUNTED and reported, not just fatal.
// AccStack::eval() (the shipped path, including its NNUE_ASSERT self-check when built
// with that flag) is also called once per node as a smoke check — safe here because
// equality was already independently confirmed first.

#include "sfnet.h"
#include "position.h"
#include "movegen.h"
#include "bitboard.h"
#include "zobrist.h"
#include "engine_backend.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

namespace {

long g_checked = 0;
long g_failed = 0;
constexpr int kMaxPrint = 25;

void check_node(SFNet::AccStack& stack, const Position& pos) {
    // evaluate_raw's documented precondition (assert(!pos.in_check()), a no-op under
    // this codebase's default -DNDEBUG but still not a position it's meant to score) —
    // same skip convention test/sfnet_eval_test.cpp already uses. The walk still
    // recurses through check positions; only the eval comparison is skipped here.
    if (pos.in_check()) return;

    const SFNet::EvalPair inc    = stack.eval_pair(pos);
    const SFNet::EvalPair oracle = SFNet::evaluate_raw(pos);
    ++g_checked;
    if (inc.psqt != oracle.psqt || inc.positional != oracle.positional) {
        ++g_failed;
        if (g_failed <= kMaxPrint) {
            std::fprintf(stderr, "DRIFT fen=%s inc=(%d,%d) oracle=(%d,%d)\n",
                        pos.fen().c_str(), inc.psqt, inc.positional, oracle.psqt, oracle.positional);
        }
    }

    // Smoke-check the shipped path too (post_process +, under -DNNUE_ASSERT, its own
    // internal from-scratch re-check). Cannot abort here in a passing run since the
    // explicit comparison above already proved equality.
    (void) stack.eval(pos);
}

// walk — full-width recursion: every LEGAL move at every node, to `depth` plies.
void walk(SFNet::AccStack& stack, Position& pos, int depth) {
    if (depth == 0) return;
    MoveList list;
    generate<ALL>(pos, list);
    StateInfo st;
    for (const ExtMove& em : list) {
        const Move m = em;
        if (!pos.legal(m)) continue;
        pos.do_move(m, st);
        check_node(stack, pos);
        walk(stack, pos, depth - 1);
        pos.undo_move(m);
    }
}

std::vector<std::string> read_fens(const std::string& path) {
    std::vector<std::string> fens;
    std::ifstream f(path);
    std::string line;
    while (std::getline(f, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' '))
            line.pop_back();
        if (!line.empty()) fens.push_back(line);
    }
    return fens;
}

// Targeted edge-case FENs (kept OUT of test/sfnet_corpus.epd deliberately — see the
// file header above): castling both sides/both colors, en passant, quiet + capture
// promotion, and king moves that cross the mirror line vs stay within it (bucket-only
// crossing) for the base AND threat refresh rules.
const char* kTargetedFens[] = {
    // Castling rights both sides, both colors, clear paths -- castling is available as
    // one of White's (then Black's) very first legal moves.
    "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    // En passant immediately capturable: White plays exd6 e.p. as a root move.
    "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1",
    // Quiet promotion (a8=Q) and capture-promotion (axb8=Q) both available as root moves.
    "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
    // King on d1 (the "files a-d" mirror half): its own legal replies include BOTH a
    // mirror-crossing step (d1-e1/e2, a-d -> e-h -- forces a full base+threat rebuild)
    // and mirror-preserving steps (d1-c1/c2/d2, stays in a-d but some still cross a
    // king-BUCKET boundary, e.g. rank1->rank2 -- base rebuilds regardless per our
    // coarser rule, threat stays on the delta path) -- one root exercising both
    // AccStack refresh paths, with knights present so threat features actually move.
    "4k3/8/8/3n4/3N4/8/8/3K4 w - - 0 1",
    // Same idea from the other mirror half (files e-h) and from Black's own king.
    "4k3/8/4n3/8/8/4N3/8/4K3 w - - 0 1",
    // King on a1 (deep in the a-d half): moves among a1/a2/b1/b2 cross king-BUCKET
    // boundaries while staying mirror-stable -- repeatedly exercises the threat DELTA
    // path (not a rebuild) alongside the base's unconditional-on-any-king-move rebuild.
    "4k3/8/8/3n4/3N4/8/8/K7 w - - 0 1",
};

}  // namespace

int main(int argc, char** argv) {
    BB::init();
    Zobrist::init();

    std::vector<std::string> args(argv + 1, argv + argc);
    int depth = 3;
    std::vector<std::string> pos;
    for (std::size_t i = 0; i < args.size(); ++i) {
        if (args[i] == "--depth" && i + 1 < args.size()) depth = std::atoi(args[++i].c_str());
        else pos.push_back(args[i]);
    }
    if (pos.size() < 2) {
        std::fprintf(stderr, "usage: %s <net.nnue> <fens.epd> [--depth N]\n", argv[0]);
        return 2;
    }
    if (!SFNet::load(pos[0].c_str())) {
        std::fprintf(stderr, "sfnet_acc_test: failed to load net %s\n", pos[0].c_str());
        return 1;
    }

    const std::vector<std::string> fens = read_fens(pos[1]);
    if (fens.empty()) {
        std::fprintf(stderr, "sfnet_acc_test: no FENs read from %s\n", pos[1].c_str());
        return 1;
    }

    SFNet::AccStack stack;

    for (const std::string& fen : fens) {
        Position p;
        p.set(fen);
        p.set_nnue_acc(&stack);
        stack.reset(p);
        walk(stack, p, depth);
        p.set_nnue_acc(nullptr);
    }

    // Targeted edge cases always walk one ply deeper than the bulk corpus (spec: "depth
    // 3-4"), since their whole point is a specific event at/near the root.
    for (const char* fen : kTargetedFens) {
        Position p;
        p.set(fen);
        p.set_nnue_acc(&stack);
        stack.reset(p);
        walk(stack, p, depth + 1);
        p.set_nnue_acc(nullptr);
    }

    std::printf("sfnet_acc_test: %ld corpus FENs, %ld targeted FENs, depth %d (+1 for targeted)\n",
               (long) fens.size(), (long) (sizeof(kTargetedFens) / sizeof(kTargetedFens[0])), depth);
    std::printf("sfnet_acc_test: %ld nodes checked, %ld drift failures\n", g_checked, g_failed);
    std::printf("%s\n", g_failed == 0 ? "RESULT: PASS" : "RESULT: FAIL");
    return g_failed == 0 ? 0 : 1;
}
