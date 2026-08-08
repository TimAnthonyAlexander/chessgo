// Movegen + rules gate for the Secret Queen variant (src/secretqueen.{h,cpp}).
//
// The load-bearing test is the DUCK CROSS-CHECK. Secret Queen and Duck Chess
// share their entire non-hidden ruleset — no check, no pins, no self-check
// filter, king captures generated, castling without a through-check condition —
// and differ only in that Duck has a duck and Secret Queen has no en passant.
// So with no duck placed, no hidden queens, and en-passant moves filtered out of
// Duck's list, the two generators must agree move for move on any position. That
// checks this module against an independently written, already-shipped
// implementation rather than against itself.
//
// Everything the cross-check cannot see — the hidden queen's extra moves, the
// reveal rules, redaction, the repetition key — is asserted directly below it.
#include "../src/secretqueen.h"
#include "../src/duck.h"
#include "../src/bitboard.h"
#include "../src/zobrist.h"

#include <cstdio>
#include <set>
#include <string>
#include <vector>

namespace {

int failures = 0;

void check(bool ok, const std::string& what) {
    if (!ok) {
        std::printf("  FAIL: %s\n", what.c_str());
        failures++;
    }
}

void check_eq(uint64_t got, uint64_t want, const std::string& what) {
    if (got != want) {
        std::printf("  FAIL: %s — got %llu, want %llu\n", what.c_str(), (unsigned long long)got,
                    (unsigned long long)want);
        failures++;
    }
}

void check_eq(SecretQueenStatus got, SecretQueenStatus want, const std::string& what) {
    if (got != want) {
        std::printf("  FAIL: %s — got %s, want %s\n", what.c_str(), secretqueen_status_name(got).c_str(),
                    secretqueen_status_name(want).c_str());
        failures++;
    }
}

SecretQueenState parse_or_die(const std::string& fen) {
    SecretQueenState s;
    std::string err;
    if (!secretqueen_parse(fen, s, err)) {
        std::printf("  FAIL: parse(%s): %s\n", fen.c_str(), err.c_str());
        failures++;
    }
    return s;
}

SecretQueenMove find_or_die(const SecretQueenState& s, const std::string& uci) {
    SecretQueenMove want, got;
    if (!secretqueen_parse_uci(uci, want) || !secretqueen_find_legal(s, want, got)) {
        std::printf("  FAIL: expected %s to be legal\n", uci.c_str());
        failures++;
        return SecretQueenMove{};
    }
    return got;
}

SecretQueenState play(const SecretQueenState& s, const std::string& uci, SecretQueenReveal& reveal,
                      bool& capturedKing) {
    SecretQueenMove m = find_or_die(s, uci);
    return secretqueen_do_move(s, m, capturedKing, reveal);
}

SecretQueenState play(const SecretQueenState& s, const std::string& uci) {
    SecretQueenReveal reveal;
    bool capturedKing = false;
    return play(s, uci, reveal, capturedKing);
}

// ==================== the duck cross-check ====================

const char* CROSS_FENS[] = {
    // Standard start.
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    // Kiwipete — every castling right, pins, a rich middlegame.
    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    // Position 3 — a sparse endgame with pawn races.
    "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    // Position 4 (and its mirror) — promotions and an awkward king.
    "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1",
    // Position 5 — no castling, dense.
    "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    // A live en-passant target, the one rule the two variants genuinely differ on.
    "rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3",
    // Black to move with an ep target of its own.
    "rnbqkbnr/pp1ppppp/8/8/2pP4/5N2/PPP1PPPP/RNBQKB1R b KQkq d3 0 3",
    // A king sitting next to an enemy king — illegal in chess, normal here.
    "8/8/8/3kK3/8/8/8/8 w - - 0 1",
    // A king already capturable, i.e. "in check" in chess terms.
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3",
};

// Duck's moves with the en-passant ones removed — the exact set Secret Queen
// should produce (Duck with no duck placed is otherwise the same ruleset).
std::set<std::string> duck_moves_without_ep(const std::string& fen) {
    DuckState ds;
    std::string err;
    if (!duck_parse(fen, "", ds, err)) {
        std::printf("  FAIL: duck_parse(%s): %s\n", fen.c_str(), err.c_str());
        failures++;
        return {};
    }
    std::set<std::string> out;
    for (const DuckPieceMove& m : duck_legal_piece_moves(ds)) {
        if (m.ep) continue;
        out.insert(m.uci());
    }
    return out;
}

std::set<std::string> secretqueen_move_set(const SecretQueenState& s) {
    std::set<std::string> out;
    for (const std::string& u : secretqueen_legal_moves(s)) out.insert(u);
    return out;
}

void test_duck_cross_check() {
    std::printf("duck cross-check (no duck, no secrets, ep filtered)\n");
    for (const char* fen : CROSS_FENS) {
        SecretQueenState s = parse_or_die(fen);
        std::set<std::string> want = duck_moves_without_ep(fen);
        std::set<std::string> got = secretqueen_move_set(s);

        // A duplicate move would be invisible to a set comparison, and the
        // hidden queen's generator is exactly where one could creep in.
        std::vector<std::string> raw = secretqueen_legal_moves(s);
        check_eq(raw.size(), got.size(), std::string("no duplicate moves: ") + fen);

        if (got != want) {
            std::printf("  FAIL: move sets differ for %s\n", fen);
            for (const std::string& u : want)
                if (!got.count(u)) std::printf("    missing: %s\n", u.c_str());
            for (const std::string& u : got)
                if (!want.count(u)) std::printf("    extra:   %s\n", u.c_str());
            failures++;
        }
    }
}

// ==================== hidden-queen movegen ====================

void test_hidden_queen_moves() {
    std::printf("hidden queen movegen\n");

    // No secrets: the ordinary 20 opening moves.
    SecretQueenState plain = parse_or_die(SECRETQUEEN_START_FEN);
    check_eq(secretqueen_legal_moves(plain).size(), 20, "start position, no secrets, has 20 moves");

    // White's secret queen on e2. A queen there reaches e3 e4 e5 e6 e7 (the file,
    // stopping on Black's e7 pawn), d3 c4 b5 a6 (one diagonal) and f3 g4 h5 (the
    // other) — 12 squares. e3 and e4 are already pawn pushes, so 10 are new.
    SecretQueenState s = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|-]");
    check_eq(s.secret[WHITE], E2, "secret parsed");
    check_eq(s.secret[BLACK], SQ_NONE, "black has no secret");
    check_eq(secretqueen_legal_moves(s).size(), 30, "start position + secret queen on e2 has 30 moves");

