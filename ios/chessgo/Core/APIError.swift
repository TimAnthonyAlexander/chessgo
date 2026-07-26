import Foundation

/// Errors surfaced by `APIClient`. UI code should switch on these to decide
/// whether to show a message, force a re-login, or stay quiet on a flaky
/// network.
enum APIError: LocalizedError {
    case invalidURL
    case transport(Error)
    case server(status: Int, message: String, fields: [String: String]?)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid request URL."
        case .transport:
            return "Cannot reach the server. Check your connection."
        case let .server(_, message, _):
            return message
        case .decoding:
            return "The server sent something unexpected."
        }
    }

    var statusCode: Int? {
        if case let .server(status, _, _) = self { return status }
        return nil
    }

    /// A genuine auth failure — the caller should clear the session. A
    /// transport/timeout error is NOT this, so a flaky network never logs
    /// anyone out.
    var isUnauthorized: Bool {
        let code = statusCode
        return code == 401 || code == 403
    }
}

/// Uniform BaseAPI error body: `{"error": "...", "requestId": "..."}`.
struct APIErrorBody: Decodable {
    let error: String?
    let message: String?
    let errors: [String: String]?
}
