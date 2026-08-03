//
//  BoardTheme.swift
//  chessgo
//
//  The board palette + piece set catalog, ported 1:1 from the web client
//  (`frontend/src/lib/boardTheme.ts`) so a player's board looks the same on
//  both clients. Sixteen board themes, seven piece sets, same labels, same
//  colors, same picker order.
//
//  Two things differ from the web on purpose:
//
//   - These colors are ABSOLUTE, not light/dark-dynamic like `Theme.Colors`.
//     A board theme IS the palette; it must not shift when the phone flips to
//     dark mode, exactly as on the web.
//   - Selection lives in `SettingsStore` (`boardTheme` / `pieceSet`) instead of
//     its own store, and `BoardView`/`PieceView` read it from the environment,
//     so every board in the app — game, analysis, puzzles, spectate, the home
//     mini-boards — follows the choice with no per-call-site wiring.
//
//  Defaults are Amethyst + Neo (see `SettingsStore.Snapshot.defaults`).
//

import SwiftUI

/// What paints a square: a flat color, or a photographic texture asset — the
/// Cherry theme's two woods, the one case the web serves as an image too.
enum BoardFace: Equatable {
    case color(Color)
    /// Asset-catalog name; drawn scaled-to-fill per square (web: `cover`).
    case texture(String)
}

/// Every board-facing color of one theme. Named after the web CSS variables it
/// mirrors so the two catalogs stay diff-able.
struct BoardPalette {
    let light: BoardFace
    let dark: BoardFace
    /// Behind the squares — visible as the board's frame/rounded edge.
    let frame: Color
    /// From/to tint of the most recent move.
    let lastMove: Color
    /// Tint of the square you have selected.
    let select: Color
    /// Legal-move marker on a DARK square, and on a light one.
    let dot: Color
    let dotLight: Color
    /// King-in-check glow.
    let check: Color
    /// Coordinate ink, tinted per square shade so it reads on its own square.
    let coordOnLight: Color
    let coordOnDark: Color
    /// Per-square hairline gridline. `nil` for themes without one.
    let border: Color?

    /// The paint for a square of the given shade.
    func face(light isLight: Bool) -> BoardFace { isLight ? light : dark }

    /// Legal-move marker color for a square of the given shade.
    func dot(light isLight: Bool) -> Color { isLight ? dotLight : dot }

    /// Coordinate ink for a square of the given shade.
    func coord(light isLight: Bool) -> Color { isLight ? coordOnLight : coordOnDark }
}

/// One square's paint as a view — flat color or texture. Textures are square
/// like the cells they fill, so scaled-to-fill can't bleed into a neighbour.
/// Used by the board and by the settings swatches, so both stay in step.
struct BoardSquareFace: View {
    let face: BoardFace

    var body: some View {
        switch face {
        case .color(let color):
            color
        case .texture(let name):
            Image(name)
                .resizable()
                .aspectRatio(contentMode: .fill)
        }
    }
}

/// `0xRRGGBB` + alpha → `Color`, in sRGB. Board colors are literal hex values
/// copied from the web themes, so this is the only constructor used below.
private func hex(_ value: UInt32, _ alpha: Double = 1) -> Color {
    Color(
        .sRGB,
        red: Double((value >> 16) & 0xFF) / 255,
        green: Double((value >> 8) & 0xFF) / 255,
        blue: Double(value & 0xFF) / 255,
        opacity: alpha
    )
}