    std::set<std::string> moves = secretqueen_move_set(s);
    check(moves.count("e2e4") == 1, "the pawn double push is still there");
    check(moves.count("e2a6") == 1, "the queen's long diagonal is generated");
    check(moves.count("e2e7") == 1, "the queen may capture down the file");
    check(moves.count("e2e8") == 0, "the queen cannot jump the pawn it just captured on e7");
    check(moves.count("e2d2") == 0, "own pawn still blocks the queen");

    // The opponent sees none of this: Black's generator treats e2 as a pawn.
    SecretQueenState blackToMove = play(s, "a2a3");
    check_eq(blackToMove.secret[WHITE], E2, "white's secret survives an unrelated move");
    check_eq(secretqueen_legal_moves(blackToMove).size(), 20, "Black's own move list is untouched by it");
}

void test_no_en_passant() {
    std::printf("no en passant\n");
    // White has just played d2d4 past a black pawn on c4; chess would allow c4xd3.
    SecretQueenState s = parse_or_die("rnbqkbnr/pp1ppppp/8/8/2pP4/5N2/PPP1PPPP/RNBQKB1R b KQkq d3 0 3");
    std::set<std::string> moves = secretqueen_move_set(s);
    check(moves.count("c4d3") == 0, "the en-passant capture is not generated");
    check(moves.count("c4c3") == 1, "the ordinary push still is");

    // And the ep field never survives a round trip through the FEN.
    check(s.fen().find(" - 0 3") != std::string::npos, "parsed ep target is discarded");

    // A double push does not set one either.
    SecretQueenState after = play(parse_or_die(SECRETQUEEN_START_FEN), "e2e4");
    check(after.boardFen().find("KQkq - ") != std::string::npos, "a double push sets no ep target");
}

// ==================== reveal ====================

void test_reveal_on_queen_move() {
    std::printf("reveal: a move no pawn could make\n");
    SecretQueenState s = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|-]");

    // A pawn-shaped move keeps the disguise and carries the secret along.
    SecretQueenReveal reveal;
    bool capturedKing = false;
    SecretQueenState hidden = play(s, "e2e4", reveal, capturedKing);
    check(!reveal.moved && !reveal.captured && !reveal.promoted, "a pawn move reveals nothing");
    check_eq(hidden.secret[WHITE], E4, "the secret follows the pawn to e4");
    check_eq(hidden.board[E4], W_PAWN, "and the board still shows a pawn");

    // A queen-only move unmasks it, and it becomes a real queen.
    SecretQueenState shown = play(s, "e2a6", reveal, capturedKing);
    check(reveal.moved, "a queen move reveals");
    check_eq(shown.secret[WHITE], SQ_NONE, "the hidden state is spent");
    check_eq(shown.board[A6], W_QUEEN, "a real queen stands on a6");
    check(shown.fen().find("[-|-]") != std::string::npos, "and the FEN names no secret");

    // is_pawn_shaped is the reveal test; check it directly on both.
    check(secretqueen_is_pawn_shaped(s, find_or_die(s, "e2e4")), "e2e4 is pawn-shaped");
    check(!secretqueen_is_pawn_shaped(s, find_or_die(s, "e2a6")), "e2a6 is not");
    check(!secretqueen_is_pawn_shaped(s, find_or_die(s, "e2e7")), "e2e7 is not (a pawn cannot reach e7)");
}

