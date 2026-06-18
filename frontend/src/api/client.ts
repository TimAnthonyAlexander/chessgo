// Typed client for the chessgo BaseAPI backend (SPEC §7 / VS-Bot endpoints).
const BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:6464'

export type Color = 'w' | 'b'

export type GameStatus =
  | 'ongoing'
  | 'checkmate'
  | 'stalemate'
  | 'draw-fifty'
  | 'draw-seventyfive'
  | 'draw-threefold-claimable'
  | 'draw-fivefold'
  | 'draw-insufficient-material'
  | 'draw-dead-position'

export interface MoveEntry {
  ply: number
  uci: string
  san: string
  by: 'human' | 'bot'
  fen: string // position after this move (for history navigation)
  eval?: { type: 'cp' | 'mate'; value: number }
}

export interface BotGame {
  id: string
  level: number
  human_color: Color
  fen: string
  side_to_move: Color
  status: GameStatus
  result: string | null
  moves: MoveEntry[]
  legal_moves: string[]
  your_turn: boolean
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch {
    throw new ApiError('Cannot reach the server. Is the API running on :6464?', 0)
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `Request failed (${res.status})`
    throw new ApiError(msg, res.status)
  }
  return body as T
}

export function createBotGame(level: number, humanColor: Color): Promise<BotGame> {
  return request<BotGame>('/bot-games', {
    method: 'POST',
    body: JSON.stringify({ level, human_color: humanColor }),
  })
}

export function getBotGame(id: string): Promise<BotGame> {
  return request<BotGame>(`/bot-games/${id}`)
}

export function playMove(id: string, move: string): Promise<BotGame> {
  return request<BotGame>(`/bot-games/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ move }),
  })
}

export interface Analysis {
  eval: { type: 'cp' | 'mate'; value: number } | null
  bestmove: string | null
  depth: number | null
}

/** Full-strength evaluation of a position (drives the eval bar, level-independent). */
export function analyze(fen: string): Promise<Analysis> {
  return request<Analysis>('/analyze', { method: 'POST', body: JSON.stringify({ fen }) })
}

export interface WsTicket {
  ticket: string
  wsUrl: string
  identity: { name: string; anon: boolean; rating: number }
}

/** A stable per-browser anonymous id, so the hub can reconnect/resume games. */
export function anonId(): string {
  try {
    let id = localStorage.getItem('chessgo.anonId')
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem('chessgo.anonId', id)
    }
    return id
  } catch {
    return crypto.randomUUID()
  }
}

/** Mint a short-lived ticket + ws URL for the realtime hub. */
export function getWsTicket(): Promise<WsTicket> {
  return request<WsTicket>(`/ws-ticket?anon=${encodeURIComponent(anonId())}`)
}

export { ApiError }
