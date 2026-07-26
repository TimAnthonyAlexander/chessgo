import Foundation

/// `GET /watch` — top live games for the spectate lobby (`rest-api.md`:
/// "top live games (shape hub-defined)"). The hub marshals this straight off
/// its in-memory game list (`gomachine/internal/hub/spectate.go`'s
/// `gameSummary`/`sideSummary` structs, no `omitempty`) and BaseAPI's
/// `WatchController` passes it through untouched — so every field is present
/// today, but this is a hub-owned wire shape the client doesn't control.
/// Every leaf gets a `@Default` guard, and the array itself drops
/// individually malformed rows (`DefaultEmptyArray`'s per-element `Lossy`
/// decode) rather than failing the whole lobby list on one odd entry.
struct WatchPlayer: Decodable, Sendable {
    @DefaultEmptyString var name: String
    @DefaultZero var rating: Int
    @DefaultFalse var anon: Bool
}

/// One live game as the lobby snapshot describes it — NOT the richer
/// spectator `watching` WS frame (`SpectateStore.swift`'s `WsWatching`).
/// `duck`/`lastMove` are empty strings (not null) on the wire when not
/// applicable; kept as plain strings here rather than optionals to match.
struct WatchGame: Decodable, Identifiable, Sendable {
    let id: String
    @DefaultEmptyString var pool: String
    @DefaultFalse var rated: Bool
    @DefaultEmptyString var variant: String
    let white: WatchPlayer
    let black: WatchPlayer
    @DefaultEmptyString var fen: String
    @DefaultEmptyString var duck: String
    @DefaultEmptyString var sideToMove: String
    @DefaultEmptyString var lastMove: String
    @DefaultZero var ply: Int
    /// Milliseconds remaining, each side. Named `clockW`/`clockB` on the wire
    /// (not a nested `{w,b}` pair like the live-game socket frames).
    @DefaultZero var clockW: Int
    @DefaultZero var clockB: Int
}

/// `{games:[...], max:5}` — `max` is the hub's configured lobby cap, not
/// necessarily `games.count` (fewer live games than the cap is normal; an
/// unreachable hub fails open to `{games: [], max: 5}` server-side).
struct WatchResponse: Decodable, Sendable {
    @DefaultEmptyArray var games: [WatchGame]
    @DefaultZero var max: Int
}

#if DEBUG
extension WatchGame {
    /// Preview fixture, decoded from a JSON string literal rather than
    /// hand-constructed — `WatchGame` carries `@Default`-wrapped properties,
    /// and the synthesized memberwise initializer for those demands the
    /// wrapper type, not the raw value (see SPEC.md's "@Default construction
    /// gotcha"). Decoding is always safe regardless of the wrapper.
    static func mock(
        id: String = "abc123def456",
        whiteName: String = "Nimzo42",
        blackName: String = "Capa88",
        variant: String = "standard"
    ) -> WatchGame {
        let json = """
        {
          "id": "\(id)",
          "pool": "3+0",
          "rated": true,
          "variant": "\(variant)",
          "white": {"name": "\(whiteName)", "rating": 1642, "anon": false},
          "black": {"name": "\(blackName)", "rating": 1590, "anon": false},
          "fen": "r1bqk2r/ppp2ppp/2n2n2/2bpp3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 2 6",
          "duck": "",
          "sideToMove": "w",
          "lastMove": "d7d5",
          "ply": 10,
          "clockW": 154000,
          "clockB": 168500
        }
        """
        return try! JSONDecoder().decode(WatchGame.self, from: Data(json.utf8))
    }

    /// A second fixture with different names/colors so grid previews don't
    /// look like duplicated cards.
    static func mockDuck() -> WatchGame {
        let json = """
        {
          "id": "duck999",
          "pool": "5+0",
          "rated": false,
          "variant": "duck",
          "white": {"name": "Quacker", "rating": 1310, "anon": false},
          "black": {"name": "Guest2921", "rating": 1500, "anon": true},
          "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
          "duck": "d4",
          "sideToMove": "b",
          "lastMove": "e2e4",
          "ply": 1,
          "clockW": 298000,
          "clockB": 300000
        }
        """
        return try! JSONDecoder().decode(WatchGame.self, from: Data(json.utf8))
    }
}
#endif
