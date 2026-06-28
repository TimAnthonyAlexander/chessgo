// Singleton WebSocket client + store for the realtime hub. Lives outside React
// so the connection survives navigation (lobby → live game). Components read it
// via useGameSocket (useSyncExternalStore). The browser auto-replies to the
// server's ping frames (heartbeat), so we only implement reconnect here.
import { getWsTicket } from '../api/client'

export type Color = 'w' | 'b'

export interface ChatMessage {
    id: number
    mine: boolean
    name: string
    text: string
}

// Pending offer state from this client's perspective: 'mine' = we offered and
// await a reply; 'theirs' = the opponent offered and we can accept/decline.
export type OfferState = 'mine' | 'theirs' | null

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
    opponentOnline: boolean
    messages: ChatMessage[]
    drawOffer: OfferState
    takebackOffer: OfferState
}

let chatSeq = 0

// A pending private "challenge a friend" invite this client created. Present
// while we wait for the friend to join via the shared code/link; cleared once a
// game starts (matched), the invite is cancelled, or it expires.
export interface ChallengeState {
    code: string
    pool: string
    color: 'w' | 'b' | 'random'
    rated: boolean
}

export interface SocketState {
    conn: 'closed' | 'connecting' | 'open'
    status: 'idle' | 'queued' | 'matched'
    pool: string | null
    game: LiveGameState | null
    challenge: ChallengeState | null
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
        opponentOnline: true,
        messages: [],
        drawOffer: null,
        takebackOffer: null,
    }
}

// Build a full game state from a resume message (includes move history).
function buildResume(m: Msg): LiveGameState {
    const moves: { san: string; uci: string }[] = (m.moves ?? []).map((x: Msg) => ({
        san: x.san,
        uci: x.uci,
    }))
    return {
        id: m.gameId,
        color: m.color,
        rated: !!m.rated,
        pool: m.pool,
        timeControl: m.timeControl,
        opponent: m.opponent,
        fen: m.fen,
        sideToMove: m.sideToMove,
        lastMove: parseLast(m.lastMove),
        check: !!m.check,
        status: m.status,
        legalMoves: m.legalMoves ?? [],
        clock: m.clock,
        clockAt: Date.now(),
        moves,
        result: null,
        reason: null,
        ended: m.status !== 'ongoing',
        opponentOnline: m.opponentOnline !== false,
        messages: [],
        drawOffer: null,
        takebackOffer: null,
    }
}

