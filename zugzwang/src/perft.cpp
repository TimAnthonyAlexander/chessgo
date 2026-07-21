#include "position.h"
#include "movegen.h"
#include "bitboard.h"
#include "zobrist.h"
#include "antichess.h"
#include <iostream>
#include <chrono>
#include <vector>
#include <algorithm>
#include <random>
#include <cmath>
#include <cstdlib>
#include <limits>

static bool ref_legal(Position& pos, Move m) {
    // Reference: make the move, check the mover's king is not attacked, unmake.
    Color us = pos.side_to_move();
    StateInfo st;
    pos.do_move(m, st);
    bool ok = !pos.is_attacked(pos.king_square(us), pos.side_to_move());
    pos.undo_move(m);
    return ok;
}

static bool USE_REF = false;

static uint64_t perft(Position& pos, int depth) {
    if (depth == 0) return 1;
    MoveList list;
    generate<ALL>(pos, list);
    uint64_t nodes = 0;
    StateInfo st;
    for (const ExtMove& m : list) {
        bool lg = USE_REF ? ref_legal(pos, m) : pos.legal(m);
        if (!lg) continue;
        if (depth == 1) { nodes++; continue; }
        pos.do_move(m, st);
        nodes += perft(pos, depth - 1);
        pos.undo_move(m);
    }
    return nodes;
}

static void perft_divide(Position& pos, int depth) {
    MoveList list;
    generate<ALL>(pos, list);
    uint64_t total = 0;
    StateInfo st;
    for (const ExtMove& m : list) {
        if (!pos.legal(m)) continue;
        pos.do_move(m, st);
        uint64_t n = perft(pos, depth - 1);
        pos.undo_move(m);
        std::cout << move_to_uci(m) << ": " << n << "\n";
        total += n;
    }
    std::cout << "Total: " << total << "\n";
}

// Independent brute-force pseudo-legal generator (uses only public accessors).
static void brute_gen(const Position& pos, MoveList& out) {
    Color us = pos.side_to_move();
    U64 occ = pos.pieces();
    for (Square from = A1; from <= H8; from = Square(from + 1)) {
        Piece pc = pos.piece_on(from);
        if (pc == NO_PIECE || color_of(pc) != us) continue;
        PieceType pt = type_of(pc);
        if (pt == PAWN) {
            int up = us == WHITE ? 8 : -8;
            int startRank = us == WHITE ? 1 : 6;
            int promoRank = us == WHITE ? 7 : 0;
            Square one = Square(from + up);
            auto emit = [&](Square to) {
                if (rank_of(to) == promoRank) {
                    for (PieceType p : {QUEEN, ROOK, BISHOP, KNIGHT})
                        out.add(make<PROMOTION>(from, to, p));
                } else out.add(make_move(from, to));
            };
            if (is_ok(one) && pos.empty(one)) {
                emit(one);
                Square two = Square(from + 2 * up);
                if (rank_of(from) == startRank && pos.empty(two)) out.add(make_move(from, two));
            }
            // captures
            for (int dc : {-1, 1}) {
                int nf = file_of(from) + dc, nr = rank_of(from) + (up / 8);
                if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
                Square to = make_square(nf, nr);
                if (!pos.empty(to) && color_of(pos.piece_on(to)) != us) emit(to);
                if (to == pos.ep_square()) out.add(make<EN_PASSANT>(from, to));
            }
        } else {
            U64 att;
            switch (pt) {
                case KNIGHT: att = BB::attacks<KNIGHT>(from); break;
                case BISHOP: att = BB::attacks<BISHOP>(from, occ); break;
                case ROOK:   att = BB::attacks<ROOK>(from, occ); break;
                case QUEEN:  att = BB::attacks<QUEEN>(from, occ); break;
                default:     att = BB::attacks<KING>(from); break;
            }
            att &= ~pos.pieces(us);
            while (att) { Square to = BB::pop_lsb(att); out.add(make_move(from, to)); }
        }
    }
    // castling (brute, Chess960-generalized): king from its current square,
    // rook from Position's stored origin (standard chess: always a/h-file).
    // Independent re-derivation of the "squares between must be empty" span
    // from BB::span_bb, deliberately re-walked here (not calling
    // generate_castling) so this stays a genuine differential oracle.
    Square ksq = pos.king_square(us);
    if (!pos.in_check()) {
        int rank = (us == WHITE) ? 0 : 7;
        auto tryCastle = [&](int flag, bool kingside) {
            if (!(pos.castling_rights() & flag)) return;
            Square rfrom = pos.castling_rook_square(flag);
            Square kto = make_square(kingside ? 6 : 2, rank);
            Square rto = make_square(kingside ? 5 : 3, rank);
            U64 mustEmpty = (BB::span_bb(ksq, kto) | BB::span_bb(rfrom, rto))
                           & ~(BB::square_bb(ksq) | BB::square_bb(rfrom));
            if (occ & mustEmpty) return;
            out.add(make<CASTLING>(ksq, kto, kingside ? CASTLE_KINGSIDE : CASTLE_QUEENSIDE));
        };
        if (us == WHITE) { tryCastle(WHITE_OO, true); tryCastle(WHITE_OOO, false); }
        else             { tryCastle(BLACK_OO, true); tryCastle(BLACK_OOO, false); }
    }
}

