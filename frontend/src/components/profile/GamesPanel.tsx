import { useMemo, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Bot } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ProfileGame } from '../../api/client'
import { DuckGlyph } from '../DuckGlyph'
import { Panel, PanelHead } from '../home/Panel'
import { fmtDate, OUTCOME_STYLE, perspective, TC_CATEGORIES } from './shared'

type CatFilter = 'all' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'duck' | 'chess960'
type ResultFilter = 'all' | 'win' | 'loss' | 'draw'

const CAT_LABEL: Record<Exclude<CatFilter, 'all'>, string> = {
    bullet: 'Bullet',
    blitz: 'Blitz',
    rapid: 'Rapid',
    classical: 'Classical',
    duck: 'Duck',
    chess960: '960',
}

function matchesCat(g: ProfileGame, f: CatFilter): boolean {
    if (f === 'all') return true
    if (f === 'duck') return g.variant === 'duck'
    if (f === 'chess960') return g.variant === 'chess960'
    return g.variant === 'standard' && g.category === f
}

/** The player's game history: filterable by pool + result (client-side over the
 * loaded pages), each row a link into analysis. The wide column of the profile
 * dashboard. */
export default function GamesPanel({
    games,
    userId,
    hasMore,
    loadingMore,
    onLoadMore,
}: {
    games: ProfileGame[]
    userId: string
    hasMore: boolean
    loadingMore: boolean
    onLoadMore: () => void
}) {
    const navigate = useNavigate()
    const [cat, setCat] = useState<CatFilter>('all')
    const [result, setResult] = useState<ResultFilter>('all')

    // Only offer pool/variant chips that actually appear in the loaded history.
    const catFilters = useMemo<CatFilter[]>(() => {
        const present = new Set<CatFilter>()
        for (const g of games) {
            if (g.variant === 'duck') present.add('duck')
            else if (g.variant === 'chess960') present.add('chess960')
            else if (g.category) present.add(g.category as CatFilter)
        }
        const all: CatFilter[] = [
            ...TC_CATEGORIES.map((c) => c.key as CatFilter),
            'duck',
            'chess960',
        ]
        const ordered = all.filter((f) => present.has(f))
        return ['all', ...ordered]
    }, [games])

    const filtered = useMemo(
        () =>
            games.filter(
                (g) =>
                    matchesCat(g, cat) &&
                    (result === 'all' || perspective(g, userId).outcome === result),
            ),
        [games, cat, result, userId],
    )

    return (
        <Panel>
            <PanelHead
                title="Games"
                action={
                    <Box sx={{ display: 'flex', gap: 0.5 }}>
                        {(['all', 'win', 'loss', 'draw'] as ResultFilter[]).map((r) => (
                            <Chip
                                key={r}
                                label={r === 'all' ? 'All' : OUTCOME_STYLE[r].label}
                                active={result === r}
                                color={r === 'all' ? undefined : OUTCOME_STYLE[r].color}
                                onClick={() => setResult(r)}
                            />
                        ))}
                    </Box>
                }
            />

            {catFilters.length > 2 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
                    {catFilters.map((f) => (
                        <Chip
                            key={f}
                            label={f === 'all' ? 'All' : CAT_LABEL[f]}
                            active={cat === f}
                            onClick={() => setCat(f)}
                        />
                    ))}
                </Box>
            )}

            {filtered.length === 0 ? (
                <Box
                    sx={{
                        p: 3,
                        textAlign: 'center',
                        color: 'var(--muted)',
                        fontSize: 13.5,
                    }}
                >
                    {games.length === 0 ? 'No games played yet.' : 'No games match this filter.'}
                </Box>
            ) : (
                <Box
                    sx={{
                        border: '1px solid var(--line-soft)',
                        borderRadius: '12px',
                        overflow: 'hidden',
                    }}
                >
                    {filtered.map((g, i) => (
                        <GameRow
                            key={g.id}
                            game={g}
                            userId={userId}
                            first={i === 0}
                            onClick={() => navigate(`/analysis/${g.id}`)}
                        />
                    ))}
                </Box>
            )}

            {hasMore && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
                    <Button
                        onClick={onLoadMore}
                        disabled={loadingMore}
                        variant="outlined"
                        color="inherit"
                        sx={{
                            textTransform: 'none',
                            borderColor: 'var(--line)',
                            color: 'var(--text-dim)',
                            '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
                        }}
                    >
                        {loadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                </Box>
            )}
        </Panel>
    )
}

