# chessgo BaseAPI — REST contract (iOS client reference)

Prod API host: `https://chessgo-api.timanthonyalexander.de`. Dev: `http://127.0.0.1:6464`.

## Transport
- All JSON. Success bodies are **flat/unwrapped** (`RESPONSE_WRAP_DATA=false`), so `POST /auth/login` returns the User object at the root, not `{data:...}`. Build the decoder tolerant of an optional `{data:...}` envelope anyway (dual-decode).
- Errors uniform: `{"error": "<message>", "requestId": "<uuid|null>"}` at 400/401/404/500/502/503. A few use 422 with a nested `{success:false, meta}`.
- Param binding precedence: route path → query string → JSON body. POST endpoints also accept params as query args (except array params like `history`, which must go in the JSON body).
- Rate limits per route; expect 429.

## AUTH (we use BEARER TOKENS — see auth decision in SPEC)
- `POST /auth/signup` — body `{name, email, password(min:8)}` → 201 full User. No token returned; mint separately.
- `POST /auth/login` — body `{email, password}` → 200 full User. 401 `Invalid credentials` (same message for bad creds AND banned). Sets session cookie too, but we use tokens.
- `POST /auth/logout` — auth required → `{message:"Logged out"}`. Does NOT revoke API tokens; delete token explicitly to kill it.
- `GET /me` — auth required → `{user: <User>}` (this one IS wrapped in `user`).
- `POST /api-tokens` — auth required (session or existing token) → 201 `{token:"<64hex, SHOWN ONCE>", id, name, expires_at, created_at}`. Body `{name(required,max100), expires_at?}`.
- `GET /api-tokens` → `{tokens:[{id,name,expires_at,last_used_at,created_at}]}`.
- `DELETE /api-tokens/{id}` → `{message}`.
- Bearer usage: `Authorization: Bearer <token>` accepted by `CombinedAuthMiddleware` (checked BEFORE cookie). Token = SHA-256 lookup on `ApiToken`.

### User object (from User model, password stripped)
`id, created_at, updated_at, name, email, active:bool, role:"guest"|"user"|"admin"`,
per-pool rating blocks for `bullet/blitz/rapid/classical/puzzle/duck/crazyhouse/antichess`:
`rating_<pool>:int(1500), rd_<pool>:float(350), vol_<pool>:float(0.06), rated_at_<pool>:string?, games_<pool>:int`,
`current_streak, longest_streak, last_active_date:string?("YYYY-MM-DD"), freeze_tokens:int`,
`provisional:{bullet,blitz,rapid,classical,puzzle,duck,crazyhouse,antichess: bool}`.

## WS-TICKET (realtime handshake)
`GET /ws-ticket?anon=<stableClientId>` → `{ticket, wsUrl, identity:{name,anon,rating}}`.
- `wsUrl` dev `ws://127.0.0.1:6467/ws`, prod `wss://.../ws` — ALWAYS read from response, never hardcode.
- Ticket TTL 60s; mint fresh on every socket connect/reconnect.
- **Bearer tokens ARE honored** (`OptionalAuthMiddleware` on the route, plus `BearerAuth::user()` resolved inside `WsTicketController` itself). The controller does not rely on the middleware alone: on prod the middleware silently wasn't applying and every iOS client got `anon:true` with its install id as `sub` — invisible to the hub as the account, so no cross-device resume and **unrated** live play. `BearerAuth` also reads `$_SERVER[HTTP_AUTHORIZATION]`/`REDIRECT_HTTP_AUTHORIZATION`, since which of those carries the header depends on the SAPI.
- **Sanity check after any deploy:** the ticket's `sub` must equal your user id (decode `ticket.split('.')[0]` as base64url) and `identity.anon` must be false. An install-UUID `sub` means the token wasn't honored.

## BOT GAMES (no auth required; guest-playable)
- `POST /bot-games` — body `{rating?:int(0..3500, default 1500; 0=Unlosable bot plays worst), human_color?:"w"|"b", fen?, variant?:"standard"|"chess960"|"duck"|"crazyhouse"|"antichess"|"fading"|"glassjaw"|"doublemove"}` → 201 game state.
  (route comment saying `level 0..10` is STALE; real field is `rating`.)
- `GET /bot-games/{id}` — same shape. 404 if missing.
- `POST /bot-games/{id}/move` — body `{move(max8)}` UCI; Duck composite `"e7e8q:h6"`. Applies human move + bot reply synchronously. 422 on illegal.
- `POST /bot-games/{id}/undo` — pops bot+human move. 422 if nothing/duck/doublemove.

### Bot game state shape (BotGameService::present)
`{id, created_at, updated_at, rating:int, human_color, variant, duck:string?, fen, side_to_move:"w"|"b", status, result:"1-0"|"0-1"|"1/2-1/2"|null, moves:[{ply,uci,san,by:"human"|"bot",fen,eval?:{type:"cp"|"mate",value},duck?}], legal_moves:[uci], your_turn:bool}`.

