import Foundation

private struct SignupRequest: Encodable {
    let name: String
    let email: String
    let password: String
}

private struct LoginRequest: Encodable {
    let email: String
    let password: String
}

private struct CreateTokenRequest: Encodable {
    let name: String
    let expiresAt: String?
}

/// `GET /me` is the one REST endpoint wrapped in a named key.
private struct MeResponse: Decodable {
    let user: User
}

/// `POST /api-tokens` — the plaintext token is shown once, here, and never
/// again (only its id/name/timestamps come back from `GET /api-tokens`).
struct ApiTokenCreated: Decodable, Sendable {
    let token: String
    let id: String
    let name: String
    let expiresAt: String?
    let createdAt: String?
}

/// `/auth/login` and `/auth/signup` return the full User object at the root
/// (flat body, `RESPONSE_WRAP_DATA=false`) with `api_token` merged in inline
/// by the Wave 0 backend patch. Decode both from the same payload rather
/// than modeling `apiToken` as a User property — it isn't part of the User
/// resource, only of this one response.
struct AuthResponse: Decodable, Sendable {
    let user: User
    let apiToken: String?
    let apiTokenId: String?

    private enum CodingKeys: String, CodingKey {
        case apiToken
        case apiTokenId
    }

    init(from decoder: Decoder) throws {
        user = try User(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        apiToken = try container.decodeIfPresent(String.self, forKey: .apiToken)
        apiTokenId = try container.decodeIfPresent(String.self, forKey: .apiTokenId)
    }
}

struct AuthService {
    static let shared = AuthService()
    private init() {}

    func signup(name: String, email: String, password: String) async throws -> AuthResponse {
        try await APIClient.shared.post(
            "/auth/signup",
            body: SignupRequest(name: name, email: email, password: password)
        )
    }

    func login(email: String, password: String) async throws -> AuthResponse {
        try await APIClient.shared.post(
            "/auth/login",
            body: LoginRequest(email: email, password: password)
        )
    }

    func me() async throws -> User {
        let response: MeResponse = try await APIClient.shared.get("/me")
        return response.user
    }

    func logout() async throws {
        let _: Empty = try await APIClient.shared.post("/auth/logout")
    }

    func createToken(name: String, expiresAt: String? = nil) async throws -> ApiTokenCreated {
        try await APIClient.shared.post(
            "/api-tokens",
            body: CreateTokenRequest(name: name, expiresAt: expiresAt)
        )
    }

    func deleteToken(id: String) async throws {
        let _: Empty = try await APIClient.shared.delete("/api-tokens/\(id)")
    }
}
