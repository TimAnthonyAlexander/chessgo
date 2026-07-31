import { useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@mui/material'
import type { TournamentSummary } from '../../api/client'
import { GROUP_ORDER, laneGroupOf, packLanes, type LaneGroup } from './groups'
import { hhmm, parseStartsAt } from './timing'
import TournamentBlock from './TournamentBlock'

const PX_PER_MINUTE = 6
const LANE_HEIGHT = 46
const LANE_GAP = 6
const TICK_MINUTES = 10
const TICK_MS = TICK_MINUTES * 60_000
const AXIS_HEIGHT = 30
// Room either side of the data so "now" can sit dead centre even when it's
// right next to the first/last known tournament.
const WINDOW_PAD_MS = 90 * 60_000
const NOW_COLOR = '#ef6c00'

function roundDown(ms: number): number {
    return Math.floor(ms / TICK_MS) * TICK_MS
}

function roundUp(ms: number): number {
    return Math.ceil(ms / TICK_MS) * TICK_MS
}

/** Lichess-style horizontal arena schedule: fixed-color lane groups (green
 * standard, green sub-bullet, purple restricted, brown variants — each only
 * rendered when it actually has blocks), one shared scroll container for the
 * time axis + every lane, auto-scrolled once on load so "now" starts centred. */
export default function TournamentTimeline({
    tournaments,
    now,
    onOpen,
}: {
    tournaments: TournamentSummary[]
    now: number
    onOpen: (id: string) => void
}) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const centeredRef = useRef(false)
    // A stable anchor for the visible window, taken once on mount — the window
    // itself shouldn't creep forward every tick just because `now` does.
    const [mountNow] = useState(() => Date.now())

    const items = useMemo(
        () =>
            tournaments
                .map((t) => ({
                    t,
                    start: parseStartsAt(t.starts_at),
                    finish: t.ends_at_ms,
                    group: laneGroupOf(t),
                }))
                .sort((a, b) => a.start - b.start),
        [tournaments],
    )

    const { windowStart, windowEnd } = useMemo(() => {
        const starts = items.map((i) => i.start)
        const finishes = items.map((i) => i.finish)
        const lo = Math.min(mountNow, ...starts)
        const hi = Math.max(mountNow, ...finishes)
        return { windowStart: roundDown(lo - WINDOW_PAD_MS), windowEnd: roundUp(hi + WINDOW_PAD_MS) }
    }, [items, mountNow])

    const trackWidth = ((windowEnd - windowStart) / 60_000) * PX_PER_MINUTE

    const lanes = useMemo(() => {
        const out: { group: LaneGroup; items: typeof items }[] = []
        for (const g of GROUP_ORDER) {
            const groupItems = items.filter((i) => i.group === g)
            if (groupItems.length === 0) continue
            for (const lane of packLanes(groupItems, (i) => i.start, (i) => i.finish)) {
                out.push({ group: g, items: lane })
            }
        }
        return out
    }, [items])

    const lanesHeight = lanes.length > 0 ? lanes.length * LANE_HEIGHT + (lanes.length - 1) * LANE_GAP : LANE_HEIGHT

    const ticks = useMemo(() => {
        const out: { x: number; hour: boolean; label: string | null }[] = []
        for (let ts = windowStart; ts <= windowEnd; ts += TICK_MS) {
            const hour = new Date(ts).getMinutes() === 0
            out.push({ x: ((ts - windowStart) / 60_000) * PX_PER_MINUTE, hour, label: hour ? hhmm(ts) : null })
        }
        return out
    }, [windowStart, windowEnd])

    const nowX = ((now - windowStart) / 60_000) * PX_PER_MINUTE

    // Auto-scroll so "now" starts centred — once, the first time there's a
    // track to scroll. Later polls can extend the track (new tournaments
    // appearing) without yanking the user's own scroll position around.
    useEffect(() => {
        const el = scrollRef.current
        if (!el || centeredRef.current || trackWidth <= 0) return
        centeredRef.current = true
        const nowXAtMount = ((mountNow - windowStart) / 60_000) * PX_PER_MINUTE
        const target = nowXAtMount - el.clientWidth / 2
        el.scrollLeft = Math.max(0, Math.min(target, trackWidth - el.clientWidth))
    }, [trackWidth, windowStart, mountNow])

    return (
        <Box
            ref={scrollRef}
            sx={{
                overflowX: 'auto',
                overflowY: 'hidden',
                WebkitOverflowScrolling: 'touch',
                border: '1px solid var(--line-soft)',
                borderRadius: '10px',
                bgcolor: 'var(--surface)',
            }}
        >
            <Box sx={{ position: 'relative', width: trackWidth, minWidth: '100%' }}>
                {/* Time axis: a tick every 10 minutes, bold labels on the hour. */}
                <Box sx={{ position: 'relative', height: AXIS_HEIGHT, borderBottom: '1px solid var(--line-soft)' }}>
                    {ticks.map((tk) => (
                        <Box
                            key={tk.x}
                            sx={{
                                position: 'absolute',
                                left: tk.x,
                                top: 0,
                                bottom: 0,
                                transform: 'translateX(-50%)',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                justifyContent: 'flex-end',
                                pb: '3px',
                            }}
                        >
                            {tk.hour && (
                                <Box
                                    component="span"
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11,
                                        fontWeight: 700,
                                        color: 'var(--text-dim)',
                                        mb: '3px',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {tk.label}
                                </Box>
                            )}
                            <Box
                                sx={{
                                    width: '1px',
                                    height: tk.hour ? 9 : 5,
                                    bgcolor: tk.hour ? 'var(--muted)' : 'var(--line-soft)',
                                }}
                            />
                        </Box>
                    ))}
                </Box>

                {/* Lanes. */}
                <Box sx={{ position: 'relative', height: lanesHeight }}>
                    <NowMarker x={nowX} />
                    {lanes.map((lane, i) => (
                        <Box
                            key={i}
                            sx={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: i * (LANE_HEIGHT + LANE_GAP),
                                height: LANE_HEIGHT,
                            }}
                        >
                            {lane.items.map(({ t, start, finish, group }) => (
                                <TournamentBlock
                                    key={t.id}
                                    t={t}
                                    group={group}
                                    left={((start - windowStart) / 60_000) * PX_PER_MINUTE}
                                    width={Math.max(4, ((finish - start) / 60_000) * PX_PER_MINUTE)}
                                    onClick={() => onOpen(t.id)}
                                />
                            ))}
                        </Box>
                    ))}
                </Box>
            </Box>
        </Box>
    )
}

/** The "now" line: a dashed orange rule through every lane with a small
 * triangle marking it where it meets the time axis. */
function NowMarker({ x }: { x: number }) {
    return (
        <Box
            sx={{
                position: 'absolute',
                left: x,
                top: -8,
                bottom: 0,
                zIndex: 2,
                pointerEvents: 'none',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    transform: 'translateX(-50%)',
                    width: 0,
                    height: 0,
                    borderLeft: '5px solid transparent',
                    borderRight: '5px solid transparent',
                    borderTop: `7px solid ${NOW_COLOR}`,
                }}
            />
            <Box
                sx={{
                    position: 'absolute',
                    top: 7,
                    bottom: 0,
                    left: '1px',
                    borderLeft: `2px dashed ${NOW_COLOR}`,
                }}
            />
        </Box>
    )
}
