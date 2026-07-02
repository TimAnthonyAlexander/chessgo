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

export type BoardThemeId = 'default' | 'brown' | 'green' | 'purple'
export type PieceSetId = 'cburnett' | 'merida' | 'chessnut' | 'fantasy'

export interface BoardTheme {
    id: BoardThemeId
    label: string
    /** CSS custom properties applied to <html> for this theme. Every board-facing
     * variable is set explicitly (including for `default`) so switching themes is a
     * uniform overwrite, never a partial one that leaks the previous theme. */
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

export const BOARD_THEMES: BoardTheme[] = [
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
        },
    },
]

// --- Piece sets -------------------------------------------------------------
// SVGs live in /public/piece/<id>/{w,b}{K,Q,R,B,N,P}.svg. Sets vendored from the
// Lichess (lila) repo; only commercial-friendly licenses are shipped.

export const PIECE_SETS: PieceSet[] = [
    { id: 'cburnett', label: 'Cburnett', credit: 'Colin M.L. Burnett · GPLv2+' },
    { id: 'merida', label: 'Merida', credit: 'Armando H. Marroquin · GPLv2+' },
    { id: 'chessnut', label: 'Chessnut', credit: 'Alexis Luengas · Apache 2.0' },
    { id: 'fantasy', label: 'Fantasy', credit: 'Maurizio Monge · MIT' },
]

const DEFAULT_BOARD: BoardThemeId = 'default'
const DEFAULT_PIECES: PieceSetId = 'cburnett'
const LS_BOARD = 'chessgo.board'
const LS_PIECES = 'chessgo.pieces'

const boardById = (id: string | null): BoardTheme =>
    BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0]
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