void test_reveal_on_capture() {
    std::printf("reveal: captured while disguised\n");
    // Black's secret queen sits on d5; White's pawn on e4 can take it.
    SecretQueenState s = parse_or_die("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2 [-|d5]");
    SecretQueenReveal reveal;
    bool capturedKing = false;
    SecretQueenState after = play(s, "e4d5", reveal, capturedKing);
    check(reveal.captured, "taking it reports the capture of a disguised queen");
    check_eq(reveal.square, D5, "on the square it died");
    check_eq(after.secret[BLACK], SQ_NONE, "black's secret is gone");
    check(!capturedKing, "no king was captured");
}

void test_reveal_on_promotion() {
    std::printf("reveal: promotion\n");
    // White's secret queen has walked to b7 and can promote on b8 or take on a8.
    SecretQueenState s = parse_or_die("r6k/1P6/8/8/8/8/8/K7 w - - 0 1 [b7|-]");
    SecretQueenReveal reveal;
    bool capturedKing = false;

    SecretQueenState pushed = play(s, "b7b8q", reveal, capturedKing);
    check(reveal.promoted, "reaching the last rank reveals it");
    check_eq(pushed.board[B8], W_QUEEN, "it lands as a queen");
    check_eq(pushed.secret[WHITE], SQ_NONE, "and is no longer hidden");

    // It was already a queen, so an under-promotion suffix cannot demote it.
    SecretQueenState knighted = play(s, "b7b8n", reveal, capturedKing);
    check_eq(knighted.board[B8], W_QUEEN, "an under-promotion suffix still leaves a queen");

    // Capturing into the promotion square works the same way.
    SecretQueenState took = play(s, "b7a8q", reveal, capturedKing);
    check_eq(took.board[A8], W_QUEEN, "promotion by capture also lands a queen");
}

// ==================== the ambush ====================

void test_ambush() {
    std::printf("the ambush: a king walks onto a hidden queen\n");
    // Black's king on e8 may step to d7; White's hidden queen on a4 covers it
    // along the a4-e8 diagonal. Black's generator cannot see that, so the move
    // is offered — and White may then take the king and win.
    SecretQueenState s = parse_or_die("4k3/8/8/8/P7/8/8/4K3 b - - 0 1 [a4|-]");
    std::set<std::string> blackMoves = secretqueen_move_set(s);
    check(blackMoves.count("e8d7") == 1, "Black is allowed to walk into it");

    SecretQueenState walked = play(s, "e8d7");
    check_eq(secretqueen_status(walked), SecretQueenStatus::Ongoing, "no check concept, so the game goes on");

    std::set<std::string> whiteMoves = secretqueen_move_set(walked);
    check(whiteMoves.count("a4d7") == 1, "the hidden queen can take the king");

    SecretQueenReveal reveal;
    bool capturedKing = false;
    SecretQueenState taken = play(walked, "a4d7", reveal, capturedKing);
    check(capturedKing, "the king is captured");
    check(reveal.moved, "and the queen is unmasked doing it");
    check_eq(secretqueen_status(taken), SecretQueenStatus::WhiteWin, "White wins on the spot");
    check(secretqueen_king_captured(taken), "king_captured agrees");
}

// ==================== redaction ====================

void test_redaction() {
    std::printf("redaction\n");
    SecretQueenState s = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|h7]");

    std::string white = s.fenFor(WHITE);
    std::string black = s.fenFor(BLACK);
    std::string board = s.boardFen();

    check(white.find("[e2|-]") != std::string::npos, "White sees only their own secret");
    check(white.find("h7") == std::string::npos, "White is told nothing about Black's");
    check(black.find("[-|h7]") != std::string::npos, "Black sees only their own");
    check(black.find("e2") == std::string::npos, "and nothing about White's");
    check(board.find('[') == std::string::npos, "the spectator board FEN names no secret at all");

    // The decisive property: redaction is subtractive. The board itself never
    // encodes a hidden queen, so a stripped FEN cannot leak one — there is a
    // plain pawn on e2 in every view, including the server's own.
    check(s.board[E2] == W_PAWN && s.board[H7] == B_PAWN, "hidden queens are pawns on the board");
    for (const std::string& f : {white, black, board}) {
        SecretQueenState round;
        std::string err;
        check(secretqueen_parse(f, round, err), "every redacted view re-parses: " + f);
        check_eq(round.board[E2], W_PAWN, "e2 is a pawn in the redacted view");
        check_eq(round.board[H7], B_PAWN, "h7 is a pawn in the redacted view");
    }
}

