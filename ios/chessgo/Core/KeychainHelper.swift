import Foundation
import Security

/// Minimal Keychain wrapper for the two secrets the app persists: the bearer
/// API token and a stable per-install anonymous id (used for ws-ticket
/// reconnect/resume when playing as a guest).
///
/// No third-party dependency — `kSecClassGenericPassword` get/set/delete.
final class KeychainHelper {
    static let shared = KeychainHelper()
    private init() {}

    private let service = "de.timanthonyalexander.chessgo"
    private let tokenKey = "apiToken"
    private let anonKey = "anonymousId"

    // MARK: Bearer token

    var token: String? {
        get { read(tokenKey) }
        set {
            if let newValue { write(tokenKey, newValue) } else { delete(tokenKey) }
        }
    }

    // MARK: Stable anonymous id (created once, then reused)

    var anonymousId: String {
        if let existing = read(anonKey) { return existing }
        let fresh = UUID().uuidString
        write(anonKey, fresh)
        return fresh
    }

    // MARK: - Primitives

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private func read(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }
        return string
    }

    private func write(_ key: String, _ value: String) {
        let data = Data(value.utf8)
        let q = query(key)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(q as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = q
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(insert as CFDictionary, nil)
        }
    }

    private func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}
