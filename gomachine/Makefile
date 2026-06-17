# gomachine — build, test, and cross-compile targets. Pure Go, CGO disabled, so
# a single toolchain cross-compiles to every target (SPEC §3 cross-platform).

BIN      := bin/gomachine
PKG      := ./cmd/gomachine
GOFLAGS  := -trimpath
LDFLAGS  := -s -w

.PHONY: all build test test-short vet fmt perft bench clean cross

all: build

build:
	go build $(GOFLAGS) -o $(BIN) $(PKG)

test:
	go test ./...

test-short:
	go test -short ./...

vet:
	go vet ./...

fmt:
	gofmt -w internal cmd

# Quick perft sanity (startpos depth 5).
perft: build
	./$(BIN) perft -depth 5

bench:
	go test -bench . -benchmem ./...

clean:
	rm -rf bin

# Cross-compile release binaries for the deploy targets (Ubuntu + macOS).
cross:
	@mkdir -p dist
	CGO_ENABLED=0 GOOS=linux  GOARCH=amd64 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o dist/gomachine-linux-amd64  $(PKG)
	CGO_ENABLED=0 GOOS=linux  GOARCH=arm64 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o dist/gomachine-linux-arm64  $(PKG)
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o dist/gomachine-darwin-arm64 $(PKG)
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(GOFLAGS) -ldflags='$(LDFLAGS)' -o dist/gomachine-darwin-amd64 $(PKG)
	@echo "built: dist/"
