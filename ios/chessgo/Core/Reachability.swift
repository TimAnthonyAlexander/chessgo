import Foundation
import Network
import Observation

/// Network reachability, starts optimistic. Ported from lycea.
@Observable
final class Reachability {
    static let shared = Reachability()

    private(set) var isOnline = true

    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private let queue = DispatchQueue(label: "de.timanthonyalexander.chessgo.reachability")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.isOnline = online }
        }
        monitor.start(queue: queue)
    }
}
