import Foundation

/// Base URLs and environment selection.
///
/// Simulator builds talk to the local dev API; everything else (a physical
/// device, Debug or Release, TestFlight, App Store) talks to production over
/// HTTPS. The WebSocket URL is never hardcoded here — it comes back from
/// `GET /ws-ticket` as `wsUrl`.
enum APIConfig {
    static let localBaseURL = "http://127.0.0.1:6464"
    static let remoteBaseURL = "https://chessgo-api.timanthonyalexander.de"

    /// The public web app, used only to build shareable links (e.g. a
    /// challenge invite `…/challenge/{code}`). Not an API host.
    static let webBaseURL = "https://chessgo.timanthonyalexander.de"

    static var baseURL: String {
        #if targetEnvironment(simulator)
        return localBaseURL
        #else
        return remoteBaseURL
        #endif
    }

    static var isLocal: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
}
