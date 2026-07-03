import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import type { SxProps, Theme } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import { Panel, PanelHead } from './Panel'
import SkeletonBar from './SkeletonBar'
import { getLeaderboard, type LeaderboardEntry } from '../../api/client'
import type { Category } from '../../lib/timeControl'

// Duck Chess is an isolated rating pool, not a time control — its own tab here.
type Tab = Category | 'Duck'
const CATEGORIES: Tab[] = ['Bullet', 'Blitz', 'Rapid', 'Classical', 'Duck']
const DEFAULT_CATEGORY: Tab = 'Blitz'

/** The lowercase wire value the API expects ('blitz'), derived from the display tab. */
function apiKey(cat: Tab): 'bullet' | 'blitz' | 'rapid' | 'classical' | 'duck' {
    return cat.toLowerCase() as 'bullet' | 'blitz' | 'rapid' | 'classical' | 'duck'
}

type LoadState =
    { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; entries: LeaderboardEntry[] }

/** Homepage sidebar widget: per-category top-5 leaderboard with a category toggle.
 * Self-contained — fetches its own data and re-fetches when the category changes. */
export default function LeaderboardWidget() {
    const navigate = useNavigate()
    const [category, setCategory] = useState<Tab>(DEFAULT_CATEGORY)
    const [state, setState] = useState<LoadState>({ kind: 'loading' })

    useEffect(() => {
        let cancelled = false
        setState({ kind: 'loading' })
        getLeaderboard(apiKey(category))
            .then((res) => {
                if (cancelled) return
                setState({ kind: 'ready', entries: res.entries.slice(0, 5) })
            })
            .catch(() => {
                if (cancelled) return
                setState({ kind: 'error' })
            })
        return () => {
            cancelled = true
        }
    }, [category])

    const toggle = (
        <Box sx={{ display: 'flex', gap: 1.25, flexWrap: 'wrap' }}>
            {CATEGORIES.map((cat) => {
                const active = cat === category
                return (
                    <Box
                        key={cat}
                        component="button"
                        type="button"
                        onClick={() => setCategory(cat)}
                        sx={{
                            appearance: 'none',
                            cursor: 'pointer',
                            font: 'inherit',
                            background: 'none',
                            border: 'none',
                            p: 0,
                            fontSize: 12.5,
                            fontWeight: active ? 700 : 500,
                            lineHeight: 1,
                            color: active ? 'var(--accent)' : 'var(--muted)',
                            transition: 'color 0.12s ease',
                            '&:hover': { color: active ? 'var(--accent)' : 'var(--text)' },
                        }}
                    >
                        {cat}
                    </Box>
                )
            })}
        </Box>
    )

    return (
        <Panel>
            <PanelHead title="Leaderboard" action={toggle} />
            {state.kind === 'loading' && <SkeletonRows />}
            {state.kind === 'error' && (
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', py: 4, textAlign: 'center' }}
                >
                    Couldn't load the leaderboard
                </Typography>
            )}
            {state.kind === 'ready' && state.entries.length === 0 && (
                <Typography
                    sx={{ fontSize: 13, color: 'var(--muted)', py: 4, textAlign: 'center' }}
                >
                    No ranked players yet
                </Typography>
            )}
            {state.kind === 'ready' && state.entries.length > 0 && (
                <Box sx={{ mx: { xs: -2, md: -2.5 } }}>
                    {state.entries.map((e, i) => (
                        <Box
                            key={e.id}
                            component="button"
                            type="button"
                            onClick={() => navigate(`/@/${encodeURIComponent(e.name)}`)}
                            sx={{
                                appearance: 'none',
                                cursor: 'pointer',
                                font: 'inherit',
                                width: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1.5,
                                px: { xs: 2, md: 2.5 },
                                py: 0.9,
                                border: 'none',
                                borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                                bgcolor: 'transparent',
                                textAlign: 'left',
                                transition: 'background-color 0.12s ease',
                                '&:hover': { bgcolor: 'var(--surface-2)' },
                            }}
                        >
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 12.5,
                                    color: 'var(--muted)',
                                    minWidth: 18,
                                    textAlign: 'right',
                                }}
                            >
                                {e.rank}
                            </Typography>
                            <Typography
                                sx={{
                                    flex: 1,
                                    minWidth: 0,
                                    fontSize: 14,
                                    fontWeight: e.rank === 1 ? 600 : 400,
                                    color: 'var(--text)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                }}
                            >
                                {e.name}
                            </Typography>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 13.5,
                                    fontWeight: 600,
                                    color: 'var(--text)',
                                }}
                            >
                                {e.rating}
                                {e.provisional && (
                                    <Box component="span" sx={{ color: 'var(--muted)' }}>
                                        ?
                                    </Box>
                                )}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
        </Panel>
    )
}

// The name-column width per placeholder row — varied so the skeleton reads as a
// list of names rather than identical bars.
const SKELETON_NAME_W = ['64%', '52%', '58%', '45%', '61%']

// The loaded rows' text sits on a body1 line box (fontSize 14 × lineHeight 1.5 =
// 21px). The skeleton wraps each bar in a line box of the same height so a
// placeholder row is exactly as tall as the row that replaces it — no layout
// shift when the data lands.
const ROW_LINE_H = 21

/** Placeholder rows while the category fetch is in flight. Structurally mirrors
 * the loaded rows (same insets, padding, dividers, and line height) so the card
 * doesn't grow when the real entries arrive. */
function SkeletonRows() {
    return (
        <Box sx={{ mx: { xs: -2, md: -2.5 } }}>
            {SKELETON_NAME_W.map((nameW, i) => (
                <Box
                    key={i}
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5,
                        px: { xs: 2, md: 2.5 },
                        py: 0.9,
                        borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                    }}
                >
                    <LineBox sx={{ minWidth: 18, justifyContent: 'flex-end' }}>
                        <SkeletonBar w={12} />
                    </LineBox>
                    <LineBox sx={{ flex: 1 }}>
                        <SkeletonBar w={nameW} />
                    </LineBox>
                    <LineBox>
                        <SkeletonBar w={32} />
                    </LineBox>
                </Box>
            ))}
        </Box>
    )
}

/** A fixed-height flex cell that centres a skeleton bar on the same line box the
 * real text uses, so row heights match the loaded state exactly. */
function LineBox({
    children,
    sx,
}: {
    children: React.ReactNode
    sx?: SxProps<Theme>
}) {
    return (
        <Box
            sx={[
                { height: ROW_LINE_H, display: 'flex', alignItems: 'center' },
                ...(Array.isArray(sx) ? sx : [sx]),
            ]}
        >
            {children}
        </Box>
    )
}
