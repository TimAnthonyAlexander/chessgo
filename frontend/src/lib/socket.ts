// Singleton WebSocket client + store for the realtime hub. Lives outside React
// so the connection survives navigation (lobby → live game). Components read it
// via useGameSocket (useSyncExternalStore). The browser auto-replies to the
// server's ping frames (heartbeat), so we only implement reconnect here.
import { getWsTicket } from '../api/client'
import type { Title } from '../api/client'
import type { Variant } from './variants'

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
    variant: Variant // 'standard' unless a variant (e.g. Chess960) was chosen
    pool: string
    // The arena tournament this game was paired from, or null for every other
    // game (public match, private challenge, rematch, bot game). Lets a page
    // recognise "this live game is one of my tournament's pairings" (e.g. to
    // navigate into it the moment a pairing arrives).
    tournamentId: string | null
    timeControl: { base: number; inc: number }
    // title is "" for bots/anon/titleless opponents — never a placeholder.
    opponent: { name: string; rating: number; anon: boolean; title?: Title | null }
    fen: string
    sideToMove: Color
    lastMove: { from: string; to: string } | null
    check: boolean
    duck: string | null // Duck Chess: the duck's square, or null (non-duck games / before first placement)
    pocket: string // Crazyhouse: the pocket string ("PPNq", white upper / black lower), "" otherwise
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
    rematchOffer: OfferState
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
    variant: Variant
    fen: string | null
}

// This client joined a server-registered challenge (an accepted directed
// challenge — see ChallengeAcceptController) before the OTHER named player
// arrived: we're parked here, waiting for them, instead of pairing immediately.
// The hub's `challengeWaiting` message carries the terms but not the other
// player's identity, so there's no opponent name to show — just the code/link
// and the game terms.
export interface ChallengeWaitingState {
    code: string
    pool: string
    color: 'w' | 'b' | 'random'
    rated: boolean
    variant: Variant
    fen: string | null
}

// This client asked to be paired in a running arena tournament (joinArena) and
// hasn't yet been matched into a game or told arenaLeft. `waiting` is false in
// the brief window between sending joinArena and the hub's first pairing
// attempt (arenaJoined), true once the hub confirms we're actually parked
// (arenaWaiting) — a page can treat either as "show the waiting UI", the
// distinction is only there for fidelity to the two wire messages.
export interface ArenaState {
    tournamentId: string
    waiting: boolean
}

// A `joinArena` we sent came back refused. The hub polls BaseAPI for arena
// rosters every 5s, so a join sent right after the REST join can arrive
// before the hub knows we're a participant yet — that specific refusal
// ("you're not a participant in this arena") is a race, worth retrying.
// Every other refusal (not signed in, already seated elsewhere, withdrawn,
// unknown tournament) is a real answer and `retryable` is false.
export interface ArenaJoinError {
    tournamentId: string
    message: string
    retryable: boolean
}

export interface SocketState {
    conn: 'closed' | 'connecting' | 'open'
    status: 'idle' | 'queued' | 'matched'
    pool: string | null
    game: LiveGameState | null
    challenge: ChallengeState | null
    challengeWaiting: ChallengeWaitingState | null
    arena: ArenaState | null
    arenaError: ArenaJoinError | null
    error: string | null
}

function parseFen(fen: unknown): string | null {
    return typeof fen === 'string' && fen !== '' ? fen : null
}

type Msg = Record<string, any>

function parseLast(uci: string | undefined): { from: string; to: string } | null {
    return uci ? { from: uci.slice(0, 2), to: uci.slice(2, 4) } : null
}

// The hub's Duck Chess field: a square string, "" (no duck yet), or absent
// (standard/960). Normalize the empty/absent cases to null.
function parseDuck(duck: unknown): string | null {
    return typeof duck === 'string' && duck !== '' ? duck : null
}

// The hub's arena tag: a tournament id string, or absent for every non-arena
// game. Normalize the absent case to null.
function parseTournamentId(id: unknown): string | null {
    return typeof id === 'string' && id !== '' ? id : null
}

