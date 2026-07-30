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
      src/rules.cpp src/rating.cpp src/weakening.cpp src/serve.cpp src/serve_handlers.cpp \
      src/sf_uci.cpp src/crazyhouse.cpp src/duck.cpp src/antichess.cpp src/book.cpp src/openings.cpp \
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

# nnue_web_format_test: proves the float32 and pre-quantized loaders produce a
# byte-identical Net + identical eval on golden FENs, and that a corrupted
# pre-quantized file is refused. See test/nnue_web_format_test.cpp.
nnue_web_format_test: test/nnue_web_format_test.cpp src/position.cpp src/bitboard.cpp \
       src/zobrist.cpp src/movegen.cpp src/rules.cpp src/weakening.cpp src/antichess.cpp \
       src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp src/nnue_accumulator.cpp
	$(CXX) $(CXXFLAGS) -Isrc -o test/nnue_web_format_test $^

clean:
	rm -f $(TARGET) perft_test $(OBJ) $(DEP) tools/netweb_writer test/nnue_web_format_test

-include $(DEP)

.PHONY: all clean perft netweb nnue_web_format_test