void test_repetition_key() {
    std::printf("repetition key\n");
    SecretQueenState a = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|-]");
    SecretQueenState b = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [d2|-]");
    SecretQueenState c = parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
    check(a.key() != b.key(), "a different secret is a different position");
    check(a.key() != c.key(), "having a secret differs from having none");

    // Threefold still works: shuffle knights back and forth.
    std::vector<uint64_t> history;
    SecretQueenState s = c;
    for (int i = 0; i < 2; ++i) {
        history.push_back(s.key());
        s = play(s, "g1f3");
        history.push_back(s.key());
        s = play(s, "g8f6");
        history.push_back(s.key());
        s = play(s, "f3g1");
        history.push_back(s.key());
        s = play(s, "f6g8");
    }
    check_eq(secretqueen_status(s, history), SecretQueenStatus::Draw, "threefold repetition draws");
}

void test_fifty_move() {
    std::printf("fifty-move rule\n");
    SecretQueenState s = parse_or_die("4k3/8/8/8/8/8/8/R3K3 w - - 99 60");
    check_eq(secretqueen_status(s), SecretQueenStatus::Ongoing, "at 99 half-moves the game is live");
    SecretQueenState after = play(s, "a1a2");
    check_eq(after.halfmove, 100, "a quiet move takes it to 100");
    check_eq(secretqueen_status(after), SecretQueenStatus::Draw, "which draws");

    // A hidden queen's QUEEN move is reversible and must not reset the clock;
    // its pawn moves must.
    SecretQueenState q = parse_or_die("4k3/8/8/8/8/8/4P3/4K3 w - - 40 60 [e2|-]");
    check_eq(play(q, "e2a6").halfmove, 41, "a queen move by the hidden queen does not reset the clock");
    check_eq(play(q, "e2e3").halfmove, 0, "a pawn move does");
}

// Duck's perft over the same ruleset: no duck placed, en-passant moves filtered
// out. Uses Duck's own movegen AND its own apply, so comparing node counts
// against secretqueen_perft cross-checks both halves of this module at a scale
// no hand-written expectation reaches.
uint64_t duck_perft_no_ep(const DuckState& s, int depth) {
    if (depth <= 0) return 1;
    uint64_t nodes = 0;
    for (const DuckPieceMove& m : duck_legal_piece_moves(s)) {
        if (m.ep) continue;
        if (depth == 1) {
            nodes++;
            continue;
        }
        bool capturedKing = false;
        DuckState ns = duck_make_move(s, m, SQ_NONE, capturedKing);
        nodes += duck_perft_no_ep(ns, depth - 1);
    }
    return nodes;
}

void test_perft() {
    std::printf("perft\n");
    SecretQueenState plain = parse_or_die(SECRETQUEEN_START_FEN);

    // Depths 1 and 2 are hand-checkable: the 20 opening moves, each answered by
    // 20. No check, ep or king-capture divergence is reachable that shallow.
    check_eq(secretqueen_perft(plain, 1), 20, "perft(1) from the start");
    check_eq(secretqueen_perft(plain, 2), 400, "perft(2) from the start");
    check_eq(secretqueen_perft(plain, 3), 8902, "perft(3) from the start");

    // At depth 4 the count DIVERGES from standard chess's 197281, and it should:
    // the first check is reachable at ply 3, and this variant has no check, so
    // the side to move may ignore it (and may capture the king outright). Those
    // continuations are illegal in chess and legal here. Rather than bless a
    // number this implementation produced, the expectation comes from Duck's
    // independent generator over the same ruleset.
    DuckState duckStart;
    std::string err;
    check(duck_parse(DUCK_START_FEN, "", duckStart, err), "duck start parses");
    for (int d = 1; d <= 4; ++d) {
        check_eq(secretqueen_perft(plain, d), duck_perft_no_ep(duckStart, d),
                 "perft(" + std::to_string(d) + ") matches duck's generator");
    }
    check_eq(secretqueen_perft(plain, 4), 197742, "perft(4) from the start (recorded; 461 over chess's 197281)");

    SecretQueenState withSecret =
        parse_or_die("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 [e2|e7]");
    check_eq(secretqueen_perft(withSecret, 1), 30, "perft(1) with both secrets set");
}

} // namespace

int main() {
    BB::init();
    Zobrist::init();

    test_duck_cross_check();
    test_hidden_queen_moves();
    test_no_en_passant();
    test_reveal_on_queen_move();
    test_reveal_on_capture();
    test_reveal_on_promotion();
    test_ambush();
    test_redaction();
    test_repetition_key();
    test_fifty_move();
    test_perft();

    if (failures) {
        std::printf("\n%d FAILURE(S)\n", failures);
        return 1;
    }
    std::printf("\nall secret queen checks passed\n");
    return 0;
}