static bool found_bug3 = false;
static void hunt_gen(Position& pos, int depth) {
    if (found_bug3 || depth == 0) return;
    MoveList mine, brute;
    generate<ALL>(pos, mine);
    brute_gen(pos, brute);
    // Compare LEGAL move sets (filter both by ref_legal)
    auto keyset = [&](MoveList& l) {
        std::vector<Move> v;
        for (auto& m : l) if (ref_legal(pos, m)) v.push_back(m.move);
        std::sort(v.begin(), v.end());
        v.erase(std::unique(v.begin(), v.end()), v.end());
        return v;
    };
    auto vm = keyset(mine), vb = keyset(brute);
    if (vm != vb) {
        std::cout << "GEN MISMATCH mine=" << vm.size() << " brute=" << vb.size()
                  << "\nFEN: " << pos.fen() << "\n";
        for (Move m : vb) if (!std::binary_search(vm.begin(), vm.end(), m))
            std::cout << "  MISSING from generate<ALL>: " << move_to_uci(m) << "\n";
        for (Move m : vm) if (!std::binary_search(vb.begin(), vb.end(), m))
            std::cout << "  EXTRA in generate<ALL>: " << move_to_uci(m) << "\n";
        found_bug3 = true;
        return;
    }
    StateInfo st;
    for (auto& m : mine) {
        if (!pos.legal(m)) continue;
        pos.do_move(m, st); hunt_gen(pos, depth - 1); pos.undo_move(m);
        if (found_bug3) return;
    }
}

static bool found_bug2 = false;
static void hunt_state(Position& pos, int depth) {
    if (found_bug2 || depth == 0) return;
    // Compare live movegen count to a fresh position rebuilt from FEN.
    std::string f = pos.fen();
    Position fresh; fresh.set(f);
    MoveList a, b;
    generate<ALL>(pos, a);
    generate<ALL>(fresh, b);
    if (a.size() != b.size()) {
        std::cout << "STATE CORRUPT: live=" << a.size() << " fresh=" << b.size()
                  << "\nFEN: " << f << "\n";
        found_bug2 = true;
        return;
    }
    MoveList list; generate<ALL>(pos, list);
    StateInfo st;
    for (const ExtMove& m : list) {
        if (!pos.legal(m)) continue;
        pos.do_move(m, st);
        hunt_state(pos, depth - 1);
        pos.undo_move(m);
        if (found_bug2) return;
    }
}