function Chip({
    label,
    active,
    color,
    onClick,
}: {
    label: string
    active: boolean
    color?: string
    onClick: () => void
}) {
    return (
        <Box
            component="button"
            onClick={onClick}
            sx={{
                cursor: 'pointer',
                px: 1.1,
                py: 0.4,
                borderRadius: '999px',
                fontFamily: 'var(--font-display)',
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.4,
                bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? color ?? 'var(--accent)' : 'var(--text-dim)',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line-soft)'}`,
                transition: 'color .12s ease, border-color .12s ease, background .12s ease',
                '&:hover': { color: color ?? 'var(--accent)', borderColor: 'var(--accent-line)' },
            }}
        >
            {label}
        </Box>
    )
}

function GameRow({
    game,
    userId,
    first,
    onClick,
}: {
    game: ProfileGame
    userId: string
    first: boolean
    onClick: () => void
}) {
    const { outcome, color, opponent, opponentBot, delta } = perspective(game, userId)
    const o = OUTCOME_STYLE[outcome]
    // A game with no moves played (resigned/aborted on move 0) has nothing to
    // review — the analysis board would be a dead end, so it isn't clickable.
    const reviewable = game.ply > 0

    return (
        <Box
            onClick={reviewable ? onClick : undefined}
            role={reviewable ? 'button' : undefined}
            tabIndex={reviewable ? 0 : undefined}
            onKeyDown={
                reviewable
                    ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onClick()
                          }
                      }
                    : undefined
            }
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: { xs: 1.5, md: 2 },
                py: 1.25,
                cursor: reviewable ? 'pointer' : 'default',
                borderTop: first ? 'none' : '1px solid var(--line-soft)',
                transition: 'background .12s ease',
                outline: 'none',
                ...(reviewable
                    ? {
                          '&:hover': { bgcolor: 'var(--line)' },
                          '&:focus-visible': { bgcolor: 'var(--line)' },
                      }
                    : {}),
            }}
        >
            <Box
                sx={{
                    width: 26,
                    height: 26,
                    flexShrink: 0,
                    borderRadius: '7px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontWeight: 700,
                    fontSize: 13,
                    color: o.color,
                    border: `1px solid ${o.color}`,
                }}
            >
                {o.label}
            </Box>

            <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <Typography
                        sx={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: 'var(--text)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        vs {opponent || 'Anonymous'}
                    </Typography>
                    {opponentBot && <Bot size={13} color="var(--muted)" />}
                    {game.variant === 'duck' && (
                        <Box
                            component="span"
                            title="Duck Chess"
                            sx={{ display: 'inline-flex', fontSize: 16, flexShrink: 0 }}
                        >
                            <DuckGlyph />
                        </Box>
                    )}
                    {game.variant === 'chess960' && (
                        <Box
                            component="span"
                            title="Chess960"
                            sx={{
                                flexShrink: 0,
                                fontFamily: 'var(--font-mono)',
                                fontSize: 9.5,
                                fontWeight: 700,
                                color: 'var(--accent)',
                                border: '1px solid var(--accent-line)',
                                borderRadius: '4px',
                                px: 0.4,
                                py: '1px',
                                lineHeight: 1.2,
                            }}
                        >
                            960
                        </Box>
                    )}
                </Box>
                <Typography
                    sx={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'capitalize' }}
                >
                    {game.category || 'casual'} · {game.pool || '—'} · as {color}
                    {!game.rated && ' · casual'}
                    {!reviewable && ' · no moves'}
                </Typography>
            </Box>

            {delta != null && game.rated && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: delta > 0 ? '#5b9e5b' : delta < 0 ? '#ca4a4a' : 'var(--muted)',
                    }}
                >
                    {delta > 0 ? '+' : ''}
                    {delta}
                </Typography>
            )}

            <Typography
                sx={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                    minWidth: 64,
                    textAlign: 'right',
                }}
            >
                {fmtDate(game.created_at)}
            </Typography>
        </Box>
    )
}