function buildGame(m: Msg): LiveGameState {
    return {
        id: m.gameId,
        color: m.color,
        rated: !!m.rated,
        variant: (m.variant as Variant) ?? 'standard',
        pool: m.pool,
        tournamentId: parseTournamentId(m.tournamentId),
        timeControl: m.timeControl,
        opponent: m.opponent,
        fen: m.fen,
        sideToMove: (m.fen as string).split(' ')[1] === 'b' ? 'b' : 'w',
        lastMove: null,
        check: false,
        duck: parseDuck(m.duck),
        pocket: typeof m.pocket === 'string' ? m.pocket : '',
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
        rematchOffer: null,
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
        variant: (m.variant as Variant) ?? 'standard',
        pool: m.pool,
        tournamentId: parseTournamentId(m.tournamentId),
        timeControl: m.timeControl,
        opponent: m.opponent,
        fen: m.fen,
        sideToMove: m.sideToMove,
        lastMove: parseLast(m.lastMove),
        check: !!m.check,
        duck: parseDuck(m.duck),
        pocket: typeof m.pocket === 'string' ? m.pocket : '',
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
        rematchOffer: null,
    }
}

class GameSocket {
    private state: SocketState = {
        conn: 'closed',
        status: 'idle',
        pool: null,
        game: null,
        challenge: null,
        challengeWaiting: null,
        arena: null,
        arenaError: null,
        error: null,
    }
    private ws: WebSocket | null = null
    private listeners = new Set<() => void>()
    private reconnectTimer: number | null = null
    private resumeTimer: number | null = null
    private attempts = 0
    private intentional = false
    private wantQueue: { pool: string; variant: Variant } | null = null
    // Private-challenge intents, replayed on (re)connect like wantQueue: the
    // creator's pending invite and a join-by-code attempt.
    private wantChallenge: {
        pool: string
        color: 'w' | 'b' | 'random'
        rated: boolean
        variant: Variant
        fen: string
    } | null = null
    private wantJoin: string | null = null
    // The arena tournament we've asked to be paired in, replayed on (re)connect
    // like the other lobby intents. Kept in sync with confirmed server state
    // (arenaJoined/arenaWaiting re-set it, arenaLeft/leaveArena clear it) so a
    // reconnect while WAITING (not yet paired) rejoins the pool — the hub drops
    // a connection's pool membership on disconnect, so nothing else would.
    // Deliberately NOT cleared on `matched`: replaying joinArena while already
    // seated in a game is harmless (the hub just reattaches, see arena.go), and
    // keeping it armed covers a disconnect that happens mid-game.
    private wantArena: string | null = null

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
                if (this.wantQueue)
                    this.rawSend({
                        type: 'queue',
                        pool: this.wantQueue.pool,
                        variant: this.wantQueue.variant,
                    })
                else if (this.wantChallenge)
                    this.rawSend({ type: 'createChallenge', ...this.wantChallenge })
                if (this.wantJoin) this.rawSend({ type: 'joinChallenge', code: this.wantJoin })
                if (this.wantArena)
                    this.rawSend({ type: 'joinArena', tournamentId: this.wantArena })
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

    async queue(pool: string, variant: Variant = 'standard'): Promise<void> {
        this.wantQueue = { pool, variant }
        this.wantArena = null
        this.set({ status: 'queued', pool, error: null, game: null, arena: null, arenaError: null })
        await this.connect()
        this.rawSend({ type: 'queue', pool, variant })
    }

    cancelQueue() {
        this.wantQueue = null
        this.rawSend({ type: 'cancel' })
        this.set({ status: 'idle', pool: null })
    }

    // --- arena tournaments ---

    /** Ask the hub to seat us in a running arena's pairing pool. The hub
     * replies `arenaJoined` (+ `arenaWaiting` if still unpaired a moment
     * later) or an ordinary `matched` if a pairing was immediate. Only one of
     * queue/challenge/arena can be pending at a time — this clears the others,
     * mirroring the hub's own "one pending activity per client" rule. */
    async joinArena(tournamentId: string): Promise<void> {
        this.wantQueue = null
        this.wantChallenge = null
        this.wantJoin = null
        this.wantArena = tournamentId
        this.set({ arena: { tournamentId, waiting: false }, arenaError: null, error: null })
        await this.connect()
        this.rawSend({ type: 'joinArena', tournamentId })
    }

    /** Stop waiting to be paired in whatever arena we're currently parked in
     * (a no-op hub-side if we aren't waiting in one). Doesn't touch a game
     * already in progress. */
    leaveArena() {
        this.wantArena = null
        this.rawSend({ type: 'leaveArena' })
        this.set({ arena: null, arenaError: null })
    }

