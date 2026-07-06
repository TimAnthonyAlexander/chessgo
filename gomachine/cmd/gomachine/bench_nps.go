package main

import (
	"flag"
	"fmt"
	"os"
	"runtime/pprof"
	"sort"
	"strconv"
	"strings"

	"github.com/timanthonyalexander/gomachine/internal/chess"
	"github.com/timanthonyalexander/gomachine/internal/nnue"
	"github.com/timanthonyalexander/gomachine/internal/search"
)

// cmdBenchNPS is a low-variance in-process NPS A/B: one process, net loaded once,
// a fixed position searched to a FIXED depth (deterministic node count), timed by
// the searcher's own Elapsed (no process-startup pollution). Configs are toggled
// in-process and INTERLEAVED every iteration so slow-box drift cancels; the median
// of N is reported. Node counts must match across configs (bit-exact gate).
func cmdBenchNPS(args []string) {
	fs := flag.NewFlagSet("nps", flag.ExitOnError)
	leanSpec := fs.String("lean", "data/nnue/v12.bin,512,8", "lean net: path,H,NB")
	depth := fs.Int("depth", 18, "fixed search depth (deterministic node count)")
	iters := fs.Int("iters", 12, "measured interleaved iterations per config")
	warmup := fs.Int("warmup", 2, "warmup iterations discarded")
	ttMB := fs.Int("tt", 64, "TT size MB")
	fenFlag := fs.String("fen", "r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 8", "position FEN")
	cpuprofile := fs.String("cpuprofile", "", "if set, write a CPU profile of the measured iterations to this file (analyze with: go tool pprof <file>)")
	baseOnly := fs.Bool("baseonly", false, "run only the prod(base) config (clean single-config profile)")
	fs.Parse(args)

	parts := strings.Split(*leanSpec, ",")
	if len(parts) != 3 {
		fmt.Fprintln(os.Stderr, "bad --lean spec (want path,H,NB)")
		os.Exit(2)
	}
	h, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
	nb, _ := strconv.Atoi(strings.TrimSpace(parts[2]))
	n, err := nnue.ImportBulletLeanNet(strings.TrimSpace(parts[0]), h, nb)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load net:", err)
		os.Exit(1)
	}
	n.QuantizeFTInt8()
	n.SetMoveAware(true)
	nnue.SetEnriched(n)

	pos, err := chess.ParseFEN(*fenFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parse fen:", err)
		os.Exit(1)
	}
	s := search.NewWithParams(*ttMB, search.DefaultParams())

	// A/B the three gated, bit-exact accumulator-push optimizations that ship OFF
	// in prod (loadDefaultLeanNet only enables moveAware+int8FT): directApply
	// (skip the counts multiset-diff), prefetch (SW-prefetch next weight column),
	// inPlace (copy-free single-accumulator push). All are node-count-identical, so
	// any NPS delta is a pure movetime win; a node mismatch => NOT bit-exact (WARN).
	type cfg struct {
		name               string
		da, pf, ip, ba, sr bool
	}
	cfgs := []cfg{
		{"prod(base)", false, false, false, false, false},
		{"prefetch", false, true, false, false, false},
		{"batchApply", false, false, false, true, false},
		{"batch+pf", false, true, false, true, false},
		{"directApply", true, false, false, false, false},
		{"splitRefresh", false, false, false, false, true},
	}
	if *baseOnly {
		cfgs = cfgs[:1]
	}

	run := func(c cfg) (uint64, float64) {
		n.SetDirectApply(c.da)
		n.SetPrefetchCols(c.pf)
		n.SetInPlace(c.ip)
		n.SetBatchApply(c.ba)
		n.SetSplitRefresh(c.sr)
		s.ClearTT()
		r := s.Search(pos, search.Limits{Depth: *depth}, nil)
		return r.Nodes, r.Elapsed.Seconds()
	}

	for w := 0; w < *warmup; w++ {
		for _, c := range cfgs {
			run(c)
		}
	}

	if *cpuprofile != "" {
		f, err := os.Create(*cpuprofile)
		if err != nil {
			fmt.Fprintln(os.Stderr, "create cpuprofile:", err)
			os.Exit(1)
		}
		defer f.Close()
		if err := pprof.StartCPUProfile(f); err != nil {
			fmt.Fprintln(os.Stderr, "start cpuprofile:", err)
			os.Exit(1)
		}
		defer pprof.StopCPUProfile()
	}

	npsList := map[string][]float64{}
	var nodesRef uint64
	for it := 0; it < *iters; it++ {
		for _, c := range cfgs {
			nodes, secs := run(c)
			if nodesRef == 0 {
				nodesRef = nodes
			}
			if nodes != nodesRef {
				fmt.Fprintf(os.Stderr, "WARN node mismatch %s: %d vs ref %d (NOT bit-exact)\n", c.name, nodes, nodesRef)
			}
			npsList[c.name] = append(npsList[c.name], float64(nodes)/secs)
		}
	}

	median := func(xs []float64) float64 {
		sort.Float64s(xs)
		return xs[len(xs)/2]
	}
	fmt.Printf("depth=%d nodes=%d iters=%d\n", *depth, nodesRef, *iters)
	base := median(npsList["prod(base)"])
	for _, c := range cfgs {
		m := median(npsList[c.name])
		fmt.Printf("%-12s medianNPS=%.0f  ratio=%.4f\n", c.name, m, m/base)
	}
}
