# Local (in-browser) engine — build, net updates, serving

The in-browser analysis engine is zugzwang compiled to WASM
(`zugzwang/Makefile.wasm`) and driven from `frontend/src/lib/engine/`. This
doc covers the three things that are easy to get wrong: getting the build
artifacts served, updating the net without serving stale copies to existing
users, and serving the ~94MB net efficiently in prod.

## Pieces

- `zugzwang/Makefile.wasm` builds `zugzwang.js`/`.wasm` (baseline SIMD128)
  and `zugzwang-relaxed.js`/`.wasm` (relaxed-simd) — both gitignored build
  outputs, never committed.
- `frontend/public/local-engine/engine-worker.js` — the real Web Worker
  (hand-written, **tracked in git**). Picks the relaxed-simd build over
  SIMD128 at runtime when the browser supports it, loads the net, forwards
  UCI commands.
- `frontend/scripts/sync-local-engine.mjs` — copies the wasm build outputs
  from `zugzwang/` into `frontend/public/local-engine/`, content-hash-names
  and precompresses the net, and writes `VITE_LOCAL_ENGINE_NET_URL` into
  `frontend/.env` (gitignored). Runs automatically as `predev`/`prebuild`
  (see `package.json`) — `bun run dev` / `bun run build` always call it
  first and **fail loudly** (non-zero exit, explains exactly what's missing
  and how to build it) if the wasm build or the net haven't been generated.

## Building the engine + net (one-time, or after an engine/net change)

```sh
source ~/emsdk/emsdk_env.sh
cd zugzwang
make -f Makefile.wasm all              # -> zugzwang.js/.wasm + -relaxed variants
make netweb && ./tools/netweb_writer net.nnue net.web.nnue   # only if net.web.nnue is missing/stale
```

Then just run `bun run dev` or `bun run build` in `frontend/` — the
`predev`/`prebuild` hook picks both up automatically.

## Updating the net (the part that must not go wrong)

`bigFileStorage.ts` caches the net in OPFS/IndexedDB **keyed by its URL**.
If a new net keeps the same URL, every browser that already downloaded the
old one keeps serving it forever — there is no other invalidation
mechanism. So the URL must change whenever the net's bytes change.

`sync-local-engine.mjs` handles this automatically: it hashes
`zugzwang/net.web.nnue` (sha256, first 12 hex chars) and names the served
file `net.<hash>.nnue`. Whenever the net changes:

1. Regenerate `net.web.nnue` (see above).
2. Run `bun run sync-local-engine` (or just `bun run dev`/`bun run build` —
   it's the `pre` hook for both). This:
   - copies the net to `public/local-engine/net/net.<newhash>.nnue`,
   - brotli(-q11) and gzip(-9) compresses it next to the raw file,
   - deletes the previous hash's files from `public/local-engine/net/`,
   - rewrites `VITE_LOCAL_ENGINE_NET_URL` in `frontend/.env`.
3. **Prod deploys**: the env var has to be set *before* `vite build` runs on
   the build box, since Vite bakes `import.meta.env.VITE_LOCAL_ENGINE_NET_URL`
   into the built JS at build time. Either run
   `bun run sync-local-engine` on the build box before `vite build` (same as
   dev), or set `VITE_LOCAL_ENGINE_NET_URL=/local-engine/net/net.<hash>.nnue`
   explicitly in the deploy's env. Confirm the new `net.<hash>.nnue{,.br,.gz}`
   files actually exist at that path on the server — the app has no
   server-side fallback if they don't; `bigFileStorage` will just see a 404.

## Serving in prod (nginx)

Don't compress the net per-request — brotli -q11 on 90MB is far too slow to
do on the fly. `sync-local-engine.mjs` already produces `.br`/`.gz` siblings
next to the raw file. Serve them statically with content negotiation:

```nginx
location /local-engine/net/ {
    # ngx_brotli's static module — serves net.<hash>.nnue.br in place of
    # net.<hash>.nnue when the client sends `Accept-Encoding: br` and the
    # .br file exists; falls through to the raw file otherwise.
    brotli_static on;
    gzip_static on;   # same idea for gzip as the fallback

    # Correct MIME type + long cache: the filename is content-hashed, so a
    # cache hit is safe forever — a net change is a new URL, not a new body
    # at the same URL.
    types { application/octet-stream nnue; }
    add_header Cache-Control "public, max-age=31536000, immutable";
}

location /local-engine/ {
    # zugzwang.js/.wasm (58KB/326KB) — small enough for nginx's normal
    # on-the-fly gzip, no precompression needed.
    types { application/wasm wasm; application/javascript js; }
    gzip on;
}
```

Requires the `ngx_brotli` module (`brotli_static`) — verify it's compiled
into the prod nginx before relying on it; `gzip_static` ships in stock
nginx. If `ngx_brotli` isn't available, drop `brotli_static on;` and rely on
`gzip_static` alone (42MB over the wire instead of 36MB — still far better
than 94MB raw or per-request compression).

`application/wasm` is the correct MIME type for `.wasm` — some stock
`mime.types` files predate it; confirm nginx serves that content-type or
some browsers refuse `WebAssembly.instantiateStreaming` (our loader uses
`WebAssembly.instantiate` on an already-fetched `ArrayBuffer`, not
`instantiateStreaming`, so this specific engine load path tolerates a wrong
MIME type — but get it right anyway, it's one line).

## Dev

Vite's dev server serves `public/` verbatim — no compression, no content
negotiation. That's fine: it's local/loopback, so serving the raw 94MB net
uncompressed is the pragmatic choice and needs no special dev config. The
`.br`/`.gz` siblings sitting next to it in dev are unused (harmless, just
disk space) — they only matter once nginx is in the path.