    /** Ask the hub whether this ACCOUNT has a live game — it answers with a full
     * `resume` (seating this connection) or `idle`/`queued`. A fresh connection is
     * asked the same thing at register time, so a closed socket just connects. Used
     * to re-check on tab focus, since a socket that stays open never re-registers
     * and so would never hear about a game started on another device. */
    requestResume() {
        if (this.ws?.readyState === WebSocket.OPEN) this.rawSend({ type: 'resume' })
        else void this.connect()
    }

    // --- private "challenge a friend" invites ---

    /** Create a private invite; the hub replies with `challengeCreated` carrying a
     * shareable code. Only one of queue/challenge can be pending at a time. `fen`
     * starts the game from a custom position (the hub forces such games casual
     * and rejects it combined with chess960). */
    async createChallenge(
        pool: string,
        color: 'w' | 'b' | 'random',
        rated: boolean,
        variant: Variant = 'standard',
        fen: string = '',
    ): Promise<void> {
        this.wantQueue = null
        this.wantJoin = null
        this.wantArena = null
        this.wantChallenge = { pool, color, rated, variant, fen }
        this.set({
            status: 'idle',
            pool: null,
            game: null,
            challenge: null,
            challengeWaiting: null,
            arena: null,
            arenaError: null,
            error: null,
        })
        await this.connect()
        this.rawSend({ type: 'createChallenge', pool, color, rated, variant, fen })
    }

    /** Join a friend's private invite by its code, or a server-registered
     * challenge (an accepted directed challenge). On success the hub sends
     * `matched` (paired immediately); if this is a server-registered challenge
     * and the other named player hasn't arrived yet, it instead sends
     * `challengeWaiting` and we park here. An unknown/expired/not-yours code
     * yields an `error`. */
    async joinChallenge(code: string): Promise<void> {
        const c = code.trim().toUpperCase()
        if (!c) return
        this.wantQueue = null
        this.wantChallenge = null
        this.wantArena = null
        this.wantJoin = c
        this.set({
            game: null,
            challenge: null,
            challengeWaiting: null,
            arena: null,
            arenaError: null,
            error: null,
        })
        await this.connect()
        this.rawSend({ type: 'joinChallenge', code: c })
    }

