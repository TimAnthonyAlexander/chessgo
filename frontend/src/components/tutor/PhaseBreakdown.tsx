import { Box, Typography } from '@mui/material'
import type { TutorComparison } from '../../api/client'
import SegmentMeter, { stepFor, toneFor, TONE_INK } from './SegmentMeter'
import { SectionHead } from './parts'
import { cap, confidence, fmtGames, fmtValue, pieceLabel, relToBand } from './format'

/** Game phases read in play order, not by grade — "opening, middlegame,
 * endgame" is a sequence the reader already knows, and reordering it by
 * severity would cost more legibility than the ranking buys back. */
const PHASE_ORDER = ['opening', 'middlegame', 'endgame']

/**
 * "By phase" / "by piece": the cut of a metric across where on the board it
 * happened, as explicit figures rather than another full-width meter — Lichess
 * renders this as plain numbers and it reads clearer than a bar for a value
 * this granular. Each tile carries your number first, the band's underneath,
 * and a small SegmentMeter as support for the verdict, not as the message
 * itself.
 *
 * Today the backend only ever sends one metric per cut (accuracy for phases,
 * ACPL for pieces), but this groups by `metric` anyway so a future second cut
 * lands as its own labelled group instead of interleaving with the first.
 */
export default function PhaseBreakdown({
    title,
    items,
    noPeer,
    kind,
}: {
    title: string
    items: TutorComparison[]
    noPeer: boolean
    kind: 'phase' | 'piece'
}) {
    if (items.length === 0) return null

    const groups = new Map<string, TutorComparison[]>()
    for (const c of items) {
        const arr = groups.get(c.metric) ?? []
        arr.push(c)
        groups.set(c.metric, arr)
    }
    const entries = [...groups.entries()]
    const multi = entries.length > 1
    const compact = kind === 'piece'

    return (
        <Box sx={{ mb: 4 }}>
            <SectionHead
                title={title}
                sub={!multi ? entries[0][1][0].label : undefined}
            />
            {entries.map(([metric, group]) => (
                <Box key={metric} sx={{ mb: multi ? 2.5 : 0, '&:last-of-type': { mb: 0 } }}>
                    {multi && <GroupLabel>{group[0].label}</GroupLabel>}
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: {
                                xs: 'repeat(3, minmax(0, 1fr))',
                                sm: compact ? 'repeat(6, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))',
                            },
                            gap: compact ? 1.5 : 2.5,
                        }}
                    >
                        {order(group, kind, noPeer).map((c, i) => (
                            <Tile key={`${c.dimension}-${i}`} c={c} noPeer={noPeer} kind={kind} compact={compact} />
                        ))}
                    </Box>
                </Box>
            ))}
        </Box>
    )
}

/** Phases keep play order; pieces rank worst-first — "which pieces cost you
 * most" is the question, so the biggest cost leads. With no peer band there
 * is nothing to rank pieces by, so they stay in the order the backend sent. */
function order(items: TutorComparison[], kind: 'phase' | 'piece', noPeer: boolean): TutorComparison[] {
    if (kind === 'phase') {
        return [...items].sort(
            (a, b) => PHASE_ORDER.indexOf(a.name ?? a.dimension) - PHASE_ORDER.indexOf(b.name ?? b.dimension),
        )
    }
    if (noPeer) return items
    return [...items].sort((a, b) => a.grade - b.grade)
}

function Tile({
    c,
    noPeer,
    kind,
    compact,
}: {
    c: TutorComparison
    noPeer: boolean
    kind: 'phase' | 'piece'
    compact: boolean
}) {
    const name = kind === 'piece' ? pieceLabel(c.name ?? c.dimension) : cap(c.name ?? c.dimension)
    const tone = noPeer ? 'neutral' : toneFor(stepFor(c.grade))
    const tip = noPeer
        ? `${name}: ${fmtValue(c.mine, c.unit)}, from ${fmtGames(c.sample)}`
        : `${name}: you ${fmtValue(c.mine, c.unit)}, players at your rating ${fmtValue(c.peer, c.unit)} — ${relToBand(c.wording)}, from ${fmtGames(c.sample)}`

    return (
        <Box sx={{ minWidth: 0 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: compact ? 10 : 10.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 0.4,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                }}
            >
                {name}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: compact ? 15 : 19,
                    lineHeight: 1.15,
                    color: TONE_INK[tone],
                    fontVariantNumeric: 'tabular-nums',
                }}
            >
                {fmtValue(c.mine, c.unit)}
            </Typography>
            {!noPeer && (
                <>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: compact ? 10.5 : 11,
                            color: 'var(--muted)',
                            mt: 0.15,
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        avg {fmtValue(c.peer, c.unit)}
                    </Typography>
                    <Box sx={{ mt: 0.5 }}>
                        <SegmentMeter
                            grade={c.grade}
                            confidence={confidence(c.sample)}
                            height={compact ? 5 : 6}
                            title={tip}
                        />
                    </Box>
                </>
            )}
        </Box>
    )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--text-dim)',
                mb: 1,
            }}
        >
            {children}
        </Typography>
    )
}
