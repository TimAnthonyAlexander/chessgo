import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Typography, useMediaQuery } from '@mui/material'
import type { TournamentSummary } from '../../api/client'
import { GROUP_COLOR, TRACK_GROUP, TRACK_LABEL, TRACK_ORDER, packLanes, trackOf, type Track } from './groups'
import { hhmm, parseStartsAt } from './timing'
import TournamentBlock from './TournamentBlock'

const PX_PER_MINUTE = 10
const LANE_HEIGHT = 64
const LANE_GAP = 8
const TICK_MINUTES = 10
const TICK_MS = TICK_MINUTES * 60_000
const AXIS_HEIGHT = 30
// Room either side of the data so "now" can sit dead centre even when it's
// right next to the first/last known tournament.
const WINDOW_PAD_MS = 90 * 60_000
const NOW_COLOR = '#ef6c00'
// The sticky left-hand label gutter naming each row's track. Shrinks under
// ~600px so it doesn't eat a phone screen's width.
const GUTTER_WIDTH = 104
const GUTTER_WIDTH_NARROW = 56

function roundDown(ms: number): number {
    return Math.floor(ms / TICK_MS) * TICK_MS
}

function roundUp(ms: number): number {
    return Math.ceil(ms / TICK_MS) * TICK_MS
}

/** Lichess-style horizontal arena schedule: one row per track (a speed class
 * for standard play, one per variant, one for restricted), each fixed-color
 * by its group (green standard, purple restricted, brown variant) and only
 * rendered when it actually has blocks, a sticky label gutter naming each
 * row, one shared scroll container for the time axis + every lane, and
 * auto-scrolled once on load so "now" starts centred. */
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
    const narrow = useMediaQuery('(max-width:600px)')
    const gutterWidth = narrow ? GUTTER_WIDTH_NARROW : GUTTER_WIDTH

    const items = useMemo(
        () =>
            tournaments
                .map((t) => {
                    const track = trackOf(t)
                    return {
                        t,
                        start: parseStartsAt(t.starts_at),
                        finish: t.ends_at_ms,
                        track,
                        group: TRACK_GROUP[track],
                    }
                })
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
        const out: { track: Track; items: typeof items; isFirstOfTrack: boolean }[] = []
        for (const track of TRACK_ORDER) {
            const trackItems = items.filter((i) => i.track === track)
            if (trackItems.length === 0) continue
            packLanes(trackItems, (i) => i.start, (i) => i.finish).forEach((lane, idx) => {
                out.push({ track, items: lane, isFirstOfTrack: idx === 0 })
            })
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

    // Auto-scroll so "now" starts centred in the visible (non-gutter) area —
    // once, the first time there's a track to scroll. Later polls can extend
    // the track (new tournaments appearing) without yanking the user's own
    // scroll position around.
    useEffect(() => {
        const el = scrollRef.current
        if (!el || centeredRef.current || trackWidth <= 0) return
        centeredRef.current = true
        const nowXAtMount = ((mountNow - windowStart) / 60_000) * PX_PER_MINUTE
        const totalWidth = gutterWidth + trackWidth
        const target = nowXAtMount - (el.clientWidth - gutterWidth) / 2
        el.scrollLeft = Math.max(0, Math.min(target, totalWidth - el.clientWidth))
    }, [trackWidth, windowStart, mountNow, gutterWidth])

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
            <Box sx={{ position: 'relative', width: gutterWidth + trackWidth, minWidth: '100%' }}>
                {/* Time axis: a tick every 10 minutes, bold labels on the hour. */}
                <Box sx={{ display: 'flex', position: 'relative', height: AXIS_HEIGHT, borderBottom: '1px solid var(--line-soft)' }}>
                    <Box
                        sx={{
                            width: gutterWidth,
                            flexShrink: 0,
                            position: 'sticky',
                            left: 0,
                            zIndex: 3,
                            bgcolor: 'var(--surface)',
                            borderRight: '1px solid var(--line-soft)',
                        }}
                    />
                    <Box sx={{ position: 'relative', width: trackWidth, flexShrink: 0 }}>
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
                </Box>

                {/* Lanes, one row per track, each with a sticky label cell. */}
                <Box sx={{ position: 'relative', height: lanesHeight }}>
                    <NowMarker x={gutterWidth + nowX} />
                    {lanes.map((lane, i) => (
                        <Box
                            key={i}
                            sx={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: i * (LANE_HEIGHT + LANE_GAP),
                                height: LANE_HEIGHT,
                                display: 'flex',
                            }}
                        >
                            <Box
                                sx={{
                                    width: gutterWidth,
                                    flexShrink: 0,
                                    position: 'sticky',
                                    left: 0,
                                    zIndex: 3,
                                    display: 'flex',
                                    alignItems: 'center',
                                    bgcolor: 'var(--surface)',
                                    borderRight: '1px solid var(--line-soft)',
                                    px: 1,
                                }}
                            >
                                {lane.isFirstOfTrack && (
                                    <Typography
                                        noWrap
                                        sx={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: narrow ? 9 : 10.5,
                                            fontWeight: 600,
                                            letterSpacing: '0.06em',
                                            textTransform: 'uppercase',
                                            color: GROUP_COLOR[TRACK_GROUP[lane.track]],
                                            opacity: 0.8,
                                        }}
                                    >
                                        {TRACK_LABEL[lane.track]}
                                    </Typography>
                                )}
                            </Box>
                            <Box sx={{ position: 'relative', width: trackWidth, flexShrink: 0 }}>
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
