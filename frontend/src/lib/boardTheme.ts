// Appearance store: board color theme + piece set. A device-local preference
// (localStorage), so it needs no account and survives navigation. Lives outside
// React like the auth/socket stores; components read it via the hooks below
// (useSyncExternalStore).
//
// Board colors are plain CSS custom properties (see styles.css :root). A theme is
// just an override map applied inline on <html>, so EVERY board render — the main
// Board, MiniBoard, home cards — repaints for free with no per-component change.
// The piece set is a directory swap under /public/piece; pieceImageUrl() reads the
// active set, and Board/MiniBoard subscribe so a change re-renders them.
import { useSyncExternalStore } from 'react'

export type BoardThemeId =
    | 'default'
    | 'brown'
    | 'green'
    | 'purple'
    | 'ocean'
    | 'ice'
    | 'lagoon'
    | 'coral'
    | 'bubblegum'
    | 'marble'
    | 'midnight'
    | 'newsprint'
    | 'walnut'
    | 'cherry'
    | 'carrara'
    | 'onyx'
export type PieceSetId =
    | 'cburnett'
    | 'merida'
    | 'chessnut'
    | 'fantasy'
    | 'letters'
    | 'circles'

export interface BoardTheme {
    id: BoardThemeId
    label: string
    /** CSS custom properties applied to <html> for this theme. Every board-facing
     * variable is set explicitly (including for `default`) so switching themes is a
     * uniform overwrite, never a partial one that leaks the previous theme. This
     * includes `--board-border-color` — themes without gridlines set it to
     * `transparent` so switching away from a bordered theme fully clears the ring. */
    vars: Record<string, string>
}

export interface PieceSet {
    id: PieceSetId
    label: string
    /** Attribution + license, shown in the picker and kept for the CREDITS files. */
    credit: string
}

// --- Board themes -----------------------------------------------------------
// Each theme sets the full board palette. Coord colors follow the Lichess
// convention: a coordinate is drawn in the color of the OPPOSITE square, so it
// reads against its own background.

