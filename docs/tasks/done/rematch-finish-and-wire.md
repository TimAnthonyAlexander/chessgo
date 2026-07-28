# Rematch — finish the hub work and wire the UI

**Status:** verified and completed — 2026-07-28. Backend committed in 1509eea, frontend wired in follow-up.

There is no rematch in the product. When a live game ends the only options are
"Lobby" and "New game", and "New game" re-queues the matchmaking pool rather than
challenging the same opponent. Rematch is the main retention loop on chess.com;
this is the single biggest missing feature on the live surface.

## What already exists (2026-07-28, uncommitted)

`gomachine/internal/hub/rematch.go` plus edits to `hub.go`, `game.go`,
`protocol.go`, `client.go`, `challenge.go`. The agent that wrote it reported 7
rematch tests passing, but it was stopped before the full hub suite and the
`-race` run completed. Nothing downstream was touched.

## To do

1. Verify the Go side: `cd gomachine && go build ./... && go test ./internal/hub/`,
   then the same with `-race`. Read `rematch.go` against the existing draw-offer
   plumbing in `game.go` and confirm it matches the locking discipline.
   Confirm the offer covers: colors swapped, same time control, same variant,
   same rated flag; expiry on disconnect/leave/timeout; no double-accept; both
   sides offering simultaneously pairs them once rather than creating two games;
   spectators can't offer.
2. `frontend/src/lib/socket.ts` — never touched. Add the client half:
   `offerRematch()`, `acceptRematch()`, `declineRematch()`, `cancelRematch()`,
   plus observable state for offered-by-me / offered-by-them / the new game id to
   navigate to. Match the store idiom already in that file.
3. `pages/LiveGame.tsx` — the game-over block is at ~640-722. Add the offer and
   accept/decline UI there, ahead of "New game". Handle the opponent leaving
   while an offer is open.
4. `pages/BotGame.tsx` — rematch here is purely client-side: start a new bot game
   with the same settings and colors swapped. No hub involvement.

## Done when

Two browsers can rematch each other repeatedly, colors alternate, ratings apply
normally, and killing one tab cleans the offer up without leaking a goroutine or
a map entry.
