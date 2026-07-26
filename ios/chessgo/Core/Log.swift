import Foundation
import os

/// Thin `os.Logger` wrapper with a couple of severity helpers. Keeps logging
/// consistent and greppable without pulling in a dependency.
enum Log {
    private static let logger = Logger(subsystem: "de.timanthonyalexander.chessgo", category: "app")

    static func debug(_ message: String) { logger.debug("\(message, privacy: .public)") }
    static func info(_ message: String) { logger.info("\(message, privacy: .public)") }
    static func warn(_ message: String) { logger.warning("⚠️ \(message, privacy: .public)") }
    static func error(_ message: String) { logger.error("🛑 \(message, privacy: .public)") }
}
