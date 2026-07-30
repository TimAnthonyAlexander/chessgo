// Pure UCI output parsing — no I/O, no globals, nothing that touches a worker
// or the network. Fed line-by-line by localEngine.ts (real engine output in
// production, hand-written strings in tests). Kept deliberately dumb: a line
// either parses into a typed result or it doesn't, and "doesn't" is `null`,
// never a thrown exception — engine stdout is adversarial-by-accident (partial
// lines, `info string` free text, tokens we don't know about yet), and a
// single garbage line must never take down the whole parse loop.
//
// UCI does not guarantee token order within a line (see the protocol spec:
// "the engine can send further info ... in any order" — depth/seldepth/score/
// nodes/etc are all independent sub-commands). The one convention every real
// engine follows is that `pv` is always LAST — its move list runs to the end
// of the line — so we lean on that rather than trying to bound it any other
// way.

export interface EngineScore {
    type: 'cp' | 'mate'
    value: number
}

export interface EngineInfo {
    depth: number
    seldepth?: number
    multipv?: number
    score: EngineScore
    // Set when the engine flagged this score with UCI's `lowerbound`/
    // `upperbound` suffix on `score cp` — i.e. this is an aspiration-window
    // fail-high/fail-low, not a settled value.
    //
    // POLICY: we still parse and return bound-flagged lines (dropping them
    // entirely would also throw away real depth/nodes/pv progress carried on
    // the same line), but we flag them so a caller deciding whether to UPDATE
    // a displayed eval can choose to hold the last exact score instead —
    // Stockfish's own GUIs do the same, since a fail-high number is a "maybe
    // bigger than this" placeholder, not the position's value. See
    // precedence.ts / localEngine.ts for where that choice actually gets made;
    // this module only surfaces the flag.
    bound?: 'lower' | 'upper'
    nodes?: number
    nps?: number
    timeMs?: number
    pv: string[]
}

// Consume exactly one token as an integer, whether or not it parses — the
// caller must always be able to advance past a malformed value, or a garbage
// numeric field (`depth abc`) would spin the parser loop forever instead of
// just failing to populate that one field.
function makeTokenCursor(tokens: string[]) {
    let i = 0
    return {
        peek: (): string | undefined => tokens[i],
        next: (): string | undefined => tokens[i++],
        nextInt: (): number | undefined => {
            const t = tokens[i]
            if (t === undefined) return undefined
            i++
            const n = Number(t)
            return Number.isFinite(n) ? n : undefined
        },
        atEnd: (): boolean => i >= tokens.length,
        skipToEnd: (): void => {
            i = tokens.length
        },
        rest: (): string[] => tokens.slice(i),
    }
}

/** Parse one `info ...` line. Returns `null` for anything that carries no
 * evaluation — `info string ...` (free text), `info depth 4 currmove e2e4
 * currmovenumber 1` (progress ping, no score yet), truncated lines, and
 * anything that isn't an `info` line at all. Never throws. */
export function parseInfo(line: string): EngineInfo | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    const tokens = trimmed.split(/\s+/)
    if (tokens[0] !== 'info') return null

    const cur = makeTokenCursor(tokens.slice(1))
    let depth: number | undefined
    let seldepth: number | undefined
    let multipv: number | undefined
    let score: EngineScore | undefined
    let bound: 'lower' | 'upper' | undefined
    let nodes: number | undefined
    let nps: number | undefined
    let timeMs: number | undefined
    let pv: string[] = []

    while (!cur.atEnd()) {
        const tok = cur.next()
        switch (tok) {
            case 'depth':
                depth = cur.nextInt()
                break
            case 'seldepth':
                seldepth = cur.nextInt()
                break
            case 'multipv':
                multipv = cur.nextInt()
                break
            case 'nodes':
                nodes = cur.nextInt()
                break
            case 'nps':
                nps = cur.nextInt()
                break
            case 'time':
                timeMs = cur.nextInt()
                break
            case 'score': {
                const kind = cur.next()
                if (kind === 'cp' || kind === 'mate') {
                    const value = cur.nextInt()
                    if (value !== undefined) score = { type: kind, value }
                }
                // The bound flag, if present, immediately follows the score value —
                // real engines never interleave another sub-command in between.
                if (cur.peek() === 'lowerbound') {
                    bound = 'lower'
                    cur.next()
                } else if (cur.peek() === 'upperbound') {
                    bound = 'upper'
                    cur.next()
                }
                break
            }
            case 'pv':
                // Runs to end of line by convention — see file header.
                pv = cur.rest()
                cur.skipToEnd()
                break
            case 'string':
                // Everything after `string` is free text meant for a human, not more
                // sub-commands (e.g. "info string NNUE evaluation using ..."). Stop
                // parsing so we don't mistake a word in that sentence for a keyword.
                cur.skipToEnd()
                break
            default:
                // An info sub-command we don't otherwise care about — currmove,
                // currmovenumber, hashfull, tbhits, cpuload, refutation, currline, ...
                // We don't track most of these but must still not choke on them; every
                // one we've seen takes exactly one value token, so skip one and move on.
                cur.next()
                break
        }
    }

    if (!score) return null // no evaluation on this line — nothing for a caller to show
    return { depth: depth ?? 0, seldepth, multipv, score, bound, nodes, nps, timeMs, pv }
}

/** Parse one `bestmove ...` line. Handles both `bestmove e2e4 ponder e7e5`
 * and the no-ponder / no-legal-move form `bestmove (none)`. Returns `null` for
 * anything else, never throws. */
export function parseBestmove(line: string): { bestmove: string; ponder?: string } | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    const tokens = trimmed.split(/\s+/)
    if (tokens[0] !== 'bestmove') return null

    const bestmove = tokens[1]
    if (!bestmove) return null

    const ponderIdx = tokens.indexOf('ponder')
    const ponder = ponderIdx !== -1 ? tokens[ponderIdx + 1] : undefined
    return ponder ? { bestmove, ponder } : { bestmove }
}

/** Convert a parsed UCI `EngineScore` into chessgo's `Analysis['eval']` shape
 * (see api/client.ts).
 *
 * FINDING — verified by reading client.ts and Analysis.tsx, not assumed:
 * UCI's `score` is, per protocol, from the point of view of the side to move
 * in the position the engine was given. `Analysis.eval` is documented the
 * same way (the sibling `SfAnalysis.eval` field is annotated "side-to-move
 * POV" in client.ts) and, more convincingly, is CONSUMED the same way —
 * Analysis.tsx's progressive-deepening effect does
 * `const white = stm === 'w' ? r.eval.value : -r.eval.value`
 * to derive a White-POV number for the eval bar, i.e. it treats the raw
 * `r.eval.value` from the server as side-to-move POV and does the flip itself
 * downstream. A raw UCI score and a raw `Analysis.eval` are therefore the same
 * number under the same convention: NO sign flip belongs in this layer.
 *
 * This function is an explicit identity conversion, not a forgotten no-op —
 * it exists so this equivalence is asserted and tested in one place instead of
 * re-derived (or silently gotten wrong) three files away, and so a future
 * engine build that violates the convention fails a test here.
 */
export function engineScoreToAnalysisEval(score: EngineScore): { type: 'cp' | 'mate'; value: number } {
    return { type: score.type, value: score.value }
}
