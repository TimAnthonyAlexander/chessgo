import Foundation

/// The one auth store. Bearer-token session (`auth-decision.md`): token lives
/// in Keychain, `apiTokenId` lives in UserDefaults (needed only to revoke on
/// logout, fine in plain defaults), `user` is the hydrated profile.
///
/// Guest is a steady state, not an error — `user == nil` after `bootstrap()`
/// just means "playing without an account." Only a real 401/403 clears a
/// session; a flaky network never signs anyone out.
@Observable
@MainActor
final class AuthStore {
    enum Phase {
        case loading
        case ready
    }

    private(set) var user: User?
    private(set) var phase: Phase = .loading
    var errorMessage: String?

    var isAuthenticated: Bool { user != nil }

    private let apiTokenIdKey = "apiTokenId"

    private var storedApiTokenId: String? {
        get { UserDefaults.standard.string(forKey: apiTokenIdKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: apiTokenIdKey)
            } else {
                UserDefaults.standard.removeObject(forKey: apiTokenIdKey)
            }
        }
    }

    init() {}

    // MARK: - Cold launch

    /// Validate any stored token against `/me`. Ends in `.ready` no matter
    /// what — the caller never has to guess whether bootstrap "finished."
    func bootstrap() async {
        defer { phase = .ready }

        guard KeychainHelper.shared.token != nil else { return }

        do {
            user = try await AuthService.shared.me()
        } catch let error as APIError where error.isUnauthorized {
            clearLocalSession()
        } catch {
            // Transport/timeout/decoding hiccup — keep whatever we had and
            // try again next launch. Do NOT log the user out for this.
            Log.error("AuthStore.bootstrap: \(error.localizedDescription)")
        }
    }

    // MARK: - Login / signup

    func login(email: String, password: String) async throws {
        let response = try await AuthService.shared.login(email: email, password: password)
        apply(response)
    }

    func signup(name: String, email: String, password: String) async throws {
        let response = try await AuthService.shared.signup(name: name, email: email, password: password)
        apply(response)
    }

    private func apply(_ response: AuthResponse) {
        KeychainHelper.shared.token = response.apiToken
        storedApiTokenId = response.apiTokenId
        user = response.user
    }

    // MARK: - Logout

    /// Best-effort revoke, but the local session ALWAYS clears — a dead
    /// token or an unreachable server must never trap the user signed in.
    func logout() async {
        if let tokenId = storedApiTokenId {
            try? await AuthService.shared.deleteToken(id: tokenId)
        }
        try? await AuthService.shared.logout()
        clearLocalSession()
    }

    /// Clears local session state without any network call — for the
    /// "account already gone" case (e.g. a 401 during bootstrap).
    func clearLocalSession() {
        KeychainHelper.shared.token = nil
        storedApiTokenId = nil
        user = nil
    }

    // MARK: - Post-game rating refresh

    /// The server persists Elo asynchronously, so an immediate `/me` right
    /// after a rated game/puzzle is often stale. Poll on the web's schedule
    /// and land on the first response whose summed games count moved past
    /// the pre-game baseline; otherwise settle for the last read.
    func refreshAfterRatedResult() async {
        guard user != nil else { return }
        let baseline = totalGames(user)
        let delaysMs: [UInt64] = [0, 500, 1_000, 2_000, 3_500]

        var lastGood: User?
        for delayMs in delaysMs {
            if delayMs > 0 {
                try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            }
            guard let fetched = try? await AuthService.shared.me() else { continue }
            lastGood = fetched
            if totalGames(fetched) > baseline {
                user = fetched
                return
            }
        }
        if let lastGood {
            user = lastGood
        }
    }

    private func totalGames(_ user: User?) -> Int {
        guard let user else { return 0 }
        return RatingCategory.allCases.reduce(0) { $0 + user.games(for: $1) }
    }
}

#if DEBUG
extension AuthStore {
    /// Preview/test-only: builds a store already past `.loading` in a given
    /// signed-in or guest state, without a network round trip.
    static func preview(user: User? = nil) -> AuthStore {
        let store = AuthStore()
        store.user = user
        store.phase = .ready
        return store
    }
}
#endif
