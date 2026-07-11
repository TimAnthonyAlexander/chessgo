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

// cmdBenchNPSFT answers ONE question: does deploying the 79,856-column threat FT as
// int16 (zero quantisation loss) instead of int8 cost enough NPS to matter? Only the
// ~70 columns TOUCHED per accumulator push are scattered — the table size is irrelevant
// to the traffic — so int16 (2 bytes/elem) vs int8 (1 byte/elem) is a per-push memory-
// bandwidth question, and if it is <2% NPS we deploy int16 and delete the clamp problem.
//
// Both configs hold the prod push stack (tail int8, moveAware, splitRefresh, directApply,
// finny) IDENTICAL; only the threat-FT precision differs (QuantizeFTInt8 on config B).
// int16 and int8 evals differ slightly, so the two searches diverge — node counts will
// NOT match (unlike the bit-exact push-opt A/B). NPS (nodes/sec) is the throughput metric;
// interleaving cancels box drift; the median of N iters is reported per config.
//
// MUST run on the deploy arch (amd64 SIMD, coalla/lairner) — arm64 scatter ratios do not
// transfer. Load the enriched full-threats net via --net path,H,D2,D3,NB (or KB_NET_PATH).
func cmdBenchNPSFT(args []string) {
	fs := flag.NewFlagSet("nps-ft", flag.ExitOnError)
	netSpec := fs.String("net", "", "enriched net: path,H,D2,D3,NB (default: KB_NET_PATH,512,16,32,8)")
	depth := fs.Int("depth", 18, "fixed search depth")
	iters := fs.Int("iters", 12, "measured interleaved iterations per config")
	warmup := fs.Int("warmup", 2, "warmup iterations discarded")
	ttMB := fs.Int("tt", 64, "TT size MB")
	fenFlag := fs.String("fen", "r1bqk2r/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP3PPP/RN1QK2R w KQkq - 0 8", "position FEN")
	cpuprofile := fs.String("cpuprofile", "", "if set, write a Go CPU profile of the measured iterations to this file. Forces int16 (prod) config ONLY, so the profile is a clean prod-config capture (analyze with: go tool pprof <file>)")
	fs.Parse(args)

	path, h, d2, d3, nb := "", 512, 16, 32, 8
	if *netSpec != "" {
		p := strings.Split(*netSpec, ",")
		if len(p) != 5 {
			fmt.Fprintln(os.Stderr, "bad --net spec (want path,H,D2,D3,NB)")
			os.Exit(2)
		}
		path = strings.TrimSpace(p[0])
		h, _ = strconv.Atoi(strings.TrimSpace(p[1]))
		d2, _ = strconv.Atoi(strings.TrimSpace(p[2]))
		d3, _ = strconv.Atoi(strings.TrimSpace(p[3]))
		nb, _ = strconv.Atoi(strings.TrimSpace(p[4]))
	} else {
		path = os.Getenv("KB_NET_PATH")
	}
	if path == "" {
		fmt.Fprintln(os.Stderr, "no net: pass --net or set KB_NET_PATH")
		os.Exit(2)
	}

	// Load TWO instances — QuantizeFTInt8 is a one-way mutation, so config B gets its own.
	load := func(int8FT bool) *nnue.EnrichedNet {
		n, err := nnue.ImportBulletEnrichedNet(path, h, d2, d3, nb)
		if err != nil {
			fmt.Fprintln(os.Stderr, "load net:", err)
			os.Exit(1)
		}
		if n.IsLean() {
			fmt.Fprintln(os.Stderr, "net imported as LEAN — expected the multilayer full-threats net")
			os.Exit(1)
		}
		n.QuantizeForInt8() // int8 tail L1 — same in both configs (prod)
		if int8FT {
			c := n.QuantizeFTInt8()
			fmt.Fprintf(os.Stderr, "int8 threat FT: %d weights clamped\n", c)
		}
		// prod push stack, identical in both:
		n.SetMoveAware(true)
		n.SetSplitRefresh(true)
		n.SetDirectApply(true)
		n.SetFinny(true)
		return n
	}
	net16 := load(false)
	net8 := load(true)

	pos, err := chess.ParseFEN(*fenFlag)
	if err != nil {
		fmt.Fprintln(os.Stderr, "parse fen:", err)
		os.Exit(1)
	}
	s := search.NewWithParams(*ttMB, search.DefaultParams())

	type cfg struct {
		name string
		net  *nnue.EnrichedNet
	}
	cfgs := []cfg{{"int16-threatFT", net16}, {"int8-threatFT", net8}}
	// A cpuprofile capture must be a single clean config (pprof profiles the whole
	// process), so force int16 = the prod full-threats config only.
	if *cpuprofile != "" {
		cfgs = cfgs[:1]
	}

	run := func(c cfg) (uint64, float64) {
		nnue.SetEnriched(c.net)
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
	nodes := map[string]uint64{}
	for it := 0; it < *iters; it++ {
		for _, c := range cfgs {
			nd, secs := run(c)
			nodes[c.name] = nd
			npsList[c.name] = append(npsList[c.name], float64(nd)/secs)
		}
	}

	median := func(xs []float64) float64 {
		sort.Float64s(xs)
		return xs[len(xs)/2]
	}
	fmt.Printf("depth=%d iters=%d fen=%q\n", *depth, *iters, *fenFlag)
	base := median(npsList["int16-threatFT"])
	for _, c := range cfgs {
		m := median(npsList[c.name])
		fmt.Printf("%-16s medianNPS=%.0f  nodes=%d  ratio=%.4f\n", c.name, m, nodes[c.name], m/base)
	}
	fmt.Printf("\nint8/int16 NPS ratio = %.4f  (int16 costs %.2f%% vs int8; <2%% => deploy int16, zero threat-FT quant loss)\n",
		median(npsList["int8-threatFT"])/base, (1.0-base/median(npsList["int8-threatFT"]))*100)
}