static bool found_bug = false;
static void hunt(Position& pos, int depth) {
    if (found_bug || depth == 0) return;
    MoveList list;
    generate<ALL>(pos, list);
    StateInfo st;
    for (const ExtMove& m : list) {
        bool a = pos.legal(m);
        bool b = ref_legal(pos, m);
        if (a != b) {
            std::cout << "MISMATCH move=" << move_to_uci(m)
                      << " legal()=" << a << " ref=" << b
                      << " type=" << (type_of_move(m) >> 14)
                      << "\nFEN: " << pos.fen() << "\n";
            found_bug = true;
            return;
        }
        if (b) { pos.do_move(m, st); hunt(pos, depth - 1); pos.undo_move(m); }
        if (found_bug) return;
    }
}

struct Test { const char* fen; int depth; uint64_t expected; };

int main(int argc, char** argv) {
    BB::init();
    Zobrist::init();

    if (getenv("REF")) USE_REF = true;

    if (argc >= 3 && std::string(argv[1]) == "huntgen") {
        Position pos; pos.set(argv[2]);
        hunt_gen(pos, argc >= 4 ? atoi(argv[3]) : 4);
        if (!found_bug3) std::cout << "no gen mismatch\n";
        return 0;
    }

    if (argc >= 3 && std::string(argv[1]) == "huntstate") {
        Position pos; pos.set(argv[2]);
        hunt_state(pos, argc >= 4 ? atoi(argv[3]) : 4);
        if (!found_bug2) std::cout << "no state corruption found\n";
        return 0;
    }

    if (argc >= 3 && std::string(argv[1]) == "hunt") {
        Position pos; pos.set(argv[2]);
        hunt(pos, argc >= 4 ? atoi(argv[3]) : 4);
        if (!found_bug) std::cout << "no mismatch found\n";
        return 0;
    }

    if (argc >= 3 && std::string(argv[1]) == "divide") {
        Position pos;
        std::string fen = argv[2];
        int depth = argc >= 4 ? atoi(argv[3]) : 4;
        pos.set(fen);
        perft_divide(pos, depth);
        return 0;
    }

    // Authoritative Chess960 (Fischer Random) perft positions — Andrew
    // Grant's Ethereal FRC suite (Chess Programming Wiki, "Chess960 Perft
    // Results"), the same 6 positions gomachine's chess/frc_test.go uses as
    // its oracle. Castling fields are Shredder-FEN (file letters). Run via
    // `./perft_test frc [depth]`.
    struct FrcTest { const char* name; const char* fen; uint64_t nodes[5]; };
    FrcTest frcTests[] = {
        {"frc1", "bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9",
            {21, 528, 12189, 326672, 8146062}},
        {"frc2", "2nnrbkr/p1qppppp/8/1ppb4/6PP/3PP3/PPP2P2/BQNNRBKR w HEhe - 1 9",
            {21, 807, 18002, 667366, 16253601}},
        {"frc3", "b1q1rrkb/pppppppp/3nn3/8/P7/1PPP4/4PPPP/BQNNRKRB w GE - 1 9",
            {20, 479, 10471, 273318, 6417013}},
        {"frc4", "qbbnnrkr/2pp2pp/p7/1p2pp2/8/P3PP2/1PPP1KPP/QBBNNR1R w hf - 0 9",
            {22, 593, 13440, 382958, 9183776}},
        {"frc5", "qnbnr1kr/ppp1b1pp/4p3/3p1p2/8/2NPP3/PPP1BPPP/QNB1R1KR w HEhe - 1 9",
            {29, 899, 26578, 824055, 24851983}},
        {"frc6", "1nbbnrkr/p1p1ppp1/3p4/1p3P1p/3Pq2P/8/PPP1P1P1/QNBBNRKR w HFhf - 0 9",
            {28, 1120, 31058, 1171749, 34030312}},
    };

    if (argc >= 2 && std::string(argv[1]) == "frc") {
        int depth = argc >= 3 ? atoi(argv[2]) : 4;
        if (depth < 1 || depth > 5) depth = 4;
        bool frcPass = true;
        for (auto& t : frcTests) {
            Position pos;
            pos.set(t.fen);
            auto start = std::chrono::high_resolution_clock::now();
            uint64_t got = perft(pos, depth);
            auto end = std::chrono::high_resolution_clock::now();
            double ms = std::chrono::duration<double, std::milli>(end - start).count();
            uint64_t want = t.nodes[depth - 1];
            bool ok = got == want;
            frcPass &= ok;
            std::cout << (ok ? "PASS" : "FAIL")
                      << " " << t.name << " depth " << depth
                      << " got " << got << " expected " << want
                      << "  (" << (ms > 0 ? (uint64_t)(got / (ms / 1000.0) / 1e6) : 0) << " Mnps)  "
                      << t.fen << "\n";
        }
        std::cout << (frcPass ? "\nALL FRC PERFT TESTS PASSED\n" : "\nSOME FRC TESTS FAILED\n");
        return frcPass ? 0 : 1;
    }

    // Authoritative Antichess (Losing/Suicide Chess) perft positions — an
    // INDEPENDENT oracle (python-chess's chess.variant.AntichessBoard, a real
    // antichess ruleset implementation incl. forced capture, king-promotion,
    // and stalemate-as-a-win), computed by a throwaway script and hardcoded
    // here. Run via `./perft_test antichess [depth]`.
    struct AcTest { const char* name; const char* fen; int maxDepth; uint64_t nodes[5]; };
    AcTest acTests[] = {
        // Standard start position.
        {"start", "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 5,
            {20, 400, 8067, 153299, 2732672}},
        // A lone-pawn promotion race — exercises every promotion piece
        // (including KING) on a quiet (non-forced) push to the last rank.
        {"promo-race", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1", 4, {10, 50, 569, 3853, 0}},
        // En-passant is the ONLY legal capture here -> forced (depth-1 == 1).
        {"ep-forced", "4k3/8/8/8/pP6/8/8/4K3 b - b3 0 1", 4, {1, 5, 30, 204, 0}},
        // A busy middlegame-ish position with several forced-capture lines.
        {"busy", "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 2", 4,
            {29, 644, 10484, 166043, 0}},
        // A forced pawn capture onto the last rank -> must promote, incl. to
        // KING (python-chess includes king-promotion in AntichessBoard; a
        // depth-1 count of 5 here proves this engine generates it too: one
        // capture destination x five promotion choices Q/R/B/N/K).
        {"king-promo", "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1", 4, {5, 25, 282, 1831, 0}},
    };

    if (argc >= 2 && std::string(argv[1]) == "antichess") {
        bool acPass = true;
        for (auto& t : acTests) {
            AntichessState st;
            std::string err;
            if (!antichess_parse(t.fen, st, err)) {
                std::cout << "FAIL " << t.name << " (fen parse: " << err << ")\n";
                acPass = false;
                continue;
            }
            for (int depth = 1; depth <= t.maxDepth; ++depth) {
                auto start = std::chrono::high_resolution_clock::now();
                uint64_t got = antichess_perft(st, depth);
                auto end = std::chrono::high_resolution_clock::now();
                double ms = std::chrono::duration<double, std::milli>(end - start).count();
                uint64_t want = t.nodes[depth - 1];
                bool ok = got == want;
                acPass &= ok;
                std::cout << (ok ? "PASS" : "FAIL")
                          << " " << t.name << " depth " << depth
                          << " got " << got << " expected " << want
                          << "  (" << (ms > 0 ? (uint64_t)(got / (ms / 1000.0) / 1e6) : 0) << " Mnps)  "
                          << t.fen << "\n";
            }
        }
        std::cout << (acPass ? "\nALL ANTICHESS PERFT TESTS PASSED\n" : "\nSOME ANTICHESS PERFT TESTS FAILED\n");
        return acPass ? 0 : 1;
    }

    // Search smoke check: proves antichess_best_move is actually wired up —
    // returns a LEGAL move from the start position, and from a position with
    // a forced capture, the returned move IS that capture.
    if (argc >= 2 && std::string(argv[1]) == "antichess-search") {
        bool smokePass = true;

        AntichessState start;
        std::string err;
        antichess_parse(ANTICHESS_START_FEN, start, err);

        AntichessLimits lim = antichess_default_limits();
        lim.movetimeMs = 1000;
        auto t0 = std::chrono::high_resolution_clock::now();
        AntichessResult res = antichess_best_move(start, lim);
        auto t1 = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

        std::vector<std::string> legal = antichess_legal_moves(start);
        bool isLegal = res.hasMove &&
                       std::find(legal.begin(), legal.end(), res.move.uci()) != legal.end();
        smokePass &= isLegal;
        std::cout << (isLegal ? "PASS" : "FAIL") << " start: bestmove=" << (res.hasMove ? res.move.uci() : "none")
                  << " depth=" << res.depth << " nodes=" << res.nodes << " score=" << res.score
                  << " (" << ms << " ms)\n";

        AntichessState kingPromo;
        antichess_parse("1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1", kingPromo, err);
        AntichessLimits lim2 = antichess_default_limits();
        lim2.movetimeMs = 200;
        AntichessResult res2 = antichess_best_move(kingPromo, lim2);
        bool isForcedCapture = res2.hasMove && antichess_is_capture(kingPromo, res2.move);
        smokePass &= isForcedCapture;
        std::cout << (isForcedCapture ? "PASS" : "FAIL")
                  << " forced-capture position: bestmove=" << (res2.hasMove ? res2.move.uci() : "none")
                  << " (must capture a7xb8)\n";

        std::cout << (smokePass ? "\nANTICHESS SEARCH SMOKE PASSED\n" : "\nANTICHESS SEARCH SMOKE FAILED\n");
        return smokePass ? 0 : 1;
    }

    // ============ Antichess strength measurement harness ============
    //
    // The engine-strength wave's evidence-gathering tool (see antichess.cpp's
    // file doc for what "candidate" vs "legacy/baseline" means: candidate is
    // the live search — opening book + corrected/extended eval + quiet-node
    // LMR; baseline/legacy is the exact pre-improvement code path, reproduced
    // byte-for-byte in-process via antichess_best_move_ex's candidateMode
    // flag, NOT a separately compiled binary). Two subcommands:
    //
    //   ./perft_test antichess-bench [movetimeMs]
    //     Prints the candidate's chosen move + top root-move scores + depth
    //     reached at three sample positions (opening / mid-capture / sparse
    //     endgame), plus a book-coverage sanity check.
    //
    //   ./perft_test antichess-selfplay <P1vP2> [games] [movetimeMs]
    //     Plays <games> full self-play games between two choosers, colors
    //     alternating every game, and reports W/D/L + a rough Elo delta from
    //     P1's perspective. P in {C=candidate engine, B=legacy/baseline
    //     engine, R=uniform random legal mover, G=1-ply-static-eval greedy
    //     mover (fixed legacy eval — an unchanging yardstick both profiles
    //     are measured against)}.
    if (std::string(argv[1] ? argv[1] : "") == "antichess-bench" ||
        std::string(argv[1] ? argv[1] : "") == "antichess-selfplay") {

        enum class AcPlayerKind { Candidate, Baseline, Random, Greedy };

        auto playerKind = [](char c) {
            switch (c) {
                case 'C': return AcPlayerKind::Candidate;
                case 'B': return AcPlayerKind::Baseline;
                case 'G': return AcPlayerKind::Greedy;
                default:  return AcPlayerKind::Random; // 'R' or anything unrecognized
            }
        };
        auto playerName = [](AcPlayerKind k) -> const char* {
            switch (k) {
                case AcPlayerKind::Candidate: return "candidate";
                case AcPlayerKind::Baseline:  return "baseline";
                case AcPlayerKind::Random:    return "random";
                case AcPlayerKind::Greedy:    return "greedy";
            }
            return "?";
        };
        // moves is guaranteed non-empty: callers only ask a chooser to act on
        // an Ongoing (antichess_status) position.
        auto chooseMove = [](AcPlayerKind kind, const AntichessState& s, const std::vector<uint64_t>& history,
                              int movetimeMs, std::mt19937_64& rng) -> AntichessMove {
            std::vector<AntichessMove> moves = antichess_legal_moves_struct(s);
            switch (kind) {
                case AcPlayerKind::Candidate:
                case AcPlayerKind::Baseline: {
                    AntichessLimits lim = antichess_default_limits();
                    lim.movetimeMs = movetimeMs;
                    AntichessResult r = antichess_best_move_ex(s, lim, history, kind == AcPlayerKind::Candidate);
                    return r.hasMove ? r.move : moves[0];
                }
                case AcPlayerKind::Random: {
                    std::uniform_int_distribution<size_t> dist(0, moves.size() - 1);
                    return moves[dist(rng)];
                }
                case AcPlayerKind::Greedy: {
                    // 1-ply static eval, no search — a fixed reference
                    // opponent using the UNCHANGING legacy eval (independent
                    // of whatever this run's candidate eval looks like), so
                    // G is a stable yardstick across the whole experiment.
                    AntichessMove best = moves[0];
                    int bestScore = std::numeric_limits<int>::min();
                    for (const AntichessMove& m : moves) {
                        AntichessState child = antichess_do_move(s, m);
                        int score = -antichess_evaluate_legacy(child);
                        if (score > bestScore) { bestScore = score; best = m; }
                    }
                    return best;
                }
            }
            return moves[0];
        };

        struct AcMatchResult { int p1Wins = 0, p2Wins = 0, draws = 0, games = 0; };

        auto eloDiff = [](double scoreFrac) {
            double p = std::min(0.999, std::max(0.001, scoreFrac));
            return -400.0 * std::log10(1.0 / p - 1.0);
        };

        auto playMatch = [&](AcPlayerKind p1, AcPlayerKind p2, int games, int movetimeMs) {
            AcMatchResult res;
            AntichessState start;
            std::string err;
            antichess_parse(ANTICHESS_START_FEN, start, err);
            constexpr int MAX_PLY = 240; // adjudicated draw past this (antichess games are normally MUCH shorter)

            for (int g = 0; g < games; ++g) {
                bool p1IsWhite = (g % 2 == 0); // alternate colors every game
                std::mt19937_64 rng(0x9E3779B97F4A7C15ULL ^ (uint64_t(g) * 0x2545F4914F6CDD1DULL));

                AntichessState state = start;
                std::vector<uint64_t> history;
                AntichessStatus st = antichess_status(state, history);
                int ply = 0;
                while (st == AntichessStatus::Ongoing && ply < MAX_PLY) {
                    bool whiteToMove = (state.side == WHITE);
                    AcPlayerKind mover = (whiteToMove == p1IsWhite) ? p1 : p2;
                    AntichessMove mv = chooseMove(mover, state, history, movetimeMs, rng);
                    history.push_back(state.key());
                    state = antichess_do_move(state, mv);
                    ply++;
                    st = antichess_status(state, history);
                }

                res.games++;
                if (st == AntichessStatus::Draw || st == AntichessStatus::Ongoing) { res.draws++; continue; }
                bool whiteWon = (st == AntichessStatus::WhiteWin);
                if (whiteWon == p1IsWhite) res.p1Wins++; else res.p2Wins++;
            }
            return res;
        };

        if (std::string(argv[1]) == "antichess-bench") {
            int movetimeMs = argc >= 3 ? atoi(argv[2]) : 500;

            struct BenchPos { const char* label; const char* fen; };
            BenchPos positions[] = {
                {"opening (start)", ANTICHESS_START_FEN},
                {"mid-capture-rich", "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 2"},
                {"sparse endgame (K+P vs K promo race)", "4k3/P7/8/8/8/8/8/4K3 w - - 0 1"},
            };

            for (auto& bp : positions) {
                AntichessState st;
                std::string err;
                if (!antichess_parse(bp.fen, st, err)) { std::cout << "parse error: " << err << "\n"; continue; }

                std::cout << "\n== " << bp.label << " (" << bp.fen << ") ==\n";

                for (bool cand : {true, false}) {
                    AntichessLimits lim = antichess_default_limits();
                    lim.movetimeMs = movetimeMs;
                    auto t0 = std::chrono::high_resolution_clock::now();
                    AntichessResult r = antichess_best_move_ex(st, lim, {}, cand);
                    auto t1 = std::chrono::high_resolution_clock::now();
                    double ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

                    std::cout << "  [" << (cand ? "candidate" : "baseline ") << "] bestmove="
                              << (r.hasMove ? r.move.uci() : "none") << (r.fromBook ? " [BOOK]" : "")
                              << " depth=" << r.depth << " nodes=" << r.nodes << " score=" << r.score
                              << " mate=" << r.mate << "  (" << ms << " ms)\n";
                }

                std::vector<AntichessRootScore> roots = antichess_root_scores_for_test(st, movetimeMs, true);
                std::cout << "  [candidate] top root moves:";
                for (size_t i = 0; i < roots.size() && i < 5; ++i)
                    std::cout << " " << roots[i].move.uci() << "(" << roots[i].score << ")";
                std::cout << "\n";
            }

            AntichessState startPos;
            std::string err;
            antichess_parse(ANTICHESS_START_FEN, startPos, err);
            std::cout << "\nbook covers the standard start: "
                      << (antichess_is_standard_start_for_test(startPos) ? "yes" : "no") << "\n";
            return 0;
        }

        // antichess-selfplay
        std::string matchup = argc >= 3 ? argv[2] : "CvR";
        int games = argc >= 4 ? atoi(argv[3]) : 40;
        int movetimeMs = argc >= 5 ? atoi(argv[4]) : 300;
        if (matchup.size() != 3 || matchup[1] != 'v') {
            std::cout << "usage: antichess-selfplay <P1vP2> [games] [movetimeMs]  (P in {C,B,R,G})\n";
            return 1;
        }
        AcPlayerKind p1 = playerKind(matchup[0]);
        AcPlayerKind p2 = playerKind(matchup[2]);

        auto t0 = std::chrono::high_resolution_clock::now();
        AcMatchResult res = playMatch(p1, p2, games, movetimeMs);
        auto t1 = std::chrono::high_resolution_clock::now();
        double sec = std::chrono::duration<double>(t1 - t0).count();

        double p1Score = (res.p1Wins + 0.5 * res.draws) / double(res.games);
        std::cout << matchup << ": " << playerName(p1) << " " << res.p1Wins << "W " << res.draws << "D "
                  << res.p2Wins << "L vs " << playerName(p2) << "  (" << res.games << " games, "
                  << playerName(p1) << " score " << (p1Score * 100.0) << "%, Elo diff " << eloDiff(p1Score)
                  << ")\n";
        std::cout << "  (" << sec << "s wall, movetime=" << movetimeMs << "ms/move, colors alternated)\n";
        return 0;
    }

    Test tests[] = {
        {"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 6, 119060324ULL},
        {"r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1", 5, 193690690ULL},
        {"8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", 6, 11030083ULL},
        {"r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", 5, 15833292ULL},
        {"rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", 5, 89941194ULL},
        {"r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", 5, 164075551ULL},
    };

    bool allPass = true;
    for (auto& t : tests) {
        Position pos;
        pos.set(t.fen);
        auto start = std::chrono::high_resolution_clock::now();
        uint64_t got = perft(pos, t.depth);
        auto end = std::chrono::high_resolution_clock::now();
        double ms = std::chrono::duration<double, std::milli>(end - start).count();
        bool ok = got == t.expected;
        allPass &= ok;
        std::cout << (ok ? "PASS" : "FAIL")
                  << " depth " << t.depth
                  << " got " << got << " expected " << t.expected
                  << "  (" << (uint64_t)(got / (ms / 1000.0) / 1e6) << " Mnps)  "
                  << t.fen << "\n";
    }
    std::cout << (allPass ? "\nALL PERFT TESTS PASSED\n" : "\nSOME TESTS FAILED\n");
    return allPass ? 0 : 1;
}
