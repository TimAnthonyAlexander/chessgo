# Optional: PHP_CLI_SERVER_WORKERS for local concurrency

**What.** Set `PHP_CLI_SERVER_WORKERS` when running the dev BaseAPI server
(`./mason serve`) so the built-in PHP CLI server handles concurrent requests.

**Why.** The single-worker PHP CLI server serializes requests; a slow engine call
(analysis, bot move) blocks unrelated requests locally. Prod uses PHP-FPM (already
concurrent) so this is a **dev-only** ergonomic fix.

**Where.** Local run env / the `chessgo-api` alias. Optional, low priority.
