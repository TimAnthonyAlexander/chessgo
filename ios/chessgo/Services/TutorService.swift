import Foundation

private struct RequestReportBody: Encodable {
    let range: String
}

/// `/tutor/*` — the player report card. Every route requires auth (bearer
/// token, attached automatically by `APIClient`); an unauthenticated caller
/// gets a 401 the view layer should treat like any other `APIError`.
struct TutorService {
    static let shared = TutorService()
    private init() {}

    /// Your shelf of reports, newest first.
    func reports() async throws -> TutorReportsResponse {
        try await APIClient.shared.get("/tutor/reports")
    }

    /// Queue a build. Returns immediately with the queued row — poll
    /// `reports()` (or `report(id:)`) until it leaves `queued`/`building`.
    func requestReport(range: String = "6m") async throws -> TutorReportRequestResponse {
        try await APIClient.shared.post("/tutor/reports", body: RequestReportBody(range: range))
    }

    /// One report in full. 404s (not 403s) for someone else's — surfaces as
    /// `APIError.server(status: 404, ...)`.
    func report(id: String) async throws -> TutorReportDetailResponse {
        try await APIClient.shared.get("/tutor/reports/\(encodedPathComponent(id))")
    }

    func deleteReport(id: String) async throws -> TutorDeleteResponse {
        try await APIClient.shared.delete("/tutor/reports/\(encodedPathComponent(id))")
    }

    /// Drill into one opening from one side. Served from the stored report
    /// payload — re-analyzes nothing.
    func opening(reportId: String, category: String, color: String, family: String) async throws -> TutorOpeningDetail {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "category", value: category),
            URLQueryItem(name: "color", value: color),
            URLQueryItem(name: "family", value: family),
        ]
        let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
        return try await APIClient.shared.get("/tutor/reports/\(encodedPathComponent(reportId))/opening\(query)")
    }

    /// One metric across every report you've built, optionally scoped to one
    /// category. `nil`/empty omits the filter — every category comes back.
    func trend(category: String? = nil) async throws -> TutorTrendResponse {
        var path = "/tutor/trend"
        if let category, let encoded = category.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?category=\(encoded)"
        }
        return try await APIClient.shared.get(path)
    }

    private func encodedPathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}
