import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { Bot, ChevronLeft, ChevronRight, Search, Skull } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { ProfileGame } from '../../api/client'
import { DuckGlyph } from '../DuckGlyph'
import { Panel, PanelHead } from '../home/Panel'
import {
    type CatFilter,
    fmtDate,
    OUTCOME_STYLE,
    perspective,
    type ResultFilter,
} from './shared'

// How long to wait after the last keystroke before the opponent search fires
// server-side (avoids one request per character).
const SEARCH_DEBOUNCE_MS = 300

const CAT_LABEL: Record<Exclude<CatFilter, 'all'>, string> = {
    bullet: 'Bullet',
    blitz: 'Blitz',
    rapid: 'Rapid',
    classical: 'Classical',
    duck: 'Duck',
    antichess: 'Antichess',
}

/** The player's game history: numbered pages (10/page) of rows, each a link into
 * analysis. Pool + result filtering is server-side (spans the whole history);
 * this component is presentational — the parent owns filter/page state and does
 * the fetching. The wide column of the profile dashboard. */
export default function GamesPanel({
    games,
    userId,
    page,
    totalPages,
    loading,
    onPage,
    category,
    result,
    availableCats,
    onCategory,
    onResult,
    opponent,
    dateFrom,
    dateTo,
    onOpponent,
    onDateFrom,
    onDateTo,
}: {
    games: ProfileGame[]
    userId: string
    page: number
    totalPages: number
    loading: boolean
    onPage: (n: number) => void
    category: CatFilter
    result: ResultFilter
    availableCats: CatFilter[]
    onCategory: (cat: CatFilter) => void
    onResult: (res: ResultFilter) => void
    // Opponent-name search (debounced client-side) + inclusive date range —
    // both server-side filters, composing with category/result above.
    opponent: string
    dateFrom: string
    dateTo: string
    onOpponent: (v: string) => void
    onDateFrom: (v: string) => void
    onDateTo: (v: string) => void
}) {
    const navigate = useNavigate()
    const unfiltered =
        category === 'all' && result === 'all' && !opponent && !dateFrom && !dateTo

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
                                onClick={() => onResult(r)}
                            />
                        ))}
                    </Box>
                }
            />

            <FilterBar
                opponent={opponent}
                dateFrom={dateFrom}
                dateTo={dateTo}
                onOpponent={onOpponent}
                onDateFrom={onDateFrom}
                onDateTo={onDateTo}
            />

            {availableCats.length > 2 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.5 }}>
                    {availableCats.map((f) => (
                        <Chip
                            key={f}
                            label={f === 'all' ? 'All' : CAT_LABEL[f]}
                            active={category === f}
                            onClick={() => onCategory(f)}
                        />
                    ))}
                </Box>
            )}

            {games.length === 0 ? (
                <Box
                    sx={{
                        p: 3,
                        textAlign: 'center',
                        color: 'var(--muted)',
                        fontSize: 13.5,
                    }}
                >
                    {unfiltered ? 'No games played yet.' : 'No games match this filter.'}
                </Box>
            ) : (
                <Box
                    sx={{
                        opacity: loading ? 0.5 : 1,
                        transition: 'opacity .12s ease',
                    }}
                >
                    {games.map((g, i) => (
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

            {totalPages > 1 && (
                <Paginator page={page} totalPages={totalPages} loading={loading} onPage={onPage} />
            )}
        </Panel>
    )
}

// Opponent search + date range, above the pool chips. Kept as plain bordered
// controls (no MUI TextField/DatePicker) so it matches the hand-styled Chip/
// PageBtn look already on this panel rather than introducing a new control style.
function FilterBar({
    opponent,
    dateFrom,
    dateTo,
    onOpponent,
    onDateFrom,
    onDateTo,
}: {
    opponent: string
    dateFrom: string
    dateTo: string
    onOpponent: (v: string) => void
    onDateFrom: (v: string) => void
    onDateTo: (v: string) => void
}) {
    // A local draft so every keystroke feels instant while the committed
    // (server-triggering) value only updates after the debounce settles.
    const [draft, setDraft] = useState(opponent)

    // Stay in sync if the committed value changes from outside (profile switch,
    // filters reset) without re-firing the debounce for that sync itself.
    useEffect(() => {
        setDraft(opponent)
    }, [opponent])

    useEffect(() => {
        if (draft === opponent) return
        const t = window.setTimeout(() => onOpponent(draft), SEARCH_DEBOUNCE_MS)
        return () => window.clearTimeout(t)
    }, [draft, opponent, onOpponent])

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 1.5 }}>
            <Box sx={{ position: 'relative', flex: '1 1 180px', minWidth: 140 }}>
                <Search
                    size={13}
                    color="var(--muted)"
                    style={{ position: 'absolute', left: 10, top: '50%', translate: '0 -50%' }}
                />
                <Box
                    component="input"
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="Search opponent"
                    aria-label="Search opponent"
                    sx={inputSx({ pl: 3 })}
                />
            </Box>
            <Box
                component="input"
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => onDateFrom(e.target.value)}
                aria-label="From date"
                sx={inputSx({ width: 132, flex: '0 0 auto', colorScheme: 'auto' })}
            />
            <Box
                component="input"
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => onDateTo(e.target.value)}
                aria-label="To date"
                sx={inputSx({ width: 132, flex: '0 0 auto', colorScheme: 'auto' })}
            />
        </Box>
    )
}

