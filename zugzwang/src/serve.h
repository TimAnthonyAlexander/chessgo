#pragma once
// HTTP `serve` subcommand entry point (src/serve.cpp): mirrors gomachine's
// stateless internal/server API (WIRING_RECON.md §A) over cpp-httplib +
// nlohmann/json so the chessgo website can call zugzwang exactly like it
// calls gomachine. `argv` is the full process argv (argv[1] == "serve");
// serve.cpp parses its own flags (-addr) starting from argv[2].
int serve_main(int argc, char** argv);
