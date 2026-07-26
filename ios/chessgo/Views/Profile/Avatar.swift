import SwiftUI

/// A deterministic monogram avatar: initials over a per-name accent color.
/// Same hash + palette as the web's `monogramColor`/`initials`
/// (`frontend/src/components/profile/shared.ts`), so a player's avatar color
/// is stable across platforms, not just within one session.
struct Avatar: View {
    let name: String
    var size: CGFloat = 56

    var body: some View {
        let color = Avatar.color(for: name)
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [color, color.opacity(0.75)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .frame(width: size, height: size)
            .overlay(
                Text(Avatar.initials(for: name))
                    .font(.system(size: size * 0.38, weight: .bold, design: .default))
                    .foregroundStyle(.white)
            )
            .shadow(color: color.opacity(0.25), radius: 8, y: 4)
    }

    // MARK: - Deterministic identity

    private static let palette: [Color] = [
        Color(red: 0x5e / 255.0, green: 0x84 / 255.0, blue: 0xc0 / 255.0),
        Color(red: 0x6f / 255.0, green: 0x9e / 255.0, blue: 0x54 / 255.0),
        Color(red: 0xd8 / 255.0, green: 0xa6 / 255.0, blue: 0x57 / 255.0),
        Color(red: 0xe0 / 255.0, green: 0x84 / 255.0, blue: 0x4a / 255.0),
        Color(red: 0xb0 / 255.0, green: 0x6f / 255.0, blue: 0xb0 / 255.0),
        Color(red: 0x4a / 255.0, green: 0xa7 / 255.0, blue: 0xa0 / 255.0),
    ]

    static func color(for name: String) -> Color {
        var hash: UInt32 = 0
        for scalar in name.unicodeScalars {
            hash = hash &* 31 &+ scalar.value
        }
        return palette[Int(hash % UInt32(palette.count))]
    }

    static func initials(for name: String) -> String {
        let parts = name
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: " ", omittingEmptySubsequences: true)
        if parts.count >= 2, let first = parts[0].first, let second = parts[1].first {
            return String([first, second]).uppercased()
        }
        return String(name.prefix(2)).uppercased()
    }
}

#Preview {
    HStack(spacing: 16) {
        Avatar(name: "Ada Lovelace")
        Avatar(name: "Bobby Fischer", size: 72)
        Avatar(name: "X", size: 40)
    }
    .padding()
    .background(Theme.Colors.background)
}