// Shared look for the hand-styled search/date inputs above — a quiet bordered
// field matching the Chip/PageBtn controls rather than the MUI default.
function inputSx(extra: Record<string, unknown>) {
    return {
        width: '100%',
        height: 32,
        px: 1.1,
        fontFamily: 'var(--font-display)',
        fontSize: 12.5,
        color: 'var(--text)',
        bgcolor: 'transparent',
        border: '1px solid var(--line-soft)',
        borderRadius: '8px',
        outline: 'none',
        transition: 'border-color .12s ease',
        '&::placeholder': { color: 'var(--muted)' },
        '&:focus': { borderColor: 'var(--accent-line)' },
        ...extra,
    }
}

// Page numbers to render, collapsing long runs to a single ellipsis around the
// first, last, and current±1 pages.
function pageRange(current: number, total: number): (number | 'gap')[] {
    const shown = [...new Set([1, total, current, current - 1, current + 1])]
        .filter((p) => p >= 1 && p <= total)
        .sort((a, b) => a - b)
    const out: (number | 'gap')[] = []
    let prev = 0
    for (const p of shown) {
        if (p - prev > 1) out.push('gap')
        out.push(p)
        prev = p
    }
    return out
}

function Paginator({
    page,
    totalPages,
    loading,
    onPage,
}: {
    page: number
    totalPages: number
    loading: boolean
    onPage: (n: number) => void
}) {
    return (
        <Box
            sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0.5, mt: 2 }}
        >
            <PageBtn
                disabled={page <= 1 || loading}
                onClick={() => onPage(page - 1)}
                label="Previous page"
            >
                <ChevronLeft size={16} />
            </PageBtn>
            {pageRange(page, totalPages).map((p, i) =>
                p === 'gap' ? (
                    <Box
                        key={`gap-${i}`}
                        sx={{ px: 0.5, color: 'var(--muted)', fontSize: 13, userSelect: 'none' }}
                    >
                        …
                    </Box>
                ) : (
                    <PageBtn
                        key={p}
                        active={p === page}
                        disabled={loading}
                        onClick={() => onPage(p)}
                        label={`Page ${p}`}
                    >
                        {p}
                    </PageBtn>
                ),
            )}
            <PageBtn
                disabled={page >= totalPages || loading}
                onClick={() => onPage(page + 1)}
                label="Next page"
            >
                <ChevronRight size={16} />
            </PageBtn>
        </Box>
    )
}

function PageBtn({
    children,
    active,
    disabled,
    onClick,
    label,
}: {
    children: React.ReactNode
    active?: boolean
    disabled?: boolean
    onClick: () => void
    label: string
}) {
    return (
        <Box
            component="button"
            type="button"
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            disabled={disabled}
            onClick={onClick}
            sx={{
                minWidth: 32,
                height: 32,
                px: 0.75,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: '9px',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                fontWeight: 700,
                cursor: disabled ? 'default' : 'pointer',
                bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-dim)',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line-soft)'}`,
                opacity: disabled && !active ? 0.4 : 1,
                transition: 'color .12s ease, border-color .12s ease, background .12s ease',
                '&:hover': disabled
                    ? {}
                    : { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
            }}
        >
            {children}
        </Box>
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
                            sx={{
                                display: 'inline-flex',
                                fontSize: 16,
                                flexShrink: 0,
                                color: 'var(--muted)',
                            }}
                        >
                            <DuckGlyph mono />
                        </Box>
                    )}
                    {game.variant === 'crazyhouse' && (
                        <Box
                            component="span"
                            title="Crazyhouse"
                            sx={{
                                display: 'inline-flex',
                                fontSize: 15,
                                flexShrink: 0,
                                color: 'var(--muted)',
                            }}
                        >
                            ⇄
                        </Box>
                    )}
                    {game.variant === 'antichess' && (
                        <Box
                            component="span"
                            title="Antichess"
                            sx={{
                                display: 'inline-flex',
                                flexShrink: 0,
                                color: 'var(--muted)',
                            }}
                        >
                            <Skull size={14} />
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
                                color: 'var(--muted)',
                                border: '1px solid var(--line-soft)',
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
                        fontVariantNumeric: 'tabular-nums',
                        color:
                            delta > 0
                                ? OUTCOME_STYLE.win.color
                                : delta < 0
                                  ? OUTCOME_STYLE.loss.color
                                  : 'var(--muted)',
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
