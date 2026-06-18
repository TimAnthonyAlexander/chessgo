// Singleton WebSocket client + store for the realtime hub. Lives outside React
// so the connection survives navigation (lobby → live game). Components read it
// via useGameSocket (useSyncExternalStore). The browser auto-replies to the
// server's ping frames (heartbeat), so we only implement reconnect here.
import { getWsTicket } from '../api/client'

export type Color = 'w' | 'b'

export interface LiveGameState {
  id: string
  color: Color // our color
  rated: boolean
  pool: string
  timeControl: { base: number; inc: number }
  opponent: { name: string; rating: number; anon: boolean }
  fen: string
  sideToMove: Color
  lastMove: { from: string; to: string } | null
  check: boolean
  status: string
  legalMoves: string[]
  clock: { w: number; b: number } // ms remaining at clockAt
  clockAt: number // Date.now() when clock was received
  moves: { san: string; uci: string }[]
  result: string | null
  reason: string | null
  ended: boolean
}

export interface SocketState {
  conn: 'closed' | 'connecting' | 'open'
  status: 'idle' | 'queued' | 'matched'
  pool: string | null
  game: LiveGameState | null
  error: string | null
}

type Msg = Record<string, any>

function parseLast(uci: string | undefined): { from: string; to: string } | null {
  return uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null
}

function buildGame(m: Msg): LiveGameState {
  return {
    id: m.gameId,
    color: m.color,
    rated: !!m.rated,
    pool: m.pool,
    timeControl: m.timeControl,
    opponent: m.opponent,
    fen: m.fen,
    sideToMove: (m.fen as string).split(' ')[1] === 'b' ? 'b' : 'w',
    lastMove: null,
    check: false,
    status: 'ongoing',
    legalMoves: m.legalMoves ?? [],
    clock: m.clock,
    clockAt: Date.now(),
    moves: [],
    result: null,
    reason: null,
    ended: false,
  }
}

class GameSocket {
  private state: SocketState = { conn: 'closed', status: 'idle', pool: null, game: null, error: null }
  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private reconnectTimer: number | null = null
  private attempts = 0
  private intentional = false
  private wantQueue: string | null = null

  getState = (): SocketState => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  private set(patch: Partial<SocketState>) {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private rawSend(msg: Msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.intentional = false
    this.set({ conn: 'connecting', error: null })
    try {
      const { ticket, wsUrl } = await getWsTicket()
      const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`)
      this.ws = ws
      ws.onopen = () => {
        this.attempts = 0
        this.set({ conn: 'open' })
        if (this.wantQueue) this.rawSend({ type: 'queue', pool: this.wantQueue })
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
      this.set({ conn: 'closed', error: 'Could not reach the server.' })
      this.scheduleReconnect()
    }
  }

  async queue(pool: string): Promise<void> {
    this.wantQueue = pool
    this.set({ status: 'queued', pool, error: null, game: null })
    await this.connect()
    this.rawSend({ type: 'queue', pool })
  }

  cancelQueue() {
    this.wantQueue = null
    this.rawSend({ type: 'cancel' })
    this.set({ status: 'idle', pool: null })
  }

  move(uci: string) {
    this.rawSend({ type: 'move', move: uci })
  }

  resign() {
    this.rawSend({ type: 'resign' })
  }

  /** Leave a finished game and return to an idle lobby state. */
  leave() {
    this.wantQueue = null
    this.set({ status: 'idle', pool: null, game: null, error: null })
  }

  private onClose() {
    this.ws = null
    this.set({ conn: 'closed' })
    if (this.intentional) return
    if (this.state.game && !this.state.game.ended) {
      // A mid-game disconnect ends the game server-side (abandon).
      this.set({
        error: 'Connection lost.',
        game: { ...this.state.game, ended: true, status: 'disconnected', reason: 'connection lost', legalMoves: [] },
      })
    }
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return
    const delay = Math.min(1000 * 2 ** this.attempts, 10000)
    this.attempts++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private handle(msg: Msg) {
    switch (msg.type) {
      case 'queued':
        this.set({ status: 'queued', pool: msg.pool })
        break
      case 'idle':
        this.set({ status: 'idle', pool: null })
        break
      case 'matched':
        this.set({ status: 'matched', pool: msg.pool, game: buildGame(msg), error: null })
        break
      case 'state':
        this.applyState(msg)
        break
      case 'end':
        this.applyEnd(msg)
        break
      case 'error':
        this.set({ error: msg.message })
        break
      default:
        break
    }
  }

  private applyState(msg: Msg) {
    const g = this.state.game
    if (!g) return
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
        legalMoves: msg.legalMoves ?? [],
        clock: msg.clock,
        clockAt: Date.now(),
        moves,
      },
    })
  }

  private applyEnd(msg: Msg) {
    const g = this.state.game
    if (!g) return
    this.set({
      status: 'idle',
      game: {
        ...g,
        ended: true,
        status: msg.status,
        result: msg.result ?? null,
        reason: msg.reason ?? null,
        clock: msg.clock ?? g.clock,
        clockAt: Date.now(),
        legalMoves: [],
      },
    })
  }
}

export const gameSocket = new GameSocket()

/** Live remaining time (ms) for a color, counting down if it's their turn. */
export function liveRemaining(g: LiveGameState, color: Color): number {
  let rem = g.clock[color]
  if (!g.ended && g.sideToMove === color) {
    rem -= Date.now() - g.clockAt
  }
  return Math.max(0, rem)
}