class GameSocket {
    private state: SocketState = {
        conn: 'closed',
        status: 'idle',
        pool: null,
        game: null,
        challenge: null,
        error: null,
    }
    private ws: WebSocket | null = null
    private listeners = new Set<() => void>()
    private reconnectTimer: number | null = null
    private resumeTimer: number | null = null
    private attempts = 0
    private intentional = false
    private wantQueue: string | null = null
    // Private-challenge intents, replayed on (re)connect like wantQueue: the
    // creator's pending invite and a join-by-code attempt.
    private wantChallenge: { pool: string; color: 'w' | 'b' | 'random'; rated: boolean } | null =
        null
    private wantJoin: string | null = null

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
        if (
            this.ws &&
            (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
        )
            return
        this.intentional = false
        this.set({ conn: 'connecting', error: null })
        try {
            const { ticket, wsUrl } = await getWsTicket()
            const ws = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`)
            this.ws = ws
            ws.onopen = () => {
                this.attempts = 0
                this.set({ conn: 'open' })
                // Replay whatever lobby intent we hold (only one of queue/create can be
                // active; a join may ride alongside on a fresh deep-link connection).
                if (this.wantQueue) this.rawSend({ type: 'queue', pool: this.wantQueue })
                else if (this.wantChallenge)
                    this.rawSend({ type: 'createChallenge', ...this.wantChallenge })
                if (this.wantJoin) this.rawSend({ type: 'joinChallenge', code: this.wantJoin })
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

    // --- private "challenge a friend" invites ---

    /** Create a private invite; the hub replies with `challengeCreated` carrying a
     * shareable code. Only one of queue/challenge can be pending at a time. */
    async createChallenge(
        pool: string,
        color: 'w' | 'b' | 'random',
        rated: boolean,
    ): Promise<void> {
        this.wantQueue = null
        this.wantJoin = null
        this.wantChallenge = { pool, color, rated }
        this.set({ status: 'idle', pool: null, game: null, challenge: null, error: null })
        await this.connect()
        this.rawSend({ type: 'createChallenge', pool, color, rated })
    }

    /** Join a friend's private invite by its code. On success the hub sends
     * `matched`; an unknown/expired code yields an `error`. */
    async joinChallenge(code: string): Promise<void> {
        const c = code.trim().toUpperCase()
        if (!c) return
        this.wantQueue = null
        this.wantChallenge = null
        this.wantJoin = c
        this.set({ game: null, challenge: null, error: null })
        await this.connect()
        this.rawSend({ type: 'joinChallenge', code: c })
    }

    /** Withdraw our own pending invite. */
    cancelChallenge() {
        this.wantChallenge = null
        this.rawSend({ type: 'cancelChallenge' })
        this.set({ challenge: null })
    }

    /** Clear a transient lobby error (e.g. when reopening the challenge dialog). */
    clearError() {
        if (this.state.error !== null) this.set({ error: null })
    }

    move(uci: string) {
        this.rawSend({ type: 'move', move: uci })
    }

    resign() {
        this.rawSend({ type: 'resign' })
    }

    // --- draw offers / takebacks / chat ---

    offerDraw() {
        this.rawSend({ type: 'drawOffer' })
        this.setOffer('drawOffer', 'mine')
    }

    /** Accept or decline a standing draw offer from the opponent. */
    respondDraw(accept: boolean) {
        this.rawSend({ type: accept ? 'drawAccept' : 'drawDecline' })
        if (!accept) this.setOffer('drawOffer', null)
    }

    /** Withdraw our own pending draw offer. */
    cancelDraw() {
        this.rawSend({ type: 'drawDecline' })
        this.setOffer('drawOffer', null)
    }

    offerTakeback() {
        this.rawSend({ type: 'takebackOffer' })
        this.setOffer('takebackOffer', 'mine')
    }

    respondTakeback(accept: boolean) {
        this.rawSend({ type: accept ? 'takebackAccept' : 'takebackDecline' })
        if (!accept) this.setOffer('takebackOffer', null)
    }

    cancelTakeback() {
        this.rawSend({ type: 'takebackDecline' })
        this.setOffer('takebackOffer', null)
    }

    sendChat(text: string) {
        const trimmed = text.trim()
        if (!trimmed) return
        this.rawSend({ type: 'chat', text: trimmed })
    }

    private setOffer(key: 'drawOffer' | 'takebackOffer', val: OfferState) {
        const g = this.state.game
        if (!g) return
        this.set({ game: { ...g, [key]: val } })
    }

    /** Leave a finished game and return to an idle lobby state. */
    leave() {
        this.wantQueue = null
        this.wantChallenge = null
        this.wantJoin = null
        this.set({ status: 'idle', pool: null, game: null, challenge: null, error: null })
    }

    /** Re-open the socket so a fresh ws-ticket (new account identity) is minted —
     * called after login/logout. Skipped during a live game to avoid disruption. */
    reidentify() {
        if (this.state.game && !this.state.game.ended) return
        this.intentional = true
        this.ws?.close()
        this.ws = null
        void this.connect()
    }

    private onClose() {
        this.ws = null
        this.set({ conn: 'closed' })
        if (this.intentional) return
        // The game is NOT abandoned — the hub keeps it alive. We reconnect and the
        // hub resumes us (or tells us it's over).
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
            case 'hello':
                this.onHello()
                break
            case 'queued':
                this.set({ status: 'queued', pool: msg.pool })
                break
            case 'idle':
                this.set({ status: 'idle', pool: null, challenge: null })
                break
            case 'matched':
                // A game started (public match or accepted private challenge): all
                // pending lobby intents are now resolved.
                this.wantQueue = null
                this.wantChallenge = null
                this.wantJoin = null
                this.set({
                    status: 'matched',
                    pool: msg.pool,
                    game: buildGame(msg),
                    challenge: null,
                    error: null,
                })
                break
            case 'challengeCreated':
                this.set({
                    challenge: {
                        code: msg.code,
                        pool: msg.pool,
                        color: msg.color,
                        rated: !!msg.rated,
                    },
                    error: null,
                })
                break
            case 'challengeExpired':
                this.wantChallenge = null
                this.set({ challenge: null, error: 'Your invite expired before anyone joined.' })
                break
            case 'resume':
                this.onResume(msg)
                break
            case 'state':
                this.applyState(msg)
                break
            case 'end':
                this.applyEnd(msg)
                break
            case 'opponentGone':
                this.setOpponentOnline(false)
                break
            case 'opponentBack':
                this.setOpponentOnline(true)
                break
            case 'drawOffered':
                this.onOffer('drawOffer', msg.by)
                break
            case 'drawDeclined':
                this.setOffer('drawOffer', null)
                break
            case 'takebackOffered':
                this.onOffer('takebackOffer', msg.by)
                break
            case 'takebackDeclined':
                this.setOffer('takebackOffer', null)
                break
            case 'chat':
                this.onChat(msg)
                break
            case 'error':
                // A failed join (bad/expired code) shouldn't be retried on reconnect.
                this.wantJoin = null
                this.set({ error: msg.message })
                break
            default:
                break
        }
    }

    // On (re)connect: if we still have an unfinished game but the hub doesn't send
    // a resume shortly after hello, it ended while we were away — mark it over.
    private onHello() {
        if (this.state.game && !this.state.game.ended) {
            if (this.resumeTimer !== null) window.clearTimeout(this.resumeTimer)
            this.resumeTimer = window.setTimeout(() => {
                this.resumeTimer = null
                const g = this.state.game
                if (g && !g.ended) {
                    this.set({
                        game: {
                            ...g,
                            ended: true,
                            status: 'ended',
                            reason: 'ended while away',
                            legalMoves: [],
                        },
                    })
                }
            }, 1500)
        }
    }

    private onResume(msg: Msg) {
        if (this.resumeTimer !== null) {
            window.clearTimeout(this.resumeTimer)
            this.resumeTimer = null
        }
        const prev = this.state.game
        const game = buildResume(msg)
        // Carry the in-memory chat across a reconnect to the same game (offers are
        // transient and intentionally reset — the hub drops them on disconnect).
        if (prev && prev.id === game.id) game.messages = prev.messages
        this.set({ game, error: null })
    }

    private setOpponentOnline(online: boolean) {
        const g = this.state.game
        if (!g) return
        this.set({ game: { ...g, opponentOnline: online } })
    }

    // A draw/takeback offer arrived: 'mine' if we sent it (echo), 'theirs' otherwise.
    private onOffer(key: 'drawOffer' | 'takebackOffer', by: string) {
        const g = this.state.game
        if (!g) return
        this.set({ game: { ...g, [key]: by === g.color ? 'mine' : 'theirs' } })
    }

    private onChat(msg: Msg) {
        const g = this.state.game
        if (!g) return
        const text = typeof msg.text === 'string' ? msg.text : ''
        if (!text) return
        const message: ChatMessage = {
            id: ++chatSeq,
            mine: msg.by === g.color,
            name: typeof msg.name === 'string' ? msg.name : '',
            text,
        }
        this.set({ game: { ...g, messages: [...g.messages, message] } })
    }

    private applyState(msg: Msg) {
        const g = this.state.game
        if (!g) return
        const moves = g.moves.slice()
        if (typeof msg.ply === 'number') {
            if (msg.ply < moves.length) {
                moves.length = msg.ply // takeback: roll the move list back
            } else if (msg.ply > moves.length && msg.san) {
                moves.push({ san: msg.san, uci: msg.lastMove })
            }
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
                // The board changed (move or takeback) → any pending offer is resolved
                // server-side; clear our local pending UI to match.
                drawOffer: null,
                takebackOffer: null,
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

/** Live remaining time (ms) for a color, counting down if it's their turn.
 * Clocks are frozen until both sides have made their first move (the opening two
 * plies are untimed, Lichess-style) — mirrors the server's authoritative clock. */
export function liveRemaining(g: LiveGameState, color: Color): number {
    let rem = g.clock[color]
    if (!g.ended && g.moves.length >= 2 && g.sideToMove === color) {
        rem -= Date.now() - g.clockAt
    }
    return Math.max(0, rem)
}
