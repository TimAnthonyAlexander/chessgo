# Opening name / ECO port (`/candidates` `opening:null` gap)

**What.** zugzwang returns a hardcoded `opening: null` in `/bestmove`,
`/candidates`, and per-candidate (`zugzwang/src/serve_handlers.cpp`, "no
opening-name table ported — Wave 1").

**Why.** The website's analysis board and multi-PV eval bars expect an
`{name, eco}` object like gomachine's `openings.Classify` returned. Right now the
opening explorer shows nothing on the zugzwang path.

**Where.** Port gomachine's Zobrist-keyed opening-name table (Go `internal/book`/
`openings`) into a zugzwang rules-side classifier and feed it into the serve
handlers that currently stub `null`.
