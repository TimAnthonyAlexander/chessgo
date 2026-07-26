import Foundation

/// Empty response placeholder for endpoints that return no meaningful body.
struct Empty: Decodable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// The one HTTP client. Every service funnels through `send`. Pure
/// async/await, bearer-token auth, snake_case↔camelCase conversion, and a
/// decode-error describer that turns a `DecodingError` into a readable path.
///
/// REST bodies from BaseAPI are snake_case; the shared decoder uses
/// `.convertFromSnakeCase`, so model properties stay camelCase. WebSocket
/// frames (camelCase already) are decoded separately in the socket layer.
final class APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    private init() {
        let config = URLSessionConfiguration.default
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = true
        session = URLSession(configuration: config)

        decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
    }

    // MARK: - Verbs

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "GET", body: nil)
    }

    func post<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        try await send(path, method: "POST", body: try encoder.encode(body))
    }

    func post<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "POST", body: nil)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send(path, method: "DELETE", body: nil)
    }

    // MARK: - Core

    private func send<T: Decodable>(_ path: String, method: String, body: Data?) async throws -> T {
        guard let url = URL(string: APIConfig.baseURL + path) else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        addCommonHeaders(&request)
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            Log.error("transport \(method) \(path): \(error.localizedDescription)")
            throw APIError.transport(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            let body = try? decoder.decode(APIErrorBody.self, from: data)
            let message = body?.error ?? body?.message ?? "Request failed (\(status))."
            throw APIError.server(status: status, message: message, fields: body?.errors)
        }

        if data.isEmpty, let empty = Empty() as? T { return empty }

        do {
            return try decode(T.self, from: data)
        } catch let error as DecodingError {
            Log.error("decode \(path): \(Self.describe(error))")
            throw APIError.decoding(error)
        }
    }

    /// BaseAPI success bodies are flat, but tolerate an optional `{data: ...}`
    /// envelope so a config flip on the server can't break the client.
    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        if let wrapped = try? decoder.decode(Wrapped<T>.self, from: data) {
            return wrapped.data
        }
        return try decoder.decode(T.self, from: data)
    }

    private struct Wrapped<T: Decodable>: Decodable { let data: T }

    private func addCommonHeaders(_ request: inout URLRequest) {
        request.setValue("ios", forHTTPHeaderField: "Client-Type")
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            request.setValue(version, forHTTPHeaderField: "App-Version")
        }
        if let token = KeychainHelper.shared.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue(KeychainHelper.shared.anonymousId, forHTTPHeaderField: "X-Anonymous-ID")
    }

    // MARK: - Decode diagnostics

    static func describe(_ error: DecodingError) -> String {
        switch error {
        case let .keyNotFound(key, context):
            return "missing key '\(key.stringValue)' at [\(path(context))]"
        case let .typeMismatch(type, context):
            return "type mismatch (\(type)) at [\(path(context))]"
        case let .valueNotFound(type, context):
            return "missing value (\(type)) at [\(path(context))]"
        case let .dataCorrupted(context):
            return "data corrupted at [\(path(context))]"
        @unknown default:
            return "\(error)"
        }
    }

    private static func path(_ context: DecodingError.Context) -> String {
        context.codingPath.map(\.stringValue).joined(separator: ".")
    }
}
