CXX      ?= clang++
CXXFLAGS ?= -std=c++17 -O3 -flto=auto -DNDEBUG -Wall -Wno-unused -ffp-contract=off -Isrc/syzygy
LDFLAGS  ?= -flto=auto -pthread
TARGET    = zugzwang

# Cores for the LTO link (-flto=auto) and, when -j is passed, the compile fan-out.
NPROC := $(shell nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)

SRC = src/main.cpp src/uci.cpp src/search.cpp src/eval.cpp src/position.cpp \
      src/bitboard.cpp src/zobrist.cpp src/movegen.cpp src/tt.cpp \
      src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp \
      src/nnue_accumulator.cpp \
      src/rules.cpp src/rating.cpp src/weakening.cpp src/ratingtest.cpp \
      src/serve.cpp src/serve_handlers.cpp \
      src/sf_uci.cpp src/crazyhouse.cpp src/duck.cpp src/antichess.cpp \
      src/secretqueen.cpp src/secretqueen_bot.cpp \
      src/book.cpp src/openings.cpp \
      src/zug_tb.cpp src/syzygy/tbprobe.cpp
OBJ = $(SRC:.cpp=.o)
DEP = $(OBJ:.o=.d)

# ASSERT=1 compiles the incremental-accumulator bit-exactness check: every in-search
# eval rebuilds the halves from scratch and aborts on any int16 drift. Slow — gate only.
ifeq ($(ASSERT),1)
  CXXFLAGS += -DNNUE_ASSERT
endif

# Native optimization (arch-detected: Apple Silicon uses -mcpu, x86 uses -march)
ifeq ($(shell uname -m),x86_64)
  CXXFLAGS += -march=native
else
  CXXFLAGS += -mcpu=native
endif

all: $(TARGET)

# Per-object compilation so `make -j` fans the 22 TUs across cores; -MMD -MP tracks
# header deps so incremental (no `make clean`) rebuilds only what changed. The link
# step re-runs whole-program LTO — -flto=auto parallelizes its LTRANS jobs.
$(TARGET): $(OBJ)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(OBJ)

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -MMD -MP -c $< -o $@

perft: src/perft.cpp src/position.cpp src/bitboard.cpp src/zobrist.cpp src/movegen.cpp \
       src/rules.cpp src/weakening.cpp src/antichess.cpp \
       src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp
	$(CXX) $(CXXFLAGS) -o perft_test $^

# netweb_writer: converts the float32 net (net.nnue) into the pre-quantized web
# format (src/nnue_web_format.h). Standalone — only needs the loader, not the
# engine — so it does not disturb the main build. See tools/netweb_writer.cpp.
#   Usage: ./tools/netweb_writer <input-float32-net> <output-prequantized-net>
netweb: tools/netweb_writer.cpp src/nnue_net.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o tools/netweb_writer $^

# book_export: BFS-walks from the start position + gomachine's opening suites,
# probing book.bin (keys-only, no FENs stored) at each node to recover the
# FEN for every reachable book entry. Standalone tool for the eval_cache bulk
# import (scripts/import_book_evals.php). See tools/book_export.cpp.
#   Usage: ./tools/book_export [--book=book.bin] [--max-ply=40] [--max-nodes=N] [-o out.tsv] [seed.epd ...]
book_export: tools/book_export.cpp src/book.cpp src/position.cpp src/bitboard.cpp \
       src/zobrist.cpp src/movegen.cpp src/rules.cpp src/weakening.cpp src/antichess.cpp \
       src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o tools/book_export $^

# tbdefend: perfect Syzygy DTZ oracle — the opponent AND the judge for the
# tablebase-conversion suite (test/tb_conversion.py). Fathom's root probe
# returns the DTZ-maximizing move for a losing side (the hardest 50-move-rule
# stalling defence) and a WDL that already accounts for the halfmove clock.
# Standalone: rules only, no search, no serve. See tools/tbdefend.cpp.
#   Usage: ./tools/tbdefend [--path syzygy] [FEN ...]   (else reads FENs on stdin)
tbdefend: tools/tbdefend.cpp src/position.cpp src/bitboard.cpp \
       src/zobrist.cpp src/movegen.cpp src/rules.cpp src/weakening.cpp src/antichess.cpp \
       src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp \
       src/syzygy/tbprobe.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o tools/tbdefend $^

# nnue_web_format_test: proves the float32 and pre-quantized loaders produce a
# byte-identical Net + identical eval on golden FENs, and that a corrupted
# pre-quantized file is refused. See test/nnue_web_format_test.cpp.
nnue_web_format_test: test/nnue_web_format_test.cpp src/position.cpp src/bitboard.cpp \
       src/zobrist.cpp src/movegen.cpp src/rules.cpp src/weakening.cpp src/antichess.cpp \
       src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o test/nnue_web_format_test $^

# secretqueen_test: the Secret Queen rules/movegen gate. Cross-checks this
# module's generator AND its apply against Duck's independent implementation of
# the same no-check/king-capture ruleset (perft to depth 4), then asserts the
# hidden-queen rules the cross-check cannot see — reveal, redaction, the ambush.
# Deliberately net-free: test/secretqueen_test_stubs.cpp stubs the NNUE
# accumulator and the clock so this stays a pure rules test.
#   Usage: make secretqueen_test && ./test/secretqueen_test
secretqueen_test: test/secretqueen_test.cpp test/secretqueen_test_stubs.cpp src/secretqueen.cpp \
       src/duck.cpp src/bitboard.cpp src/zobrist.cpp src/rules.cpp src/position.cpp \
       src/movegen.cpp src/weakening.cpp
	$(CXX) $(CXXFLAGS) -o test/secretqueen_test $^

# sfnet_load_test: Wave 1 gate for the SF-net experiment backend — the C++ loader must
# agree array for array with tools/sfnet_parse.py, and must REFUSE the small net and a
# truncated file. Standalone: the loader has no engine dependencies at all.
#   Usage: make sfnet_load_test && ./test/sfnet_load_test <big.nnue> [small.nnue]
sfnet_load_test: test/sfnet_load_test.cpp src/sfnet_load.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o test/sfnet_load_test $^

# sfnet_eval_test: Wave 2 gate for the SF-net experiment backend — builds and runs the
# from-scratch (no incremental accumulator, no SIMD) forward pass over a FEN corpus.
# Reuses NNUE::active_features() (src/nnue_features.cpp) for the threat half, which is
# why this pulls in the same link set as nnue_web_format_test rather than the loader
# test's standalone two files.
#   Usage: make sfnet_eval_test && ./test/sfnet_eval_test [--self-check] <net.nnue> <fens.epd>
sfnet_eval_test: test/sfnet_eval_test.cpp src/sfnet_load.cpp src/sfnet_eval.cpp \
       src/position.cpp src/bitboard.cpp src/zobrist.cpp src/movegen.cpp src/rules.cpp \
       src/weakening.cpp src/antichess.cpp src/nnue_net.cpp src/nnue_features.cpp \
       src/nnue_eval.cpp src/nnue_accumulator.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o test/sfnet_eval_test $^

clean:
	rm -f $(TARGET) perft_test $(OBJ) $(DEP) tools/netweb_writer test/nnue_web_format_test \
	      test/secretqueen_test tools/book_export tools/tbdefend test/sfnet_load_test \
	      test/sfnet_eval_test

-include $(DEP)

.PHONY: all clean perft netweb nnue_web_format_test secretqueen_test book_export tbdefend \
        sfnet_load_test sfnet_eval_test
