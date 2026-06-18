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
      credentials: 'include', // session cookie for authenticated endpoints
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

// --- Puzzles (Lichess-style training, SPEC §Puzzles) ---

/** A served puzzle. The opponent's setup move is already applied into `fen`
 * (`opponent_move` is provided so the UI can animate it); the solution line is
 * never sent. The player answers from `fen`, starting at `ply`. */
export interface PuzzleNext {
  id: string
  rating: number
  start_fen: string
  opponent_move: string
  fen: string
  color: Color
  legal_moves: string[]
  ply: number
}

export interface PuzzleRating {
  value: number
  delta: number
  games: number
}

/** Result of submitting one player move. On a correct non-final move the
 * scripted opponent reply + next position are returned; on completion or a
 * wrong move the outcome (and, for logged-in solvers, the rating change). */
export interface PuzzleMoveResult {
  correct: boolean
  complete: boolean
  solved?: boolean
  opponent_move?: string
  fen?: string
  legal_moves?: string[]
  ply?: number
  status?: GameStatus
  solution?: string[]
  themes?: string[]
  rating?: PuzzleRating | null
}

/** Serve the next puzzle near the solver's rating; optional theme filter. */
export function nextPuzzle(theme?: string): Promise<PuzzleNext> {
  const q = theme ? `?theme=${encodeURIComponent(theme)}` : ''
  return request<PuzzleNext>(`/puzzles/next${q}`)
}

/** Submit one player move (UCI) for validation against the hidden solution. */
export function submitPuzzleMove(
  id: string,
  move: string,
  fen: string,
  ply: number,
): Promise<PuzzleMoveResult> {
  return request<PuzzleMoveResult>(`/puzzles/${id}/move`, {
    method: 'POST',
    body: JSON.stringify({ move, fen, ply }),
  })
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

export interface LobbyStats {
  playersOnline: number
  activeGames: number
}

/** Live lobby counts (players online + games in play) from the realtime hub. */
export function getStats(): Promise<LobbyStats> {
  return request<LobbyStats>('/stats')
}

// --- Accounts (session-cookie auth) ---

export type RatingCategory = 'bullet' | 'blitz' | 'rapid' | 'classical'

export interface User {
  id: string
  name: string
  email: string
  role: string
  rating_bullet: number
  rating_blitz: number
  rating_rapid: number
  rating_classical: number
  games_bullet: number
  games_blitz: number
  games_rapid: number
  games_classical: number
  rating_puzzle: number
  games_puzzle: number
}

export function signup(name: string, email: string, password: string): Promise<User> {
  return request<User>('/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  })
}

export function login(email: string, password: string): Promise<User> {
  return request<User>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

export function logout(): Promise<unknown> {
  return request('/auth/logout', { method: 'POST' })
}

/** Current user, or null if not logged in (401). Rethrows other errors. */
export async function me(): Promise<User | null> {
  try {
    const r = await request<{ user: User }>('/me')
    return r.user
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

export { ApiError }
