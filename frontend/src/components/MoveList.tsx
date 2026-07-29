import { memo, useEffect, useMemo, useRef } from 'react'
import { Box, useMediaQuery, useTheme } from '@mui/material'
import type { MoveEntry } from '../api/client'
import { MoveSan } from './MoveSan'

interface MoveListProps {
    moves: MoveEntry[]
    currentPly: number // 0 = start position, k = after k plies
    onSelectPly: (ply: number) => void
    visibleRows?: number // fixed number of full-move rows the panel shows before scrolling
    fill?: boolean // grow to fill the parent (full-height panel) instead of a fixed height
    startPly?: number // half-moves already played before moves[0] (mid-game seed); numbers/columns shift accordingly
}

const ROW_H = 31 // px per row on desktop
// Phones get a comfortable touch target instead. EVERY cell in a row uses this same
// pair — number gutter, real moves, the "…" placeholder and the empty padding cells
// alike — so a padded row is exactly as tall as a played one and a fixed-height list
// shows the same number of rows on both. Keep in sync with the fixed height below.
const ROW_H_XS = 44
const ROW_MIN = { xs: ROW_H_XS, md: ROW_H }
const DEFAULT_VISIBLE_ROWS = 10

/** Lichess-style move grid: number gutter, White column (lighter), Black column.
 * In fixed mode it always renders `visibleRows` rows tall — padded with empty rows
 * when there are fewer, scrollable once there are more — so the panel height never
 * jumps. In `fill` mode it grows to fill the parent and scrolls, for full-height
 * panels. */
function MoveList({
    moves,
    currentPly,
    onSelectPly,
    visibleRows = DEFAULT_VISIBLE_ROWS,
    fill = false,
    startPly = 0,
}: MoveListProps) {
    // Number and column-align by ABSOLUTE ply so a mid-game seed (a puzzle-seeded
    // watch filler that begins at, say, move 24 with Black to move) reads as a game
    // joined in progress — "24… Qxe5", not "1. Qxe5". moves[i]'s absolute half-move
    // index is startPly + i: even = White, odd = Black, fullmove = floor(abs/2)+1.
    // When the seed has Black to move first, the opening row shows a "…" placeholder
    // in the White column. startPly = 0 (the default) reproduces plain 1-based play.
    // Memoized on [moves, startPly] so an unrelated parent re-render doesn't rebuild
    // the grid (the component itself is React.memo'd too).
    const rows = useMemo(() => {
        const out: {
            no: number
            white?: MoveEntry
            black?: MoveEntry
            whiteElided?: boolean // render "…" for the pre-seed White move on a Black-to-move seed
        }[] = []
        let i = 0
        if (startPly % 2 === 1 && moves.length > 0) {
            out.push({ no: Math.floor(startPly / 2) + 1, whiteElided: true, black: moves[0] })
            i = 1
        }
        for (; i < moves.length; i += 2) {
            const abs = startPly + i
            out.push({ no: Math.floor(abs / 2) + 1, white: moves[i], black: moves[i + 1] })
        }
        return out
    }, [moves, startPly])
    const padCount = fill ? 0 : Math.max(0, visibleRows - rows.length)

    // Keep the active (latest-played / selected) row in view as moves come in, so the
    // newest moves don't disappear below the scroll cutoff. `block: 'nearest'` only
    // scrolls the move container, never the page. Desktop only: on mobile the move
    // list shares vertical scroll with the page, so auto-scrolling it on every move
    // yanks the viewport around — leave it be there.
    const isDesktop = useMediaQuery(useTheme().breakpoints.up('md'))
    const activeRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!isDesktop) return
        activeRef.current?.scrollIntoView({ block: 'nearest' })
    }, [currentPly, moves.length, isDesktop])

    const rowEls = (
        <>
            {rows.map((r) => {
                const isActive = r.white?.ply === currentPly || r.black?.ply === currentPly
                return (
                    <Box
                        key={r.no}
                        ref={isActive ? activeRef : undefined}
                        sx={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr' }}
                    >
                        <RowNumber no={r.no} />
                        {r.whiteElided ? (
                            <EllipsisCell />
                        ) : (
                            <Cell
                                entry={r.white}
                                whiteCol
                                current={currentPly}
                                onSelect={onSelectPly}
                            />
                        )}
                        <Cell entry={r.black} current={currentPly} onSelect={onSelectPly} />
                    </Box>
                )
            })}
            {Array.from({ length: padCount }, (_, k) => (
                <Box key={`pad-${k}`} sx={{ display: 'grid', gridTemplateColumns: '32px 1fr 1fr' }}>
                    <RowNumber />
                    <Cell whiteCol current={currentPly} onSelect={onSelectPly} />
                    <Cell current={currentPly} onSelect={onSelectPly} />
                </Box>
            ))}
        </>
    )

    // Fixed mode has a definite height, so it scrolls directly. Fill mode grows to
    // fill a full-height panel: on md the scroll area is absolutely positioned so its
    // content never grows the surrounding grid row (the panel then matches the board's
    // height and moves scroll inside). On xs the parent is already height-bounded, so
    // the outer box scrolls directly and the layout there is unchanged.
    if (!fill) {
        return (
            <Box
                aria-label="Move list"
                sx={{
                    height: { xs: visibleRows * ROW_H_XS, md: visibleRows * ROW_H },
                    overflowY: 'auto',
                }}
            >
                {rowEls}
            </Box>
        )
    }
    return (
        <Box
            aria-label="Move list"
            sx={{
                flex: 1,
                minHeight: 0,
                position: 'relative',
                overflowY: { xs: 'auto', md: 'visible' },
            }}
        >
            <Box sx={{ position: { md: 'absolute' }, inset: { md: 0 }, overflowY: { md: 'auto' } }}>
                {rowEls}
            </Box>
        </Box>
    )
}