/// The board themes. Declaration order IS the picker order (web `BOARD_ORDER`):
/// woods and Amethyst lead, then blues/neutrals, then marble/cool tones, then
/// the warm/dark/playful picks. The default is `.amethyst`, independent of this
/// order.
enum BoardThemeID: String, CaseIterable, Codable, Identifiable, Sendable {
    case cherry
    case wood
    case forest
    case amethyst
    case ocean
    case walnut
    case slate
    case marble
    case carrara
    case lagoon
    case ice
    case newsprint
    case coral
    case midnight
    case onyx
    case bubblegum

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cherry: "Cherry"
        case .wood: "Wood"
        case .forest: "Forest"
        case .amethyst: "Amethyst"
        case .ocean: "Ocean"
        case .walnut: "Walnut"
        case .slate: "Slate"
        case .marble: "Marble"
        case .carrara: "Carrara"
        case .lagoon: "Lagoon"
        case .ice: "Ice"
        case .newsprint: "Newsprint"
        case .coral: "Coral"
        case .midnight: "Midnight"
        case .onyx: "Onyx"
        case .bubblegum: "Bubblegum"
        }
    }

    var palette: BoardPalette {
        switch self {
        // Photographic wood: light bamboo on light squares, cherry-stained on dark.
        case .cherry:
            BoardPalette(
                light: .texture("board_wood_light"),
                dark: .texture("board_wood_cherry"),
                frame: hex(0x3A2114),
                lastMove: hex(0xE6CD64, 0.5),
                select: hex(0xE6CD64, 0.62),
                dot: hex(0x28160C, 0.34),
                dotLight: hex(0x28160C, 0.28),
                check: hex(0xD24242, 0.72),
                coordOnLight: hex(0x7A5230),
                coordOnDark: hex(0xF2E2C8),
                border: nil
            )
        case .wood:
            BoardPalette(
                light: .color(hex(0xF0D9B5)),
                dark: .color(hex(0xB58863)),
                frame: hex(0x3A2C1E),
                lastMove: hex(0xCDD26A, 0.6),
                select: hex(0xCDD26A, 0.7),
                dot: hex(0x3C2816, 0.3),
                dotLight: hex(0x3C2816, 0.22),
                check: hex(0xCA4A4A, 0.7),
                coordOnLight: hex(0xB58863),
                coordOnDark: hex(0xF0D9B5),
                border: nil
            )
        case .forest:
            BoardPalette(
                light: .color(hex(0xEBECD0)),
                dark: .color(hex(0x779556)),
                frame: hex(0x2F3B26),
                lastMove: hex(0xF5F682, 0.55),
                select: hex(0xF5F682, 0.66),
                dot: hex(0x28361E, 0.3),
                dotLight: hex(0x28361E, 0.2),
                check: hex(0xCA4A4A, 0.7),
                coordOnLight: hex(0x779556),
                coordOnDark: hex(0xEBECD0),
                border: nil
            )
        case .amethyst:
            BoardPalette(
                light: .color(hex(0xEFE7FB)),
                dark: .color(hex(0x9F7BBF)),
                frame: hex(0x2A2136),
                lastMove: hex(0xE2B278, 0.55),
                select: hex(0xE2B278, 0.66),
                dot: hex(0x38264E, 0.3),
                dotLight: hex(0x38264E, 0.2),
                check: hex(0xD64A60, 0.7),
                coordOnLight: hex(0x9F7BBF),
                coordOnDark: hex(0xEFE7FB),
                border: nil
            )
        case .ocean:
            BoardPalette(
                light: .color(hex(0xDBE6EF)),
                dark: .color(hex(0x5B82A8)),
                frame: hex(0x1D2A37),
                lastMove: hex(0xF6E878, 0.5),
                select: hex(0xF6E878, 0.62),
                dot: hex(0x162A3E, 0.3),
                dotLight: hex(0x162A3E, 0.22),
                check: hex(0xCC4C4C, 0.7),
                coordOnLight: hex(0x5B82A8),
                coordOnDark: hex(0xDBE6EF),
                border: nil
            )
        // Rich, dark reddish hardwood — deeper and warmer than Wood.
        case .walnut:
            BoardPalette(
                light: .color(hex(0xD8B48A)),
                dark: .color(hex(0x8A5A34)),
                frame: hex(0x3A2415),
                lastMove: hex(0xDED06C, 0.55),
                select: hex(0xDED06C, 0.66),
                dot: hex(0x3A2212, 0.32),
                dotLight: hex(0x3A2212, 0.24),
                check: hex(0xCA4A4A, 0.72),
                coordOnLight: hex(0x8A5A34),
                coordOnDark: hex(0xD8B48A),
                border: nil
            )
        case .slate:
            BoardPalette(
                light: .color(hex(0xDDE2E6)),
                dark: .color(hex(0x8198A6)),
                frame: hex(0x0E0F13),
                lastMove: hex(0xBCCB80, 0.62),
                select: hex(0xAEC46E, 0.72),
                dot: hex(0x283640, 0.3),
                dotLight: hex(0x283640, 0.22),
                check: hex(0xCA4A4A, 0.66),
                coordOnLight: hex(0x6F828F),
                coordOnDark: hex(0xE4EAEF),
                border: nil
            )
        // Cool neutral grey — the gridline is what reads as marble tile.
        case .marble:
            BoardPalette(
                light: .color(hex(0xECEEF0)),
                dark: .color(hex(0xA2ADB6)),
                frame: hex(0x2B3138),
                lastMove: hex(0xD6CC78, 0.55),
                select: hex(0xD6CC78, 0.66),
                dot: hex(0x2C343C, 0.3),
                dotLight: hex(0x2C343C, 0.2),
                check: hex(0xCA4A4A, 0.68),
                coordOnLight: hex(0x8B97A1),
                coordOnDark: hex(0x5B6772),
                border: hex(0x46525E, 0.4)
            )
        // White/warm-grey marble — the veining gridline is the point.
        case .carrara:
            BoardPalette(
                light: .color(hex(0xF1EFE9)),
                dark: .color(hex(0xC3BDB0)),
                frame: hex(0x34302A),
                lastMove: hex(0xD4C874, 0.55),
                select: hex(0xD4C874, 0.66),
                dot: hex(0x3C362C, 0.3),
                dotLight: hex(0x3C362C, 0.2),
                check: hex(0xC84A4A, 0.68),
                coordOnLight: hex(0xA49C8B),
                coordOnDark: hex(0x6B6355),
                border: hex(0x786E5C, 0.34)
            )
        case .lagoon:
            BoardPalette(
                light: .color(hex(0xD8ECE8)),
                dark: .color(hex(0x4F9A8F)),
                frame: hex(0x173430),
                lastMove: hex(0xF0E078, 0.5),
                select: hex(0xF0E078, 0.62),
                dot: hex(0x123430, 0.3),
                dotLight: hex(0x123430, 0.2),
                check: hex(0xCA4A4A, 0.7),
                coordOnLight: hex(0x4F9A8F),
                coordOnDark: hex(0xD8ECE8),
                border: nil
            )
        // Pale steel blue with low light/dark contrast — the subtle gridline is
        // what gives the squares definition.
        case .ice:
            BoardPalette(
                light: .color(hex(0xEEF3F8)),
                dark: .color(hex(0xC4D2DF)),
                frame: hex(0x3B4855),
                lastMove: hex(0xE2D078, 0.5),
                select: hex(0xE2D078, 0.62),
                dot: hex(0x3C5064, 0.3),
                dotLight: hex(0x3C5064, 0.2),
                check: hex(0xCE5050, 0.66),
                coordOnLight: hex(0x93A4B5),
                coordOnDark: hex(0x5C6E80),
                border: hex(0x587088, 0.38)
            )
        // Monochrome print look — the stronger gridline is the point.
        case .newsprint:
            BoardPalette(
                light: .color(hex(0xF2F2F0)),
                dark: .color(hex(0xB9B9B4)),
                frame: hex(0x26262A),
                lastMove: hex(0xE0CE70, 0.5),
                select: hex(0xE0CE70, 0.62),
                dot: hex(0x282828, 0.32),
                dotLight: hex(0x282828, 0.24),
                check: hex(0xC64646, 0.66),
                coordOnLight: hex(0x8F8F8A),
                coordOnDark: hex(0x5C5C58),
                border: hex(0x3C3C3A, 0.5)
            )
        case .coral:
            BoardPalette(
                light: .color(hex(0xF7E6E2)),
                dark: .color(hex(0xCD8B8A)),
                frame: hex(0x3A2528),
                lastMove: hex(0xEBC66C, 0.55),
                select: hex(0xEBC66C, 0.66),
                dot: hex(0x4A2828, 0.3),
                dotLight: hex(0x4A2828, 0.22),
                check: hex(0xC64052, 0.7),
                coordOnLight: hex(0xCD8B8A),
                coordOnDark: hex(0xF7E6E2),
                border: nil
            )
        // Dark board: both squares deep navy, dots/coords go light.
        case .midnight:
            BoardPalette(
                light: .color(hex(0x5C6B83)),
                dark: .color(hex(0x374357)),
                frame: hex(0x10141C),
                lastMove: hex(0xE8D278, 0.42),
                select: hex(0xE8D278, 0.55),
                dot: hex(0xC8D4E6, 0.34),
                dotLight: hex(0xC8D4E6, 0.28),
                check: hex(0xE25C5C, 0.72),
                coordOnLight: hex(0x2C3648),
                coordOnDark: hex(0x8698B2),
                border: nil
            )
        // Dark polished stone — near-black board with pale marble veins.
        case .onyx:
            BoardPalette(
                light: .color(hex(0x5B5652)),
                dark: .color(hex(0x3B3733)),
                frame: hex(0x171512),
                lastMove: hex(0xE2D078, 0.42),
                select: hex(0xE2D078, 0.55),
                dot: hex(0xD4CEC4, 0.32),
                dotLight: hex(0xD4CEC4, 0.26),
                check: hex(0xE25C5C, 0.72),
                coordOnLight: hex(0x2C2925),
                coordOnDark: hex(0x8F887E),
                border: hex(0x968F85, 0.28)
            )
        // Teal highlight against a pink board — playful contrast.
        case .bubblegum:
            BoardPalette(
                light: .color(hex(0xF6E2EE)),
                dark: .color(hex(0xD087B0)),
                frame: hex(0x3A2233),
                lastMove: hex(0x78D0C6, 0.55),
                select: hex(0x78D0C6, 0.66),
                dot: hex(0x4A223C, 0.3),
                dotLight: hex(0x4A223C, 0.2),
                check: hex(0xD64A60, 0.72),
                coordOnLight: hex(0xD087B0),
                coordOnDark: hex(0xF6E2EE),
                border: nil
            )
        }
    }
}

