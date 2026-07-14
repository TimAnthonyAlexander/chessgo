#pragma once
// UCI CLI entry point (src/uci.cpp), invoked by main.cpp when no `serve`
// subcommand is given. Kept as a plain function (not renamed to `main`) so
// main.cpp can dispatch between this and serve_main (src/serve.h).
int uci_main();
