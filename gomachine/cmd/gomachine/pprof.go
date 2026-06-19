package main

import (
	"fmt"
	"net/http"
	_ "net/http/pprof" // registers /debug/pprof/* on http.DefaultServeMux
	"os"
)

// startPprof launches a profiling HTTP server on addr (e.g. "127.0.0.1:6480")
// in the background, if addr is non-empty. It serves Go's net/http/pprof on its
// OWN listener and mux (the default mux), kept separate from the engine/hub
// service handlers so profiling is opt-in and never exposed on the service port.
//
// Once running:
//
//	go tool pprof   http://127.0.0.1:6480/debug/pprof/profile?seconds=30   # CPU
//	go tool pprof   http://127.0.0.1:6480/debug/pprof/heap                  # heap
//	curl            http://127.0.0.1:6480/debug/pprof/goroutine?debug=1     # goroutines
func startPprof(addr string) {
	if addr == "" {
		return
	}
	go func() {
		fmt.Fprintf(os.Stderr, "pprof listening on http://%s/debug/pprof/\n", addr)
		if err := http.ListenAndServe(addr, nil); err != nil {
			fmt.Fprintln(os.Stderr, "pprof server error:", err)
		}
	}()
}