// The full palette catalog (definition order is irrelevant — the picker renders
// BOARD_THEMES below, which is this catalog resorted into popularity order).
const BOARD_THEME_CATALOG: BoardTheme[] = [
    {
        id: 'default',
        label: 'Slate',
        vars: {
            '--board-light': '#dde2e6',
            '--board-dark': '#8198a6',
            '--board-frame': '#0e0f13',
            '--last-move': 'rgba(188, 203, 128, 0.62)',
            '--select': 'rgba(174, 196, 110, 0.72)',
            '--dot': 'rgba(40, 54, 64, 0.3)',
            '--dot-light': 'rgba(40, 54, 64, 0.22)',
            '--check': 'rgba(202, 74, 74, 0.66)',
            '--coord-on-light': '#6f828f',
            '--coord-on-dark': '#e4eaef',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'brown',
        label: 'Wood',
        vars: {
            '--board-light': '#f0d9b5',
            '--board-dark': '#b58863',
            '--board-frame': '#3a2c1e',
            '--last-move': 'rgba(205, 210, 106, 0.6)',
            '--select': 'rgba(205, 210, 106, 0.7)',
            '--dot': 'rgba(60, 40, 22, 0.3)',
            '--dot-light': 'rgba(60, 40, 22, 0.22)',
            '--check': 'rgba(202, 74, 74, 0.7)',
            '--coord-on-light': '#b58863',
            '--coord-on-dark': '#f0d9b5',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'green',
        label: 'Forest',
        vars: {
            '--board-light': '#ebecd0',
            '--board-dark': '#779556',
            '--board-frame': '#2f3b26',
            '--last-move': 'rgba(245, 246, 130, 0.55)',
            '--select': 'rgba(245, 246, 130, 0.66)',
            '--dot': 'rgba(40, 54, 30, 0.3)',
            '--dot-light': 'rgba(40, 54, 30, 0.2)',
            '--check': 'rgba(202, 74, 74, 0.7)',
            '--coord-on-light': '#779556',
            '--coord-on-dark': '#ebecd0',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'purple',
        label: 'Amethyst',
        vars: {
            '--board-light': '#efe7fb',
            '--board-dark': '#9f7bbf',
            '--board-frame': '#2a2136',
            '--last-move': 'rgba(226, 178, 120, 0.55)',
            '--select': 'rgba(226, 178, 120, 0.66)',
            '--dot': 'rgba(56, 38, 78, 0.3)',
            '--dot-light': 'rgba(56, 38, 78, 0.2)',
            '--check': 'rgba(214, 74, 96, 0.7)',
            '--coord-on-light': '#9f7bbf',
            '--coord-on-dark': '#efe7fb',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'ocean',
        label: 'Ocean',
        vars: {
            '--board-light': '#dbe6ef',
            '--board-dark': '#5b82a8',
            '--board-frame': '#1d2a37',
            '--last-move': 'rgba(246, 232, 120, 0.5)',
            '--select': 'rgba(246, 232, 120, 0.62)',
            '--dot': 'rgba(22, 42, 62, 0.3)',
            '--dot-light': 'rgba(22, 42, 62, 0.22)',
            '--check': 'rgba(204, 76, 76, 0.7)',
            '--coord-on-light': '#5b82a8',
            '--coord-on-dark': '#dbe6ef',
            '--board-border-color': 'transparent',
        },
    },
    {
        // Pale steel blue with low light/dark contrast — the subtle gridline
        // border is what gives the squares definition.
        id: 'ice',
        label: 'Ice',
        vars: {
            '--board-light': '#eef3f8',
            '--board-dark': '#c4d2df',
            '--board-frame': '#3b4855',
            '--last-move': 'rgba(226, 208, 120, 0.5)',
            '--select': 'rgba(226, 208, 120, 0.62)',
            '--dot': 'rgba(60, 80, 100, 0.3)',
            '--dot-light': 'rgba(60, 80, 100, 0.2)',
            '--check': 'rgba(206, 80, 80, 0.66)',
            '--coord-on-light': '#93a4b5',
            '--coord-on-dark': '#5c6e80',
            '--board-border-color': 'rgba(88, 112, 136, 0.38)',
        },
    },
    {
        id: 'lagoon',
        label: 'Lagoon',
        vars: {
            '--board-light': '#d8ece8',
            '--board-dark': '#4f9a8f',
            '--board-frame': '#173430',
            '--last-move': 'rgba(240, 224, 120, 0.5)',
            '--select': 'rgba(240, 224, 120, 0.62)',
            '--dot': 'rgba(18, 52, 48, 0.3)',
            '--dot-light': 'rgba(18, 52, 48, 0.2)',
            '--check': 'rgba(202, 74, 74, 0.7)',
            '--coord-on-light': '#4f9a8f',
            '--coord-on-dark': '#d8ece8',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'coral',
        label: 'Coral',
        vars: {
            '--board-light': '#f7e6e2',
            '--board-dark': '#cd8b8a',
            '--board-frame': '#3a2528',
            '--last-move': 'rgba(235, 198, 108, 0.55)',
            '--select': 'rgba(235, 198, 108, 0.66)',
            '--dot': 'rgba(74, 40, 40, 0.3)',
            '--dot-light': 'rgba(74, 40, 40, 0.22)',
            '--check': 'rgba(198, 64, 82, 0.7)',
            '--coord-on-light': '#cd8b8a',
            '--coord-on-dark': '#f7e6e2',
            '--board-border-color': 'transparent',
        },
    },
    {
        id: 'bubblegum',
        label: 'Bubblegum',
        vars: {
            '--board-light': '#f6e2ee',
            '--board-dark': '#d087b0',
            '--board-frame': '#3a2233',
            // Teal highlight against the pink board — playful contrast.
            '--last-move': 'rgba(120, 208, 198, 0.55)',
            '--select': 'rgba(120, 208, 198, 0.66)',
            '--dot': 'rgba(74, 34, 60, 0.3)',
            '--dot-light': 'rgba(74, 34, 60, 0.2)',
            '--check': 'rgba(214, 74, 96, 0.72)',
            '--coord-on-light': '#d087b0',
            '--coord-on-dark': '#f6e2ee',
            '--board-border-color': 'transparent',
        },
    },
    {
        // Cool neutral grey — gridline borders read as a marble tile look.
        id: 'marble',
        label: 'Marble',
        vars: {
            '--board-light': '#eceef0',
            '--board-dark': '#a2adb6',
            '--board-frame': '#2b3138',
            '--last-move': 'rgba(214, 204, 120, 0.55)',
            '--select': 'rgba(214, 204, 120, 0.66)',
            '--dot': 'rgba(44, 52, 60, 0.3)',
            '--dot-light': 'rgba(44, 52, 60, 0.2)',
            '--check': 'rgba(202, 74, 74, 0.68)',
            '--coord-on-light': '#8b97a1',
            '--coord-on-dark': '#5b6772',
            '--board-border-color': 'rgba(70, 82, 94, 0.4)',
        },
    },
    {
        // Dark-mode board: both squares are deep navy, dots/coords go light.
        id: 'midnight',
        label: 'Midnight',
        vars: {
            '--board-light': '#5c6b83',
            '--board-dark': '#374357',
            '--board-frame': '#10141c',
            '--last-move': 'rgba(232, 210, 120, 0.42)',
            '--select': 'rgba(232, 210, 120, 0.55)',
            '--dot': 'rgba(200, 212, 230, 0.34)',
            '--dot-light': 'rgba(200, 212, 230, 0.28)',
            '--check': 'rgba(226, 92, 92, 0.72)',
            '--coord-on-light': '#2c3648',
            '--coord-on-dark': '#8698b2',
            '--board-border-color': 'transparent',
        },
    },
    {
        // Monochrome print look — the stronger gridline is the point.
        id: 'newsprint',
        label: 'Newsprint',
        vars: {
            '--board-light': '#f2f2f0',
            '--board-dark': '#b9b9b4',
            '--board-frame': '#26262a',
            '--last-move': 'rgba(224, 206, 112, 0.5)',
            '--select': 'rgba(224, 206, 112, 0.62)',
            '--dot': 'rgba(40, 40, 40, 0.32)',
            '--dot-light': 'rgba(40, 40, 40, 0.24)',
            '--check': 'rgba(198, 70, 70, 0.66)',
            '--coord-on-light': '#8f8f8a',
            '--coord-on-dark': '#5c5c58',
            '--board-border-color': 'rgba(60, 60, 58, 0.5)',
        },
    },
    {
        // Rich, dark reddish hardwood — deeper and warmer than Wood.
        id: 'walnut',
        label: 'Walnut',
        vars: {
            '--board-light': '#d8b48a',
            '--board-dark': '#8a5a34',
            '--board-frame': '#3a2415',
            '--last-move': 'rgba(222, 208, 108, 0.55)',
            '--select': 'rgba(222, 208, 108, 0.66)',
            '--dot': 'rgba(58, 34, 18, 0.32)',
            '--dot-light': 'rgba(58, 34, 18, 0.24)',
            '--check': 'rgba(202, 74, 74, 0.72)',
            '--coord-on-light': '#8a5a34',
            '--coord-on-dark': '#d8b48a',
            '--board-border-color': 'transparent',
        },
    },
    {
        // Photographic wood: light bamboo on light squares, cherry-stained on dark.
        // Here --board-light/--board-dark are image URLs (served from /public/board)
        // rather than colors; Board.css/MiniBoard paint them with background-size:
        // cover. The remaining values are tuned to read against the two woods.
        id: 'cherry',
        label: 'Cherry',
        vars: {
            '--board-light': 'url("/board/wood_light.png")',
            '--board-dark': 'url("/board/wood_cherry.png")',
            '--board-frame': '#3a2114',
            '--last-move': 'rgba(230, 205, 100, 0.5)',
            '--select': 'rgba(230, 205, 100, 0.62)',
            '--dot': 'rgba(40, 22, 12, 0.34)',
            '--dot-light': 'rgba(40, 22, 12, 0.28)',
            '--check': 'rgba(210, 66, 66, 0.72)',
            '--coord-on-light': '#7a5230',
            '--coord-on-dark': '#f2e2c8',
            '--board-border-color': 'transparent',
        },
    },
    {
        // White/warm-grey marble — the veining gridline is the point.
        id: 'carrara',
        label: 'Carrara',
        vars: {
            '--board-light': '#f1efe9',
            '--board-dark': '#c3bdb0',
            '--board-frame': '#34302a',
            '--last-move': 'rgba(212, 200, 116, 0.55)',
            '--select': 'rgba(212, 200, 116, 0.66)',
            '--dot': 'rgba(60, 54, 44, 0.3)',
            '--dot-light': 'rgba(60, 54, 44, 0.2)',
            '--check': 'rgba(200, 74, 74, 0.68)',
            '--coord-on-light': '#a49c8b',
            '--coord-on-dark': '#6b6355',
            '--board-border-color': 'rgba(120, 110, 92, 0.34)',
        },
    },
    {
        // Dark polished stone — near-black board with pale marble veins.
        id: 'onyx',
        label: 'Onyx',
        vars: {
            '--board-light': '#5b5652',
            '--board-dark': '#3b3733',
            '--board-frame': '#171512',
            '--last-move': 'rgba(226, 208, 120, 0.42)',
            '--select': 'rgba(226, 208, 120, 0.55)',
            '--dot': 'rgba(212, 206, 196, 0.32)',
            '--dot-light': 'rgba(212, 206, 196, 0.26)',
            '--check': 'rgba(226, 92, 92, 0.72)',
            '--coord-on-light': '#2c2925',
            '--coord-on-dark': '#8f887e',
            '--board-border-color': 'rgba(150, 143, 133, 0.28)',
        },
    },
]

// Picker display order, roughly by perceived popularity — one row (band) per tier:
// woods and Amethyst lead, then blues/greys, then cool tones, then the playful/niche
// picks. This drives ONLY the on-screen order; the new-user default stays
// DEFAULT_BOARD regardless of what sits first here (see boardById).
const BOARD_ORDER: BoardThemeId[] = [
    'cherry', 'brown', 'green', 'purple', // wood default + classic favorites
    'ocean', 'walnut', 'default', 'marble', // blues + woods + clean neutrals
    'carrara', 'lagoon', 'ice', 'newsprint', // marble + cool tones
    'coral', 'midnight', 'onyx', 'bubblegum', // warm / dark / playful
]

export const BOARD_THEMES: BoardTheme[] = BOARD_ORDER.map(
    (id) => BOARD_THEME_CATALOG.find((t) => t.id === id)!,
)

// --- Piece sets -------------------------------------------------------------
// SVGs live in /public/piece/<id>/{w,b}{K,Q,R,B,N,P}.svg. Sets vendored from the
// Lichess (lila) repo; only commercial-friendly licenses are shipped.

export const PIECE_SETS: PieceSet[] = [
    { id: 'cburnett', label: 'Cburnett', credit: 'Colin M.L. Burnett · GPLv2+' },
    { id: 'merida', label: 'Merida', credit: 'Armando H. Marroquin · GPLv2+' },
    { id: 'chessnut', label: 'Chessnut', credit: 'Alexis Luengas · Apache 2.0' },
    { id: 'fantasy', label: 'Fantasy', credit: 'Maurizio Monge · MIT' },
    { id: 'letters', label: 'Letters', credit: 'chessgo original · CC0' },
    { id: 'circles', label: 'Circles', credit: 'chessgo original · CC0 — self-handicap' },
]

const DEFAULT_BOARD: BoardThemeId = 'cherry'
const DEFAULT_PIECES: PieceSetId = 'cburnett'
const LS_BOARD = 'chessgo.board'
const LS_PIECES = 'chessgo.pieces'

const boardById = (id: string | null): BoardTheme =>
    BOARD_THEMES.find((t) => t.id === id) ??
    BOARD_THEMES.find((t) => t.id === DEFAULT_BOARD)!
const isPieceSet = (id: string | null): id is PieceSetId =>
    PIECE_SETS.some((p) => p.id === id)

interface ThemeState {
    board: BoardThemeId
    pieces: PieceSetId
}

class ThemeStore {
    private state: ThemeState = { board: DEFAULT_BOARD, pieces: DEFAULT_PIECES }
    private listeners = new Set<() => void>()

    /** Read persisted prefs and paint the board palette onto <html>. Call once,
     * synchronously, before first render (main.tsx) to avoid a theme flash. */
    init(): void {
        try {
            const b = localStorage.getItem(LS_BOARD)
            const p = localStorage.getItem(LS_PIECES)
            this.state = {
                board: boardById(b).id,
                pieces: isPieceSet(p) ? p : DEFAULT_PIECES,
            }
        } catch {
            // localStorage may be unavailable (private mode / SSR) — keep defaults.
        }
        this.applyBoardVars()
    }

    getSnapshot = (): ThemeState => this.state
    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    getPieceSet = (): PieceSetId => this.state.pieces

    setBoard(id: BoardThemeId): void {
        if (this.state.board === id) return
        this.state = { ...this.state, board: boardById(id).id }
        this.persist(LS_BOARD, this.state.board)
        this.applyBoardVars()
        this.emit()
    }

    setPieces(id: PieceSetId): void {
        if (!isPieceSet(id) || this.state.pieces === id) return
        this.state = { ...this.state, pieces: id }
        this.persist(LS_PIECES, id)
        this.emit()
    }

    /** Restore the default board theme + piece set (used by the Settings dialog's
     * "Reset to defaults"). Same shape as the setters: persist, repaint, emit. */
    reset(): void {
        this.state = { board: DEFAULT_BOARD, pieces: DEFAULT_PIECES }
        this.persist(LS_BOARD, this.state.board)
        this.persist(LS_PIECES, this.state.pieces)
        this.applyBoardVars()
        this.emit()
    }

    private applyBoardVars(): void {
        if (typeof document === 'undefined') return
        const { vars } = boardById(this.state.board)
        const root = document.documentElement
        for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    }

    private persist(key: string, value: string): void {
        try {
            localStorage.setItem(key, value)
        } catch {
            // ignore quota / unavailable
        }
    }

    private emit(): void {
        for (const l of this.listeners) l()
    }
}

export const themeStore = new ThemeStore()

/** Apply the persisted appearance to <html>. Call once in main.tsx before render. */
export function initTheme(): void {
    themeStore.init()
}

export function useBoardThemeId(): BoardThemeId {
    return useSyncExternalStore(themeStore.subscribe, () => themeStore.getSnapshot().board)
}

export function usePieceSet(): PieceSetId {
    return useSyncExternalStore(themeStore.subscribe, () => themeStore.getSnapshot().pieces)
}