/// The piece sets. Artwork lives in `Assets.xcassets` as `<set>_<code>` (e.g.
/// `neo_wK`) — the web's vector sets rasterized at 384px, plus Neo's own 300px
/// sprites. Declaration order IS the picker order. Default is `.neo`.
enum PieceSetID: String, CaseIterable, Codable, Identifiable, Sendable {
    case cburnett
    case merida
    case chessnut
    case fantasy
    case neo
    case letters
    case circles

    var id: String { rawValue }

    var label: String {
        switch self {
        case .cburnett: "Cburnett"
        case .merida: "Merida"
        case .chessnut: "Chessnut"
        case .fantasy: "Fantasy"
        case .neo: "Neo"
        case .letters: "Letters"
        case .circles: "Circles"
        }
    }

    /// Attribution + license, shown under the option in the picker (same
    /// strings the web picker shows, and the CREDITS files record).
    var credit: String {
        switch self {
        case .cburnett: "Colin M.L. Burnett · GPLv2+"
        case .merida: "Armando H. Marroquin · GPLv2+"
        case .chessnut: "Alexis Luengas · Apache 2.0"
        case .fantasy: "Maurizio Monge · MIT"
        case .neo: "Neo · 300px raster set"
        case .letters: "chessgo original · CC0"
        case .circles: "chessgo original · CC0 — self-handicap"
        }
    }

    /// Asset-catalog name for one piece in this set.
    func assetName(for piece: Piece) -> String {
        let color = piece.color == .white ? "w" : "b"
        return "\(rawValue)_\(color)\(piece.kind.fenLetter)"
    }
}