## ANALYSIS
- `POST /analyze` — body `{fen(required), movetime?, depth?, multipv?(≤12), history?:string[]}` → `{eval:{type:"cp"|"mate",value}|null, bestmove:uci|null, pv:[uci]|null, depth:int|null, opening:{eco,name}|null, lines?:[{bestmove,san,eval,pv,depth,opening}]}`. eval side-to-move-relative. Default movetime 1500ms; depth clamped 1..40.
  - `multipv>1` returns `lines` — the top N moves from ONE MultiPV search, **all at the same depth**, so they are comparable to each other and to the eval bar. N lines costs the engine ~N root searches (measured ~4.4x wall clock at 5 lines; Stockfish pays ~4.6x), so ration it: the iOS ladder asks for 5 only through depth 16 and drops to 1 on the deep tail.
  - `history` is prior-position **FENs**, root→previous — *not* UCI moves. Non-FEN entries are silently skipped server-side, which reduces a UCI list to an empty history and costs you the deepest-match opening name.
  - On a book position line 1 is the book move (a Stockfish-computed best-move cache, ~100 Elo over our own search) and is never re-ranked; its *eval* is normalized to the engine's so the list stays comparable, while the top-level `eval` carries the book's own deeper number.
- `POST /candidates` — body `{fen(required), history?:string[](body only), multipv?(≤12), movetime?(50..2000,def300), depth?(≤30)}` → `{opening:{eco,name}|null, moves:[{uci,san,eval,pv,depth,opening}]}` best-first. Same single-search MultiPV as `/analyze`'s `lines`; still used by the web's mid-game opening strip. The iOS analysis board no longer calls it — its move list comes from the eval ladder's `lines`.
- `POST /sf-analyze` — body `{fen(required), movetime?(def300)}` → `{bestmove,san,eval}` full-strength Stockfish.
- `POST /duck/analyze`, `/antichess/analyze`, `/duck/legal-moves`, `/duck/move` — free-play variant boards (stateless). Duck move composite `"pieceUCI:duckSquare"`.
- `GET /games/{id}/analysis` — finished-game post-mortem, cached. `{version, variant, hubGameId, result, reason, pool, rated, whiteName, blackName, whiteIsBot, blackIsBot, startFen, plies:[{ply,fen,duck,sideToMove,evalWhite:{type,white},bestUci,bestSan,bestPv,bestDepth,move?:{uci,san,color,cpLoss,isBest,judgment:"best"|"good"|"inaccuracy"|"mistake"|"blunder"}}], summary:{w:{best,good,inaccuracy,mistake,blunder,acpl,accuracy}, b:{...}}}`. Chess960/Crazyhouse → `{unsupported:true}`.

## LIVE GAME LOOKUP (finished record; live play is over WS)
- `GET /games/{id}` — `{id}`=hub_game_id → full Game: `{id, hub_game_id, pool, category, rated, variant, result, reason, white_uid, black_uid, white_name, black_name, white_user_id?, black_user_id?, white_is_bot, black_is_bot, white_rating_before/after, black_rating_before/after, ply, moves:[uci], sans:[san]}`.

## STATS / PROFILES
- `GET /stats` → `{playersOnline, activeGames}`.
- `GET /watch` → `{games:[...], max:5}` top live games (shape hub-defined).
- `GET /leaderboard?category=&limit=(1..50,def10)` — category ∈ bullet/blitz/rapid/classical/puzzle/duck/antichess (NO crazyhouse). → `{category, entries:[{rank,id,name,rating,games,provisional}]}`.
- `GET /streak` → `{current, longest, lastActiveDate?, freezeTokens, activeToday}`.
- `GET /users/{name}` → `{id, name, role, created_at, ratings:{bullet:{rating,rd,games,provisional,rated_at},blitz,rapid,classical}, puzzle:{rating,rd,games,solved,provisional}, duck, antichess, record:{wins,losses,draws,total}, games:[<summaryRow ≤10>], gamesTotal, gamesPerPage:10}`.
- `GET /users/{name}/games?page=&category=&result=win|loss|draw` → `{games:[summaryRow], page, perPage:10, total}`.

## PUZZLES
- `GET /puzzles/next?theme=` → `{id, rating, start_fen, opponent_move:uci, fen, color:"w"|"b", legal_moves:[uci], ply:1}` (opponent's first move auto-played).
- `GET /puzzles/daily` → same + `themes:[]`, deterministic per UTC day.
- `POST /puzzles/{id}/move` — body (JSON only) `{move(uci,≤5), fen, ply(odd)}` → one of:
  - wrong/over: `{correct:false, complete:true, solved:false, solution:[uci], themes, rating:{value,delta,games}|null}`
  - correct+complete: `{correct:true, complete:true, solved:true, alternative:bool, status, fen, themes, rating|null}`
  - correct+continue: `{correct:true, complete:false, opponent_move:uci, fen, legal_moves:[uci], ply:ply+2}`
  - Accepts objectively-equal alt moves (engine ±50cp) — don't hardcode exact-match messaging.

## MISC
- `POST /guess-the-elo` → self-play game `{id, startFen, result, status, moves:[{ply,uci,san,fen}]}`; `POST /guess-the-elo/{id}/guess` body `{guess(700..2500)}` → `{actual, guess, delta, score, result}`.
- `GET /health`.
- `/admin/*` require role admin — skip for player app.
