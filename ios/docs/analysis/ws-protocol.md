# chessgo realtime hub — WebSocket protocol (iOS reference)

Hub: port 6467, path `/ws`. Package `gomachine/internal/hub`. Single-goroutine event loop.

## Connection
1. `GET /ws-ticket?anon=<stableClientId>` (BaseAPI) → `{ticket, wsUrl, identity:{name,anon,rating}}`.
2. Open WS to `${wsUrl}?ticket=${ticket}` — ticket is a **query param**, not a message.
3. Spectator (read-only): add `&spectate=1`.
4. Bad/expired ticket → HTTP 401 during upgrade (no WS frame); socket just fails to open.
5. First server frame is always `hello`: `{type:"hello", name, anon, rating}`.
6. Reconnect/resume is automatic on connect (hub re-seats you into any live game keyed by identity `sub`).
7. Ticket TTL 60s — fetch a FRESH ticket on every connect attempt.
8. Keepalive is transport-level WS ping/pong (server pings ~30s); URLSessionWebSocketTask handles pong automatically. No app-level ping message.

## Client → server (flat JSON, `type` selects handler)
Fields: `type, pool, move, gameId, text, color, rated, code, variant`.
| type | fields | when |
|---|---|---|
| `queue` | pool, variant | join matchmaking |
| `cancel` | — | leave queue |
| `move` | move (UCI; promo `e7e8q`; duck `e2e4:e5`) | your turn |
| `resign` | — | forfeit |
| `drawOffer`/`drawAccept`/`drawDecline` | — | draw (offer twice = accept) |
| `takebackOffer`/`takebackAccept`/`takebackDecline` | — | takeback |
| `chat` | text (≤280) | in-game chat (players only) |
| `watch`/`unwatch` | gameId | spectate attach/detach |
| `createChallenge` | pool,color,rated,variant | private invite |
| `joinChallenge` | code | join invite |
| `cancelChallenge` | — | withdraw invite |

Premoves: **NOT in the protocol** — client-side queue only; send as normal `move` once legal.

## Server → client (`{type, ...fields}`)
| type | payload |
|---|---|
| `hello` | {name,anon,rating} |
| `queued` | {pool,variant} |
| `idle` | {} |
| `matched` | see below |
| `challengeCreated` | {code,pool,color,rated,variant} |
| `challengeExpired` | {code} |
| `resume` | full replay (see below) |
| `state` | after every move/takeback (see below) |
| `end` | {gameId, result:"1-0"|"0-1"|"1/2-1/2"|null, reason, status, clock:{w,b}} |
| `opponentGone`/`opponentBack` | {gameId} |
| `drawOffered` | {gameId, by:"w"|"b"} |
| `drawDeclined` | {gameId} |
| `takebackOffered`/`takebackDeclined` | {gameId,(by)} |
| `chat` | {gameId, by, name, text} |
| `watching` | spectator snapshot |
| `watchEnd` | {gameId, reason} |
| `error` | {message} (bare, not correlated to a request) |

### `matched`
```json
{"type":"matched","gameId":"hex12","color":"w","rated":true,"pool":"3+0","variant":"standard",
 "fen":"...","duck":"","timeControl":{"base":180000,"inc":0},"clock":{"w":180000,"b":180000},
 "opponent":{"name":"...","rating":1500,"anon":false},"legalMoves":["e2e4",...]}
```
Crazyhouse adds `"pocket":"PPNq"` (white upper, black lower). Clocks/timeControl in **ms**.

### `state`
```json
{"type":"state","gameId":"...","variant":"standard","fen":"...","duck":"","sideToMove":"b",
 "lastMove":"e2e4","san":"e4","status":"ongoing","check":false,"clock":{"w":178342,"b":180000},
 "ply":1,"legalMoves":[...]}
```
Takeback re-broadcasts `state` with LOWER `ply` — detect `ply < localMoves.length` and truncate.

### `resume`
```json
{"type":"resume","gameId":"...","color":"w","rated":true,"pool":"3+0","variant":"standard",
 "fen":"...","duck":"","sideToMove":"w","status":"ongoing","check":false,
 "timeControl":{"base":180000,"inc":0},"clock":{"w":123456,"b":98765},
 "opponent":{"name":"...","rating":1500,"anon":false},"legalMoves":[...],
 "moves":[{"uci":"e2e4","san":"e4"},...],"lastMove":"e2e4","opponentOnline":true}
```
After `hello`, if no `resume` arrives within ~1.5s and you held a local game, treat it as ended.

## Matchmaking
- `queue{pool:"3+0", variant}`. pool grammar `<minutes>+<incSeconds>`, base 0..180, inc 0..180, not both 0.
- Rating-proximity pairing: band starts ±100, widens +50/sec, cap ±400. Anon baseline 1500.
- Categories: bullet(<180s est)/blitz(<480)/rapid(<1500)/classical for standard+960; duck/crazyhouse/antichess each isolated pool.
- Lone waiter gets a bot backfill after a delay — bots are indistinguishable on the wire (no isBot flag).
- Chess960 games start from random Fischer FEN and are NEVER rated.

## Clocks
- Server-authoritative, **milliseconds**. Times ride inside every state/matched/resume/end (no separate tick message).
- Client MUST count down locally: store `clockAt = Date()` when a `clock` arrives, then `remaining = clock[sideToMove] - (now - clockAt)`, clamp ≥0, drive a ~10Hz UI timer.
- Clocks don't start until BOTH sides have moved (`plies >= 2`). Before that a 30s first-move timeout aborts (`end` reason "aborted", result null).
- Increment added to mover's clock after their move once running.

## Reconnect / resume
- Reconnect key = ticket `sub` (account id, or stable per-install anon UUID). Reconnecting auto-resends `resume`; no explicit request.
- Disconnect does NOT end the game; clock keeps running (you can flag while away). Opponent gets `opponentGone`/`opponentBack`.
- Spectators never resume — re-send `watch{gameId}`.
- Resume is in-memory only; a hub restart loses live games.

## Full-game state machine
connect → hello → (resume if live game) → queue → queued → matched → [move ↔ state]* → end → back to lobby.
