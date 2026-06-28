// Singleton spectator client + store for the realtime hub. Deliberately separate
// from `gameSocket` (lib/socket.ts): a spectator connection is read-only and must
// never clobber the player's own live game. It opens with `?spectate=1` so the
// hub skips the player reattach/resume path, then `watch`es a single game id.
import { getWsTicket } from '../api/client'
import type { Color } from '../api/client'

export interface SpectateSide {
    name: string
    rating: number
    anon: boolean
}

export interface SpectateGame {
    id: string
    pool: string
    rated: boolean
    white: SpectateSide
    black: SpectateSide
    fen: string
    sideToMove: Color
    lastMove: { from: string; to: string } | null
    check: boolean
    status: string
    timeControl: { base: number; inc: number }
    clock: { w: number; b: number } // ms remaining at clockAt
    clockAt: number // Date.now() when the clock was received
    moves: { san: string; uci: string }[]
    result: string | null
    reason: string | null
    over: boolean
}

export interface SpectateState {
    conn: 'closed' | 'connecting' | 'open'
    game: SpectateGame | null
    error: string | null // e.g. set when the watched game is no longer available
}

type Msg = Record<string, any>

function parseLast(uci: string | undefined): { from: string; to: string } | null {
    return uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null
}

function buildWatching(m: Msg): SpectateGame {
    return {
        id: m.gameId,
        pool: m.pool,
        rated: !!m.rated,
        white: m.white,
        black: m.black,
        fen: m.fen,
        sideToMove: m.sideToMove,
        lastMove: parseLast(m.lastMove),
        check: !!m.check,
        status: m.status,
        timeControl: m.timeControl,
        clock: m.clock,
        clockAt: Date.now(),
        moves: (m.moves ?? []).map((x: Msg) => ({ san: x.san, uci: x.uci })),
        result: null,
        reason: null,
        over: !!m.over,
    }
}

class SpectateSocket {
    private state: SpectateState = { conn: 'closed', game: null, error: null }
    private ws: WebSocket | null = null
    private listeners = new Set<() => void>()
    private reconnectTimer: number | null = null
    private attempts = 0
    private gameId: string | null = null // the game we want to watch
    private intentional = false

    getState = (): SpectateState => this.state

    subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    private emit() {
        for (const l of this.listeners) l()
    }

    private set(patch: Partial<SpectateState>) {
        this.state = { ...this.state, ...patch }
        this.emit()
    }

    private rawSend(msg: Msg) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    }

    /** Begin spectating a game by hub id (opens the connection if needed). */
    open(gameId: string) {
        this.gameId = gameId
        this.set({ game: null, error: null })
        void this.connect()
        this.rawSend({ type: 'watch', gameId })
    }

    /** Stop spectating and tear the connection down. */
    close() {
        if (this.gameId) this.rawSend({ type: 'unwatch' })
        this.gameId = null
        this.intentional = true
        if (this.reconnectTimer !== null) {
            window.clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
        this.ws?.close()
        this.ws = null
        this.set({ conn: 'closed', game: null, error: null })
    }

    private async connect(): Promise<void> {
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
        )
            return
        this.intentional = false
        this.set({ conn: 'connecting' })
        try {
            const { ticket, wsUrl } = await getWsTicket()
            const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}&spectate=1`)
            this.ws = ws
            ws.onopen = () => {
                this.attempts = 0
                this.set({ conn: 'open' })
                if (this.gameId) this.rawSend({ type: 'watch', gameId: this.gameId })
            }
            ws.onmessage = (e) => {
                try {
                    this.handle(JSON.parse(e.data))
                } catch {
                    /* ignore malformed */
                }
            }
            ws.onclose = () => this.onClose()
            ws.onerror = () => {}
        } catch {
            this.set({ conn: 'closed' })
            this.scheduleReconnect()
        }
    }

    private onClose() {
        this.ws = null
        this.set({ conn: 'closed' })
        if (this.intentional || !this.gameId) return
        this.scheduleReconnect()
    }

    private scheduleReconnect() {
        if (this.reconnectTimer !== null || !this.gameId) return
        const delay = Math.min(1000 * 2 ** this.attempts, 10000)
        this.attempts++
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null
            void this.connect()
        }, delay)
    }

    private handle(msg: Msg) {
        switch (msg.type) {
            case 'watching':
                this.set({ game: buildWatching(msg), error: null })
                break
            case 'state':
                this.applyState(msg)
                break
            case 'end':
                this.applyEnd(msg)
                break
            case 'watchEnd':
                // The game ended or wasn't available when we asked to watch.
                this.set({ error: msg.reason ?? 'unavailable' })
                break
            case 'error':
                this.set({ error: msg.message })
                break
            default:
                break // 'hello' and anything else: ignore
        }
    }

    private applyState(msg: Msg) {
        const g = this.state.game
        if (!g || g.id !== msg.gameId) return
        const moves = g.moves.slice()
        if (typeof msg.ply === 'number' && msg.ply > moves.length && msg.san) {
            moves.push({ san: msg.san, uci: msg.lastMove })
        }
        this.set({
            game: {
                ...g,
                fen: msg.fen,
                sideToMove: msg.sideToMove,
                lastMove: parseLast(msg.lastMove),
                check: !!msg.check,
                status: msg.status,
                clock: msg.clock,
                clockAt: Date.now(),
                moves,
            },
        })
    }

    private applyEnd(msg: Msg) {
        const g = this.state.game
        if (!g || g.id !== msg.gameId) return
        this.set({
            game: {
                ...g,
                over: true,
                status: msg.status,
                result: msg.result ?? null,
                reason: msg.reason ?? null,
                clock: msg.clock ?? g.clock,
                clockAt: Date.now(),
            },
        })
    }
}

export const spectateSocket = new SpectateSocket()

/** Live remaining time (ms) for a color in a spectated game, mirroring the
 * server clock: frozen until both opening plies are played, then counting down
 * for the side to move. */
export function spectateRemaining(g: SpectateGame, color: Color): number {
    let rem = g.clock[color]
    if (!g.over && g.moves.length >= 2 && g.sideToMove === color) {
        rem -= Date.now() - g.clockAt
    }
    return Math.max(0, rem)
}
