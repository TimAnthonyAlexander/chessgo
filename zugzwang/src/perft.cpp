#include "position.h"
#include "movegen.h"
#include "bitboard.h"
#include "zobrist.h"
#include <iostream>
#include <chrono>
#include <vector>
#include <algorithm>

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
