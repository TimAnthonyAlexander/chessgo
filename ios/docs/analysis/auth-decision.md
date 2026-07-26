# Auth architecture decision (chessgo iOS)

## Model: bearer token, minted inline, stored in Keychain
Based on lairner (which uses bearer tokens because app extensions can't see the main app's cookie jar; also cookies are flaky on iOS). We improve on lairner by using **Keychain** instead of plaintext UserDefaults.

### Client flow
1. **Login:** `POST /auth/login {email,password}` → response includes `api_token` inline (after backend patch below). Store token in Keychain. Also store the token's `id` (to DELETE on logout).
2. **Signup:** `POST /auth/signup {name,email,password}` → same, `api_token` inline.
3. **Every request:** `NetworkClient` attaches `Authorization: Bearer <token>` from Keychain (read fresh each request). Also send an `X-Anonymous-ID` stable per-install UUID header (for ws-ticket anon fallback / analytics).
4. **Cold launch:** read token from Keychain → `GET /me` to validate + hydrate user. Only clear session on real 401/403; never on transport/timeout.
5. **Logout:** `DELETE /api-tokens/{id}` (revoke server-side) then clear Keychain. `/auth/logout` alone does NOT revoke tokens.
6. **Guest mode:** bot games, puzzles, analysis, leaderboards all work with NO token. Live rated play + profile need login. Generate a stable per-install `X-Anonymous-ID` UUID (Keychain) so anonymous live play can reconnect/resume.

### lairner's addCommonHeaders (adapt)
```swift
private func addCommonHeaders(_ request: inout URLRequest) {
    request.setValue("ios", forHTTPHeaderField: "Client-Type")
    if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
        request.setValue(v, forHTTPHeaderField: "App-Version")
    }
    if let token = KeychainHelper.shared.token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue(anonymousId, forHTTPHeaderField: "X-Anonymous-ID")
}
```

## Backend patches required (BaseAPI, chessgo)
Two small, backward-compatible changes. Follow BaseAPI conventions (controllers, no manual DDL — no schema change needed here; ApiToken table already exists).

### Patch 1 (REQUIRED): `/ws-ticket` must honor bearer tokens
Today the route only runs `SessionStartMiddleware`, so `$request->user` is null for a bearer-only client → treated as anonymous → unrated live play.
Do NOT add `CombinedAuthMiddleware` — it hard-returns 401 when unauthenticated, which would break anonymous casual play (ws-ticket must stay public).
Fix (clean, DRY): port lairner's `OptionalAuthMiddleware` (`~/lairner/app/Middleware/OptionalAuthMiddleware.php`) verbatim into `chessgo/app/Middleware/OptionalAuthMiddleware.php`. It's chessgo's `CombinedAuthMiddleware` minus the 401: tries bearer token, then session, populates `$request->user` if found, always calls `$next`. Same `ApiToken::findByToken` / `App::userProvider()` calls chessgo already uses.
Then in `routes/api.php` add it to `/ws-ticket` (before RateLimit):
```php
$router->get('/ws-ticket', [
    SessionStartMiddleware::class,
    OptionalAuthMiddleware::class,
    RateLimitMiddleware::class => ['limit' => '300/1m'],
    WsTicketController::class,
]);
```
`WsTicketController` already reads `$request->user ?? null` first (line 32), so NO controller change. Bonus: this same middleware can upgrade `/analyze`, `/streak`, `/puzzles/*` to rate the logged-in bearer user — optional, do later.

### Patch 2 (nice-to-have): mint token inline on login/signup
In `LoginController` and `SignupController`, after auth success, create an `ApiToken` (name `"iOS App"` or from a client header) and add `api_token` (the one-time plaintext) to the JSON response. Backward-compatible — web frontend ignores the extra field. Mirrors `lairner LoginController.php`. If we skip Patch 2, the client does the two-step (`login` then `POST /api-tokens`) using the session cookie set by login — also works, one extra call.

### Verify before building
- Prod `.env`: `RESPONSE_WRAP_DATA` (expect false/flat), token auth enabled.
- `ApiToken`/`ApiTokenController`/`CombinedAuthMiddleware` exist in chessgo backend (they're generic BaseAPI).

## Keychain (build fresh, no library)
Small `kSecClassGenericPassword` wrapper: `token` get/set/delete, `anonymousId` get-or-create. No SPM dependency — hand-rolled `URLSession` + Keychain is the house norm (lairner pulls in zero networking/keychain packages).
