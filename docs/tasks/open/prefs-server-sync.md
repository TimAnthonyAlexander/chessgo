# Sync preferences to the account

**Status:** deliberately deferred (2026-07-28), not abandoned.

Every setting is device-local. Eight localStorage keys across four stores:

| Store | Keys |
|---|---|
| `settingsStore` (one JSON blob, ~26 prefs) | `chessgo.prefs` |
| `themeStore` | `chessgo.board`, `chessgo.pieces` |
| `soundThemeStore` | `chessgo.sound.material` |
| `siteThemeStore` | `chessgo.site.mode`, `chessgo.site.palette`, `chessgo.site.backdrop` |

There is no prefs endpoint anywhere in `routes/api.php`. Lichess models every
preference server-side (`Pref.scala`) precisely so it follows the account around.

This matters more for us than for a web-only site: we ship a native iOS client
with its own `SettingsStore`, so a user configures board, pieces, sounds and move
method twice and watches them drift. Cross-device drift is also one of the things
chess.com is visibly bad at — puzzle ratings have been reported diverging between
their Android app and their website.

## Design

- `GET /me/prefs` and `PUT /me/prefs`, one JSON blob, session or bearer auth.
- Merge, don't overwrite: the server blob merges over `DEFAULTS` on read exactly
  as `sanitize()` in `lib/settings.ts` already does, so a client on an older
  build never wipes a key it doesn't know about.
- Last-write-wins is fine. Preference edits are rare, single-user, and not worth
  a conflict model.
- Local storage stays the fast path and the offline/guest path. The server copy
  is the sync layer, applied on login and pushed on change (debounced).
- Guests keep working with no account and no requests.
- Fold the four stores into one payload so a single round trip covers everything.
- iOS reads the same endpoint. Same key names, same defaults, or the whole point
  is lost.

## Done when

Log in on a second device and your board, pieces, sounds and gameplay settings
are already there — including on the phone.