// Memoized: the move grid only changes when its props do, so an unrelated parent
// re-render (a clock tick, an eval update) no longer rebuilds the whole list.
export default memo(MoveList)

function RowNumber({ no }: { no?: number }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: ROW_MIN,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
            }}
        >
            {no ?? ''}
        </Box>
    )
}

// EllipsisCell fills the White column of the opening row when a game is seeded
// mid-move with Black to play — a non-clickable "…" standing in for the move
// history that predates the seed (see startPly in MoveList).
function EllipsisCell() {
    return (
        <Box
            sx={{
                minHeight: ROW_MIN,
                display: 'flex',
                alignItems: 'center',
                px: 1.25,
                fontFamily: 'var(--font-mono)',
                fontSize: 13.5,
                fontWeight: 500,
                color: 'var(--muted)',
                bgcolor: 'rgba(255,255,255,0.05)',
            }}
        >
            …
        </Box>
    )
}

function Cell({
    entry,
    whiteCol,
    current,
    onSelect,
}: {
    entry?: MoveEntry
    whiteCol?: boolean
    current: number
    onSelect: (ply: number) => void
}) {
    const base = whiteCol ? 'rgba(255,255,255,0.05)' : 'transparent'
    if (!entry) {
        return <Box sx={{ minHeight: ROW_MIN, bgcolor: base }} />
    }
    const isCurrent = entry.ply === current
    const ply = entry.ply
    return (
        <Box
            component="button"
            type="button"
            aria-current={isCurrent ? 'step' : undefined}
            onClick={() => onSelect(ply)}
            sx={{
                // Comfortable touch target on phones, unchanged 31px look on desktop.
                minHeight: ROW_MIN,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-start',
                width: '100%',
                textAlign: 'left',
                border: 'none',
                m: 0,
                px: 1.25,
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: 13.5,
                fontWeight: 500,
                color: isCurrent ? '#fff' : 'var(--text)',
                bgcolor: isCurrent ? '#3a4880' : base,
                transition: 'background 0.1s ease',
                '&:hover': { bgcolor: isCurrent ? '#3a4880' : 'rgba(255,255,255,0.09)' },
                '&:focus-visible': { outline: '2px solid #5a6bd8', outlineOffset: '-2px' },
            }}
        >
            <MoveSan san={entry.san} />
        </Box>
    )
}
