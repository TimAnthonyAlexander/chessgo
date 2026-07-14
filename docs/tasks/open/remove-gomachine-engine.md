# Remove the gomachine engine

**What.** Delete the legacy gomachine **engine** (`:6466`) once zugzwang has
soaked as primary. The gomachine **hub** (`gomachine/internal/hub`, `:6467`)
**stays** — it's the realtime infra.

**Why.** Since the 2026-07 cutover the gomachine engine has zero live usage
except: (1) an explicit "gomachine" option in the admin Engine-vs-Engine page, and
(2) the hub's `-emergency-inproc` in-process fallback. Both are removable.

**Where / steps.**
- Drop the `-emergency-inproc` fallback from the hub (`gomachine/cmd/gomachine/hub.go`,
  `gomachine/internal/hub`) — hard-fail (drop the move) if zugzwang is unreachable,
  rather than silently degrading to a weaker engine.
- Remove the "gomachine" side option from the admin EngineVsEngine page + the PHP
  `gomachineOnly` machinery in `app/Services/EngineSelector.php` (and the retired
  `ENGINE_PRIMARY=gomachine` escape hatch, once confidence is high).
- Delete `gomachine/internal/{eval,search,nnue}` + the `serve` subcommand, keeping
  `internal/chess` only if the hub still needs it (it uses it for move validation).

**Gate.** Don't delete until zugzwang has run as sole prod engine without incident.
