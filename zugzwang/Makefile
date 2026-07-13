CXX      ?= clang++
CXXFLAGS ?= -std=c++17 -O3 -flto -DNDEBUG -Wall -Wno-unused
LDFLAGS  ?= -flto -pthread
TARGET    = zugzwang

SRC = src/uci.cpp src/search.cpp src/eval.cpp src/position.cpp \
      src/bitboard.cpp src/zobrist.cpp src/movegen.cpp src/tt.cpp \
      src/nnue_net.cpp src/nnue_features.cpp src/nnue_eval.cpp
OBJ = $(SRC:.cpp=.o)

# Native optimization (Apple Silicon)
CXXFLAGS += -mcpu=native

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(SRC)

perft: src/perft.cpp src/position.cpp src/bitboard.cpp src/zobrist.cpp src/movegen.cpp
	$(CXX) $(CXXFLAGS) -o perft_test $^

clean:
	rm -f $(TARGET) perft_test $(OBJ)

.PHONY: all clean perft
