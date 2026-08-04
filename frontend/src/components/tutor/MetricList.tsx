import { useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { ChevronDown } from 'lucide-react'
import type { TutorCategoryReport, TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { cap, fmtValue, ordinal, pieceLabel } from './format'

/**
 * Every measured metric, ranked by how far it sits from the peer band — best at
 * the top, so the meters stack into a wedge and the eye does the sorting.
 *
 * This replaced a three-column table. It is also where the phase and piece
 * breakdowns went: they are not separate claims, they are the same metric cut
 * by where on the board it happened, so they live one disclosure level inside
 * the metric they belong to instead of being two more tables underneath it.
 */
export default function MetricList({ category }: { category: TutorCategoryReport }) {
    const noPeer = category.peer.tier === 'none'
    const [open, setOpen] = useState<string | null>(null)

    const splits = useMemo(() => {
        const m = new Map<string, { phases: TutorComparison[]; pieces: TutorComparison[] }>()
        const put = (c: TutorComparison, group: 'phases' | 'pieces') => {
            const entry = m.get(c.metric) ?? { phases: [], pieces: [] }
            entry[group].push(c)
            m.set(c.metric, entry)
        }
        for (const c of category.phases) put(c, 'phases')
        for (const c of category.pieces) put(c, 'pieces')
        return m
    }, [category.phases, category.pieces])

    const rows = useMemo(() => {
        const byKey = new Map<string, TutorComparison>()
        for (const c of category.comparisons) {
            if (c.dimension === '') byKey.set(c.metric, c)
        }

        const base = Object.entries(category.metrics).map(([key, m]) => ({
            key,
            label: m.label,
            valueText: fmtValue(m.value, m.unit),
            sample: m.sample,
            higherIsBetter: m.higherIsBetter,
            cmp: byKey.get(key) ?? null,
        }))

        // A metric can carry phase/piece splits without appearing in `metrics`
        // (or vice-versa). Never silently drop the splits — surface the parent
        // from its own comparison instead.
        const seen = new Set(base.map((r) => r.key))
        for (const [metric] of splits) {
            if (seen.has(metric)) continue
            const cmp = byKey.get(metric)
            base.push({
                key: metric,
                label: cmp?.label ?? cap(metric),
                valueText: cmp ? fmtValue(cmp.mine, cmp.unit) : '—',
                sample: cmp?.sample ?? 0,
                higherIsBetter: cmp?.higherIsBetter ?? true,
                cmp: cmp ?? null,
            })
        }

        // Ranked by grade; anything uncompared sinks to the bottom rather than
        // pretending to a position on the scale.
        return base.sort((a, b) => {
            const ga = a.cmp && !noPeer ? a.cmp.grade : Number.NEGATIVE_INFINITY
            const gb = b.cmp && !noPeer ? b.cmp.grade : Number.NEGATIVE_INFINITY
            if (ga === gb) return a.label.localeCompare(b.label)
            return gb - ga
        })
    }, [category.metrics, category.comparisons, splits, noPeer])

    if (rows.length === 0) return null

    return (
        <Box>
            {rows.map((r) => {
                const split = splits.get(r.key)
                const hasSplits =
                    !noPeer && !!split && split.phases.length + split.pieces.length > 0
                const isOpen = open === r.key
                const cmp = noPeer ? null : r.cmp

                return (
                    <Box
                        key={r.key}
                        sx={{ borderBottom: '1px solid var(--line-soft)', '&:last-of-type': { borderBottom: 0 } }}
                    >
                        <Box
                            {...(hasSplits
                                ? {
                                      role: 'button',
                                      tabIndex: 0,
                                      'aria-expanded': isOpen,
                                      onClick: () => setOpen(isOpen ? null : r.key),
                                      onKeyDown: (e: React.KeyboardEvent) => {
                                          if (e.key === 'Enter' || e.key === ' ') {
                                              e.preventDefault()
                                              setOpen(isOpen ? null : r.key)
                                          }
                                      },
                                  }
                                : {})}
                            sx={{
                                mx: -1,
                                px: 1,
                                borderRadius: '8px',
                                cursor: hasSplits ? 'pointer' : 'default',
                                '&:hover': hasSplits ? { bgcolor: 'var(--surface-2)' } : undefined,
                                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                            }}
                        >
                            <MeterRow
                                label={r.label}
                                valueText={r.valueText}
                                grade={cmp ? cmp.grade : null}
                                sample={r.sample}
                                higherIsBetter={r.higherIsBetter}
                                wording={cmp?.wording}
                                peerText={cmp ? `peer ${fmtValue(cmp.peer, cmp.unit)}` : undefined}
                                percentileText={
                                    cmp?.percentile != null ? `${ordinal(cmp.percentile)} pct` : undefined
                                }
                                trailing={
                                    hasSplits ? (
                                        <Box
                                            sx={{
                                                display: 'inline-flex',
                                                color: 'var(--muted)',
                                                transform: isOpen ? 'rotate(180deg)' : 'none',
                                                transition: 'transform 120ms ease',
                                            }}
                                        >
                                            <ChevronDown size={15} />
                                        </Box>
                                    ) : undefined
                                }
                            />
                        </Box>

                        {hasSplits && isOpen && split && (
                            <Box sx={{ pb: 1.5, pl: { xs: 1.25, sm: 2 }, borderLeft: '1px solid var(--line)', ml: 0.5 }}>
                                <SplitGroup title="By phase" items={split.phases} kind="phase" />
                                <SplitGroup title="By piece" items={split.pieces} kind="piece" />
                            </Box>
                        )}
                    </Box>
                )
            })}
        </Box>
    )
}

function SplitGroup({
    title,
    items,
    kind,
}: {
    title: string
    items: TutorComparison[]
    kind: 'phase' | 'piece'
}) {
    if (items.length === 0) return null
    const sorted = [...items].sort((a, b) => b.grade - a.grade)
    return (
        <Box sx={{ mt: 1 }}>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    mb: 0.25,
                }}
            >
                {title}
            </Typography>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' },
                    columnGap: 3,
                }}
            >
                {sorted.map((c, i) => (
                    <MeterRow
                        key={`${c.dimension}-${i}`}
                        density="compact"
                        label={
                            kind === 'piece'
                                ? pieceLabel(c.name ?? c.dimension)
                                : cap(c.name ?? c.dimension)
                        }
                        valueText={fmtValue(c.mine, c.unit)}
                        grade={c.grade}
                        sample={c.sample}
                        wording={c.wording}
                        peerText={`peer ${fmtValue(c.peer, c.unit)}`}
                    />
                ))}
            </Box>
        </Box>
    )
}
