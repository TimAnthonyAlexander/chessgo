// What a TABLEBASE verdict looks like on the wire, in one place.
//
// zugzwang scores a solved Syzygy position as VALUE_TB_WIN = 31497 internally
// (zugzwang/src/types.h). That used to arrive here as a plain `cp` value, and
// every renderer divides cp by 100 — so a won 5-man ending read "+314.97" on
// the eval bar and nobody noticed the engine was shuffling.
//
// The engine now sends (zugzwang/src/serve_json.h):
//
//     { type: 'cp', value: ±1000, tb: 'win' | 'loss' }
//
// `value` stays a sane, usable number so anything that only knows about
// {type, value} keeps working; `tb` carries the truth for anything that does.

export type TbVerdict = 'win' | 'loss'

/** Centipawns the engine substitutes for a tablebase verdict (TB_EVAL_CP). */
export const TB_CP = 1000

/**
 * Bottom of the RAW band: VALUE_TB_WIN − MAX_PLY. Only needed for an engine
 * older than this change — prod deploys the binary and the bundle separately,
 * so for a few minutes one can be new and the other not. No genuine evaluation
 * comes anywhere near 312 pawns, so the magnitude alone is conclusive.
 */
const TB_RAW_FLOOR = 31251

/** The verdict a side-to-move-relative eval carries, or null. */
export function tbOf(e: { type: 'cp' | 'mate'; value: number; tb?: TbVerdict } | null | undefined): TbVerdict | null {
    if (!e) return null
    if (e.tb === 'win' || e.tb === 'loss') return e.tb
    if (e.type !== 'cp') return null
    if (Math.abs(e.value) < TB_RAW_FLOOR) return null
    return e.value > 0 ? 'win' : 'loss'
}

/**
 * The same verdict from the other side. A verdict is side-to-move-relative
 * exactly like the value it rides on, so it must flip wherever that value is
 * negated — Black to move and losing by tablebase IS White winning by one.
 */
export function flipTb(tb: TbVerdict | null): TbVerdict | null {
    return tb === 'win' ? 'loss' : tb === 'loss' ? 'win' : null
}

/** A side-to-move eval's verdict, converted to White's point of view. */
export function tbWhite(
    e: { type: 'cp' | 'mate'; value: number; tb?: TbVerdict } | null | undefined,
    stm: 'w' | 'b',
): TbVerdict | null {
    const tb = tbOf(e)
    return stm === 'w' ? tb : flipTb(tb)
}

/**
 * What prints INSTEAD of the number, given a White-relative verdict: "TB" when
 * White has the tablebase win, "-TB" when Black does. Deliberately the same
 * shape as the mate labels next to it ("#3" / "-#2") — a verdict is not an
 * evaluation, so it doesn't get a number, but it is still just text in the same
 * column, with no colour or icon of its own.
 */
export function tbLabel(tb: TbVerdict): string {
    return tb === 'win' ? 'TB' : '-TB'
}

/**
 * The whole side-to-move → White conversion in one call: negate for Black and
 * flip the verdict with it. Structurally a `WhiteEval` (components/EvalBar) —
 * spelled out here rather than imported so the shared helper doesn't depend on
 * a component. Every eval bar on the site is fed through this.
 */
export function toWhiteEval(
    e: { type: 'cp' | 'mate'; value: number; tb?: TbVerdict } | null | undefined,
    stm: 'w' | 'b',
): { type: 'cp' | 'mate'; white: number; tb?: TbVerdict } | null {
    if (!e) return null
    const tb = tbWhite(e, stm)
    const white = stm === 'w' ? e.value : -e.value
    return tb ? { type: e.type, white, tb } : { type: e.type, white }
}

/** Screen-reader phrasing for a White-relative verdict. */
export function tbValueText(tb: TbVerdict): string {
    return tb === 'win' ? 'White wins, by tablebase' : 'Black wins, by tablebase'
}
