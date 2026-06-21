package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/timanthonyalexander/gomachine/internal/nnue"
)

// cmdNNUEImportBullet converts a bullet-trained `quantised.bin` checkpoint into
// our GNN1 net format. See internal/nnue/bulletimport.go for the format mapping
// (identity feature permutation, stm-first concat, CpScale=400). The verification
// that our Eval reproduces bullet's own cp is in cmd/gomachine/nnueimportbullet
// + the bullet-side Rust helper (/tmp/bullet) — see the import command report.
func cmdNNUEImportBullet(args []string) {
	fs := flag.NewFlagSet("nnue-import-bullet", flag.ExitOnError)
	in := fs.String("in", "", "bullet quantised.bin checkpoint to import")
	out := fs.String("out", "", "output net path (GNN1, e.g. data/nnue/net.nnue)")
	_ = fs.Parse(args)

	if *in == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "nnue-import-bullet: --in and --out are required")
		os.Exit(2)
	}

	net, err := nnue.ImportBulletNet(*in)
	if err != nil {
		fmt.Fprintln(os.Stderr, "nnue-import-bullet:", err)
		os.Exit(1)
	}

	if err := net.Save(*out); err != nil {
		fmt.Fprintln(os.Stderr, "nnue-import-bullet: save:", err)
		os.Exit(1)
	}

	fmt.Printf("imported bullet net %s -> %s (768x%d x2 -> 1, CpScale=%.0f)\n",
		*in, *out, nnue.L1, net.CpScale)
}
