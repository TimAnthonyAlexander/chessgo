import { useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { ChevronDown } from 'lucide-react'
import type { TutorCategoryReport, TutorComparison } from '../../api/client'
import MeterRow from './MeterRow'
import { cap, fmtGap, fmtValue, pieceLabel } from './format'

/** How far a grade must sit from parity to count as part of the story. Below
 * this a row is close enough to the band that stacking it at full height adds
 * length without adding a finding. */
const NOTABLE_GRADE = 0.18
/** Floor and ceiling on how many rows show before the reader has to ask for
 * more — never so few that an all-parity report shows almost nothing, never
 * so many that "show all" stops meaning anything. */
const MIN_VISIBLE = 4
const MAX_VISIBLE = 8

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x))
}

/**
 * Every measured metric, ranked by how far it sits from the peer band — best at
 * the top, so the meters stack into a wedge and the eye does the sorting.
 *
 * This replaced a three-column table. It is also where the phase and piece
 * breakdowns went: they are not separate claims, they are the same metric cut
 * by where on the board it happened, so they live one disclosure level inside
 * the metric they belong to instead of being two more tables underneath it.
 *
 * The list itself is progressive: only the rows far enough from parity to be
 * worth a look render by default (floor 4, ceiling 8). The near-parity middle
 * — unremarkable by construction — sits behind one "show all" disclosure so an
 * 11-metric report doesn't spend a full screen on rows nobody needed to read.
 * With no peer band there is nothing to rank by, so every row shows.
 */
export default function MetricList({ category }: { category: TutorCategoryReport }) {
    const noPeer = category.peer.tier === 'none'
    const [open, setOpen] = useState<string | null>(null)
    const [showAll, setShowAll] = useState(false)

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

    // Which rows carry the story: ranked by |grade|, clamped to [floor, ceiling].
    // Because `rows` is already sorted best-to-worst, picking by |grade| pulls
    // from both ends first — the wedge's strongest and weakest rows — and hides
    // the near-parity middle, which is exactly the tail that doesn't earn its
    // height.
    const visibleKeys = useMemo(() => {
        if (noPeer) return new Set(rows.map((r) => r.key))
        const notableCount = rows.filter(
            (r) => r.cmp && Math.abs(r.cmp.grade) >= NOTABLE_GRADE,
        ).length
        const target = Math.min(rows.length, clamp(notableCount, MIN_VISIBLE, MAX_VISIBLE))
        const ranked = [...rows].sort((a, b) => {
            const sa = a.cmp ? Math.abs(a.cmp.grade) : -1
            const sb = b.cmp ? Math.abs(b.cmp.grade) : -1
            return sb - sa
        })
        return new Set(ranked.slice(0, target).map((r) => r.key))
    }, [rows, noPeer])

    if (rows.length === 0) return null

    const hiddenCount = rows.length - visibleKeys.size

    const renderRow = (r: (typeof rows)[number]) => {
        const split = splits.get(r.key)
        const hasSplits = !noPeer && !!split && split.phases.length + split.pieces.length > 0
        const isOpen = open === r.key
        const cmp = noPeer ? null : r.cmp

        return (
            <Box
                key={r.key}
                sx={{
                    borderBottom: '1px solid var(--line-soft)',
                    '&:last-of-type': { borderBottom: 0 },
                }}
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
                        spread={cmp?.spread}
                        sample={r.sample}
                        higherIsBetter={r.higherIsBetter}
                        wording={cmp?.wording}
                        gapText={cmp ? fmtGap(cmp.mine, cmp.peer, cmp.unit) : undefined}
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
                    <Box
                        sx={{
                            pb: 1.5,
                            pl: { xs: 1.25, sm: 2 },
                            borderLeft: '1px solid var(--line)',
                            ml: 0.5,
                        }}
                    >
                        <SplitGroup title="By phase" items={split.phases} kind="phase" />
                        <SplitGroup title="By piece" items={split.pieces} kind="piece" />
                    </Box>
                )}
            </Box>
        )
    }

    const items: React.ReactNode[] = []
    let discloseInserted = false
    for (const r of rows) {
        const isVisible = visibleKeys.has(r.key)
        if (!isVisible && !discloseInserted) {
            discloseInserted = true
            items.push(
                <ShowAllRow
                    key="__show_all"
                    expanded={showAll}
                    total={rows.length}
                    hiddenCount={hiddenCount}
                    onToggle={() => setShowAll((v) => !v)}
                />,
            )
        }
        if (isVisible || showAll) items.push(renderRow(r))
    }

    return <Box>{items}</Box>
}

function ShowAllRow({
    expanded,
    total,
    hiddenCount,
    onToggle,
}: {
    expanded: boolean
    total: number
    hiddenCount: number
    onToggle: () => void
}) {
    return (
        <Box
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={onToggle}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onToggle()
                }
            }}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                py: 1,
                mx: -1,
                px: 1,
                borderRadius: '8px',
                cursor: 'pointer',
                color: 'var(--muted)',
                '&:hover': { bgcolor: 'var(--surface-2)', color: 'var(--text-dim)' },
                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
            }}
        >
            <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>
                {expanded ? 'Show fewer' : `Show all ${total}`}
            </Typography>
            {!expanded && (
                <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    ({hiddenCount} near your band)
                </Typography>
            )}
            <Box
                sx={{
                    display: 'inline-flex',
                    transform: expanded ? 'rotate(180deg)' : 'none',
                    transition: 'transform 120ms ease',
                }}
            >
                <ChevronDown size={14} />
            </Box>
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
                        spread={c.spread}
                        sample={c.sample}
                        wording={c.wording}
                        gapText={fmtGap(c.mine, c.peer, c.unit)}
                    />
                ))}
            </Box>
        </Box>
    )
}
