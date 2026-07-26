import SwiftUI

/// The preset grid (12 standard time controls in one dense 3-column grid,
/// speed shown as a small glyph+label inside each cell — matching the web's
/// layout) plus the three fixed variant pools. Tapping any cell queues
/// immediately and opens `SearchingSheet` — there's no separate "confirm"
/// step, matching the web's one-tap queue.
struct QuickPairingPanel: View {
    @Environment(SocketStore.self) private var socket
    @Environment(AuthStore.self) private var authStore

    @State private var isSearching = false

    private let columns = [
        GridItem(.flexible(), spacing: Theme.Spacing.sm),
        GridItem(.flexible(), spacing: Theme.Spacing.sm),
        GridItem(.flexible(), spacing: Theme.Spacing.sm),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            HomeSectionHeader(title: "Quick pairing", subtitle: "Get matched with a player of similar strength")

            LazyVGrid(columns: columns, spacing: Theme.Spacing.sm) {
                ForEach(TimeControlPreset.standard) { preset in
                    presetCell(preset)
                }
            }

            variantSection
        }
        .sheet(isPresented: $isSearching) {
            SearchingSheet(socket: socket)
        }
    }

    private var variantSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Variants")
                .font(Theme.headline(14))
                .foregroundStyle(Theme.Colors.secondaryText)

            HStack(spacing: Theme.Spacing.sm) {
                ForEach(VariantPool.all) { pool in
                    variantCell(pool)
                }
            }
        }
    }

    // MARK: - Cells

    private func presetCell(_ preset: TimeControlPreset) -> some View {
        Button {
            queue(pool: preset.pool, variant: "standard")
        } label: {
            VStack(spacing: 2) {
                Text(preset.pool)
                    .font(Theme.headline(18))
                    .foregroundStyle(Theme.Colors.primaryText)
                HStack(spacing: 4) {
                    Image(systemName: preset.category.systemImage)
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.Colors.secondaryText)
                    Text(preset.category.label)
                        .font(Theme.caption(11))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
                if let hint = eloHint(for: preset.category) {
                    Text(hint)
                        .font(Theme.caption(11))
                        .foregroundStyle(Theme.Colors.secondaryText)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: HomeMetrics.minTapTarget)
            .padding(Theme.Spacing.sm)
        }
        .buttonStyle(.plain)
        .glassed(in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(preset.category.label) \(preset.pool)")
        .accessibilityAddTraits(.isButton)
    }

    private func variantCell(_ pool: VariantPool) -> some View {
        Button {
            queue(pool: pool.pool, variant: pool.variant.rawValue)
        } label: {
            VStack(spacing: 4) {
                Image(systemName: pool.systemImage)
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.Colors.accent)
                Text(pool.variant.displayName)
                    .font(Theme.caption(12))
                    .foregroundStyle(Theme.Colors.primaryText)
                Text(pool.pool)
                    .font(Theme.caption(11))
                    .foregroundStyle(Theme.Colors.secondaryText)
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: HomeMetrics.minTapTarget)
            .padding(.vertical, Theme.Spacing.sm)
        }
        .buttonStyle(.plain)
        .glassed(in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous))
        .accessibilityLabel(pool.variant.displayName)
        .accessibilityAddTraits(.isButton)
    }

    // MARK: - Actions

    private func queue(pool: String, variant: String) {
        socket.queue(pool: pool, variant: variant)
        isSearching = true
    }

    private func eloHint(for category: TimeControlCategory) -> String? {
        guard let user = authStore.user else { return nil }
        return TimeControlPreset.eloRangeHint(rating: user.rating(for: category.ratingCategory))
    }
}

#Preview("QuickPairingPanel — guest") {
    ScrollView {
        QuickPairingPanel()
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.Colors.background)
    .environment(SocketStore())
    .environment(AuthStore.preview())
}

#Preview("QuickPairingPanel — signed in") {
    ScrollView {
        QuickPairingPanel()
            .padding(Theme.Spacing.lg)
    }
    .background(Theme.Colors.background)
    .environment(SocketStore())
    .environment(AuthStore.preview(user: .quickPairingPreviewStub))
}

private extension User {
    /// Decoded (not memberwise-initialized, per SPEC.md's `@Default`
    /// construction gotcha) so every other rating field falls back to its
    /// normal decode default.
    static let quickPairingPreviewStub: User = {
        let json = Data("""
        {"id":"preview","name":"Ada Lovelace","email":"ada@example.com",
         "rating_bullet":1180,"rating_blitz":1450,"rating_rapid":1502,"rating_classical":1610}
        """.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(User.self, from: json)
    }()
}
