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
      src/sf_uci.cpp src/crazyhouse.cpp src/duck.cpp src/book.cpp src/openings.cpp \
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

perft: src/perft.cpp src/position.cpp src/bitboard.cpp src/zobrist.cpp src/movegen.cpp
	$(CXX) $(CXXFLAGS) -o perft_test $^

clean:
	rm -f $(TARGET) perft_test $(OBJ) $(DEP)

-include $(DEP)

.PHONY: all clean perft
