# iOS client architecture — patterns from lycea/coalla (+ lairner for auth)

Same author, same instincts. **Feature/domain folders, one `APIClient` singleton, pure async/await (no Combine in networking), `@Observable @MainActor` stores, one-line simulator/device URL switch, small files (~165 lines avg, <400 typical).**

## Project layout (mirror lycea)
```
Core/      APIClient, APIConfig, APIError, Resilient (@Default wrappers), Reachability, KeychainHelper, TokenStore
Models/    pure Codable DTOs (one concern per file)
Services/  stateless structs, `static let shared`, one per domain, wrap APIClient (AuthService, BotService, PuzzleService, ...)
State/     @Observable @MainActor stores (AuthManager, GameStore, ...)
Theme/     Theme, LiquidGlass (glassed() fallback), Color+Hex, fonts
Views/     feature-grouped (Auth/, Lobby/, Game/, Bot/, Puzzles/, Analysis/, Profile/, Components/)
```
Split a fat service via `extension` files (`BotService+Undo.swift`) — same call-site type.

## Networking (lycea APIClient shape)
One singleton wrapping one `URLSession`. Generic `send<T:Decodable>(path, method, bodyData) async throws -> T`. Set `.convertFromSnakeCase`/`.convertToSnakeCase` once. Steal lycea's `Self.describe(DecodingError)` → "missing key X at [path]" logging.
- Non-2xx → decode `{error}` body → throw `APIError.server(status, message)`.
- Empty body + `T == Empty` → return Empty.
- Keep coalla's dual decode (try `{data:T}`, fall back to bare `T`) since our envelope is flat but be safe.

`APIError` (lycea enum):
```swift
enum APIError: LocalizedError {
    case invalidURL, transport(Error), server(status:Int, message:String, fields:[String:String]?), decoding(Error)
    var statusCode: Int? { if case let .server(s,_,_) = self { return s }; return nil }
    var isUnauthorized: Bool { statusCode == 401 || statusCode == 403 }
}
```

## AUTH — BEARER TOKENS (lairner model, NOT cookies)
Decision: cookies were unreliable on iOS (lairner abandoned them). Use API tokens.
Flow: `POST /auth/login` (creates session) → `POST /api-tokens {name:"ios-<deviceName>"}` → store `token` in **Keychain** → attach `Authorization: Bearer <token>` on every request → on launch validate via `GET /me`.
- Only clear the logged-in user on a real 401/403, never on a transport/timeout error (flaky network must not sign you out).
- Logout: `DELETE /api-tokens/{id}` (kills token server-side) then clear Keychain. `/auth/logout` alone does NOT revoke tokens.
- Keychain helper: build fresh (neither lycea/coalla use Keychain; lairner does — see lairner reference doc). Simple `kSecClassGenericPassword` get/set/delete wrapper.

## ENV switching (copy verbatim)
```swift
enum APIConfig {
    static let localBaseURL  = "http://127.0.0.1:6464"
    static let remoteBaseURL = "https://chessgo-api.timanthonyalexander.de"
    static var baseURL: String {
        #if targetEnvironment(simulator)
        return localBaseURL
        #else
        return remoteBaseURL
        #endif
    }
}
```
Simulator → local dev. Physical device (Debug or Release) → prod HTTPS. WS base URL is NOT hardcoded — read `wsUrl` from `/ws-ticket`.

## State (lycea style)
`@Observable @MainActor final class` stores. Build each once as `@State` on the App struct, inject via `.environment(_:)`. A store that non-view code also needs is both a `.shared` singleton AND the injected instance (same object).

## Schema-drift resilience — copy lycea's `Resilient.swift` wholesale
`@Default*` property wrappers (`DefaultFalse`, `DefaultZero`, `DefaultEmptyString`, `DefaultEmptyArray`) so a missing/new server field doesn't sink decode. `DefaultEmptyArray` uses a `Lossy<T>` inner wrapper to drop individually malformed rows. Rule: identity fields (`id`,`name`) stay non-optional `let` (crash loud on genuinely broken responses); anything that can drift with a deploy gets a `@Default`. Timestamps are `String?` (absent on POST-create responses even though present on GET).

## Liquid Glass — deployment target iOS 18, use glass where available (26+)
Copy coalla's `Theme/LiquidGlass.swift` dual-path `.glassed(in:interactive:)`:
```swift
@ViewBuilder func glassed(in shape: some Shape = Capsule(), interactive: Bool = false) -> some View {
    if #available(iOS 26.0, *) {
        self.glassEffect(interactive ? Glass.regular.interactive() : .regular, in: shape)
    } else {
        self.background(shape.fill(.ultraThinMaterial)
            .overlay(shape.stroke(.white.opacity(0.20), lineWidth: 1)))
    }
}
```
Also `.buttonStyle(.glassProminent)` gated on `#available(iOS 26.0)` with a `LegacyFilledButtonStyle` fallback. NOTE: Simulator does NOT render specular highlights — validate glass on device.

## WebSocket — build fresh (neither app has one)
Use `URLSessionWebSocketTask`. Reconnect with a fresh ticket each time. See ws-protocol.md. Coalla's 4s polling loop is a fallback template for low-priority realtime only, not live game state.

## Reachability — copy lycea's `Reachability.swift` (NWPathMonitor, @Observable, starts optimistic).

## Design/copy bar (HUMANWRITING.md + VIBECODING.md)
- Prose: no "delve/leverage/robust/seamless", no "not just X, it's Y", no rule-of-three padding, no rhetorical-Q-then-answer, no sycophantic/hedging filler, no em-dash-for-drama.
- Visual: constrained palette (one dominant + one accent + neutral), NOT purple→indigo gradients, whitespace over nested cards, a real icon set (SF Symbols) not emoji, one typeface two weights, no fabricated stats. Every visual choice must answer "why this, not the default."
