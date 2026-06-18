// Command gomachine is the CLI for the gomachine chess engine. Subcommands:
//
//	gomachine uci                       UCI protocol loop (for chess GUIs)
//	gomachine serve [-addr] [-tt] [-w]  internal HTTP/JSON engine service
//	gomachine bestmove [-fen] [-level]  print the engine's move for a position
//	gomachine perft  [-fen] -depth N    perft / divide node counts
//	gomachine play   [-level] [-color]  play against the engine in the terminal
//	gomachine selfplay [-level] [-max]  watch the engine play itself
//
// See docs/SPEC.md.
package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "uci":
		cmdUCI()
	case "serve":
		cmdServe(os.Args[2:])
	case "hub":
		cmdHub(os.Args[2:])
	case "verifyticket":
		cmdVerifyTicket(os.Args[2:])
	case "bestmove":
		cmdBestMove(os.Args[2:])
	case "perft":
		cmdPerft(os.Args[2:])
	case "play":
		cmdPlay(os.Args[2:])
	case "selfplay":
		cmdSelfPlay(os.Args[2:])
	case "bench":
		cmdBench(os.Args[2:])
	case "tune":
		cmdTune(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `gomachine — a classical chess engine (SPEC docs/SPEC.md)

Usage:
  gomachine uci                          UCI protocol loop (for chess GUIs)
  gomachine serve [-addr 127.0.0.1:6466] [-tt 64] [-workers 4]
                                         internal HTTP/JSON engine service
  gomachine bestmove [-fen FEN] [-level 0..10] [-depth D] [-movetime ms]
  gomachine perft -depth N [-fen FEN] [-divide]
  gomachine play [-level 0..10] [-color white|black] [-fen FEN]
  gomachine selfplay [-level 0..10] [-max 200] [-movetime ms]
  gomachine bench sprt [-new SPEC] [-old SPEC] [-nodes N] ...
                                         in-process self-play SPRT (strength test)
`)
}