    /** Withdraw our own pending invite (as its creator), or drop out of a
     * server-registered challenge we were parked waiting on. */
    cancelChallenge() {
        this.wantChallenge = null
        this.wantJoin = null
        this.rawSend({ type: 'cancelChallenge' })
        this.set({ challenge: null, challengeWaiting: null })
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

    offerRematch() {
        this.rawSend({ type: 'rematchOffer' })
    }

    acceptRematch() {
        this.rawSend({ type: 'rematchAccept' })
    }

    declineRematch() {
        this.rawSend({ type: 'rematchDecline' })
        this.setOffer('rematchOffer', null)
    }

    cancelRematch() {
        this.rawSend({ type: 'rematchCancel' })
        this.setOffer('rematchOffer', null)
    }

    sendChat(text: string) {
        const trimmed = text.trim()
        if (!trimmed) return
        this.rawSend({ type: 'chat', text: trimmed })
    }

    private setOffer(key: 'drawOffer' | 'takebackOffer' | 'rematchOffer', val: OfferState) {
        const g = this.state.game
        if (!g) return
        this.set({ game: { ...g, [key]: val } })
    }

    /** Leave a finished game and return to an idle lobby state. If that game
     * was an arena pairing, the hub already returned us to its pool the moment
     * it ended (returnToArenaPool) — tell it we're done so it stops trying to
     * pair us again while we're back browsing the lobby. */
    leave() {
        this.wantQueue = null
        this.wantChallenge = null
        this.wantJoin = null
        if (this.wantArena) {
            this.wantArena = null
            this.rawSend({ type: 'leaveArena' })
        }
        this.set({
            status: 'idle',
            pool: null,
            game: null,
            challenge: null,
            challengeWaiting: null,
            arena: null,
            arenaError: null,
            error: null,
        })
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
                this.set({ status: 'idle', pool: null, challenge: null, challengeWaiting: null })
                break
            case 'matched':
                // A game started (public match, accepted private challenge, or an
                // arena pairing): all pending lobby intents are now resolved. Arena
                // `waiting` display clears too — wantArena itself stays armed (see
                // its declaration) so a mid-game disconnect can still rejoin the pool.
                this.wantQueue = null
                this.wantChallenge = null
                this.wantJoin = null
                this.set({
                    status: 'matched',
                    pool: msg.pool,
                    game: buildGame(msg),
                    challenge: null,
                    challengeWaiting: null,
                    arena: null,
                    arenaError: null,
                    error: null,
                })
                break
            case 'arenaJoined':
                this.wantArena = msg.tournamentId
                this.set({
                    arena: { tournamentId: msg.tournamentId, waiting: false },
                    arenaError: null,
                    error: null,
                })
                break
            case 'arenaWaiting':
                this.wantArena = msg.tournamentId
                this.set({
                    arena: { tournamentId: msg.tournamentId, waiting: true },
                    arenaError: null,
                    error: null,
                })
                break
            case 'arenaLeft':
                this.wantArena = null
                this.set({ arena: null, arenaError: null })
                break
            case 'challengeCreated':
                this.set({
                    challenge: {
                        code: msg.code,
                        pool: msg.pool,
                        color: msg.color,
                        rated: !!msg.rated,
                        variant: (msg.variant as Variant) ?? 'standard',
                        fen: parseFen(msg.fen),
                    },
                    error: null,
                })
                break
            case 'challengeWaiting':
                // We joined a server-registered challenge before the other named
                // player arrived — park here (mirrors how a client-created
                // challenge's own creator waits).
                this.set({
                    challengeWaiting: {
                        code: msg.code,
                        pool: msg.pool,
                        color: msg.color,
                        rated: !!msg.rated,
                        variant: (msg.variant as Variant) ?? 'standard',
                        fen: parseFen(msg.fen),
                    },
                    error: null,
                })
                break
            case 'challengeExpired':
                // Sent to a client-created challenge's creator AND/OR a
                // server-registered challenge's currently-parked waiting side.
                this.wantChallenge = null
                this.wantJoin = null
                this.set({
                    challenge: null,
                    challengeWaiting: null,
                    error: 'This challenge expired before it was completed.',
                })
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
            case 'rematchOffered':
                this.onOffer('rematchOffer', msg.by)
                break
            case 'rematchDeclined':
                this.setOffer('rematchOffer', null)
                break
            case 'rematchExpired':
                this.setOffer('rematchOffer', null)
                break
            case 'chat':
                this.onChat(msg)
                break
            case 'error': {
                // A `joinArena` we sent is still pending exactly when wantArena
                // holds the tournament id we asked for (set by joinArena(),
                // cleared only by success/leaveArena/this branch) — that's how we
                // tell an arena refusal apart from a queue/challenge error that
                // happens to share the same bare `error` wire message. Route it
                // to arenaError (not the generic error) so a caller can tell a
                // retryable roster-lag race from a real refusal, and so it
                // doesn't leak into unrelated error UI (lobby/challenge dialogs).
                const pendingArena = this.wantArena
                if (pendingArena) {
                    this.wantArena = null
                    const retryable = msg.message === "you're not a participant in this arena"
                    this.set({
                        arena: null,
                        arenaError: { tournamentId: pendingArena, message: msg.message, retryable },
                    })
                    break
                }
                // A failed join (bad/expired/not-yours code) shouldn't be retried
                // on reconnect, and shouldn't leave a stale waiting screen showing.
                this.wantJoin = null
                this.set({ challengeWaiting: null, error: msg.message })
                break
            }
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
        // A resume also ANSWERS a queue attempt: the hub redirects us into the game
        // we already had instead of pairing a second one, so clear the waiting state.
        this.wantQueue = null
        this.wantChallenge = null
        this.wantJoin = null
        this.set({
            game,
            status: 'idle',
            pool: null,
            challenge: null,
            challengeWaiting: null,
            arena: null,
            arenaError: null,
            error: null,
        })
    }

    private setOpponentOnline(online: boolean) {
        const g = this.state.game
        if (!g) return
        this.set({ game: { ...g, opponentOnline: online } })
    }

    // A draw/takeback offer arrived: 'mine' if we sent it (echo), 'theirs' otherwise.
    private onOffer(key: 'drawOffer' | 'takebackOffer' | 'rematchOffer', by: string) {
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
                duck: parseDuck(msg.duck),
                pocket: typeof msg.pocket === 'string' ? msg.pocket : '',
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
