import { useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { ArrowRight, ChevronDown, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { TutorComparison, TutorDrill, TutorGameRow } from '../../api/client'
import { Panel } from '../home/Panel'
import MiniBoard from '../MiniBoard'
import ComparisonRow from './ComparisonRow'
import { cap, fmtDate, fmtGames, themeLabel } from './format'

/** Structural shape both `TutorGameRow` and the enriched `games` drill rows
 * satisfy, so `GamesTable` can render either without a TS union forcing every
 * property to exist on every member — every field past the first two is an
 * enrichment that may be entirely absent on an older stored row. */
interface GameRowLike {
    gameId: string
    playedAt: string | null
    color?: 'w' | 'b'
    result?: string
    reason?: string
    oppRating?: number | null
    accuracy?: number | null
    moves?: number
    clockLeftPct?: number | null
}

/**
 * One weakness, stated exactly once: the finding — via `ComparisonRow`, at
 * full weight (label, your value, the band's value, the meter, the verdict,
 * the sample) — with the one thing to do about it directly underneath. This
 * is the merge of what used to be two separate renders (a row in "Behind the
 * band" plus a standalone drill card repeating the same title): one card, one
 * claim, one action.
 *
 * A weakness the backend couldn't build an honest drill for (win rate, the
 * clock metrics) still renders this far and stops — no button, because a
 * button that opens something generic is worse than no button. It still gets
 * a real handoff where one exists: every finding's evidence is the same set
 * of measured games, so a plain link opens them rather than leaving a dead
 * end.
 */
export default function FindingCard({
    c,
    drill,
    gameRows,
}: {
    c: TutorComparison
    drill: TutorDrill | null
    /** The category's full measured-game list. Not invented data — these are
     *  exactly the games every metric in this category was computed from, so
     *  linking to them is showing the working, not guessing at it. */
    gameRows: TutorGameRow[]
}) {
    const navigate = useNavigate()
    // The 'games' drill already IS the evidence view (time-trouble games,
    // pre-filtered) — it renders its own table below, so the generic "see the
    // games" link would just be the same list twice.
    const showEvidenceLink = (!drill || drill.kind !== 'games') && gameRows.length > 0

    return (
        <Panel sx={{ mb: 2 }}>
            <ComparisonRow c={c} tone="weakness" />

            {drill && (
                <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid var(--line-soft)' }}>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 15,
                            fontWeight: 700,
                            lineHeight: 1.2,
                        }}
                    >
                        {drill.title}
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.5, mb: 1.5 }}>
                        {drill.blurb}
                    </Typography>

                    {drill.kind === 'puzzles' && (
                        <PuzzlesBody drill={drill} onNavigate={(to) => navigate(to)} />
                    )}
                    {drill.kind === 'replay' && (
                        <ReplayBody drill={drill} onNavigate={(to) => navigate(to)} />
                    )}
                    {drill.kind === 'opening' && (
                        <OpeningBody drill={drill} onNavigate={(to) => navigate(to)} />
                    )}
                    {drill.kind === 'games' && <GamesTable rows={drill.games ?? []} rowCap={12} />}
                </Box>
            )}

            {showEvidenceLink && <EvidenceLink gameRows={gameRows} />}
        </Panel>
    )
}

function PrimaryButton({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <Button
            variant="contained"
            onClick={onClick}
            endIcon={<ArrowRight size={15} />}
            sx={{ textTransform: 'none', fontWeight: 600 }}
        >
            {label}
        </Button>
    )
}

function PuzzlesBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    const themes = drill.themes ?? []
    if (themes.length === 0) return null
    const rest = themes.slice(1)
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box>
                <PrimaryButton
                    label="Drill these"
                    onClick={() => onNavigate(`/puzzles?theme=${encodeURIComponent(themes[0])}`)}
                />
            </Box>
            {rest.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                    {rest.map((t) => (
                        <Box
                            key={t}
                            onClick={() => onNavigate(`/puzzles?theme=${encodeURIComponent(t)}`)}
                            sx={{
                                fontSize: 11.5,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--text-dim)',
                                border: '1px solid var(--line)',
                                borderRadius: 'var(--radius)',
                                px: 1.1,
                                py: 0.4,
                                cursor: 'pointer',
                                '&:hover': {
                                    color: 'var(--accent)',
                                    borderColor: 'var(--accent-line)',
                                },
                            }}
                        >
                            {themeLabel(t)}
                        </Box>
                    ))}
                </Box>
            )}
        </Box>
    )
}

function ReplayBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    const positions = (drill.positions ?? []).slice(0, 5)
    if (positions.length === 0) return null
    const first = positions[0]
    const botUrl = (fen: string, color: string) =>
        `/bot?fen=${encodeURIComponent(fen)}&color=${encodeURIComponent(color)}`

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box>
                <PrimaryButton
                    label="Replay these positions"
                    onClick={() => onNavigate(botUrl(first.fen, first.color))}
                />
            </Box>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: 'repeat(auto-fill, minmax(96px, 1fr))',
                        sm: 'repeat(5, 96px)',
                    },
                    gap: 1.25,
                }}
            >
                {positions.map((p, i) => (
                    <Box key={`${p.gameId}-${p.ply}-${i}`} sx={{ minWidth: 0 }}>
                        <Box sx={{ width: 96 }}>
                            <MiniBoard fen={p.fen} orientation={p.color} />
                        </Box>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                color: 'var(--danger)',
                                mt: 0.5,
                            }}
                        >
                            -{Math.round(p.swing)} cp
                        </Typography>
                        {p.playedAt && (
                            <Typography sx={{ fontSize: 10.5, color: 'var(--muted)' }}>
                                {fmtDate(p.playedAt)}
                            </Typography>
                        )}
                        <Box
                            component="span"
                            onClick={() => onNavigate(botUrl(p.fen, p.color))}
                            sx={{
                                display: 'inline-block',
                                fontSize: 11.5,
                                color: 'var(--text-dim)',
                                cursor: 'pointer',
                                mt: 0.25,
                                '&:hover': { color: 'var(--accent)' },
                            }}
                        >
                            Play →
                        </Box>
                    </Box>
                ))}
            </Box>
        </Box>
    )
}

function OpeningBody({
    drill,
    onNavigate,
}: {
    drill: TutorDrill
    onNavigate: (to: string) => void
}) {
    if (!drill.opening) return null
    const colorQuery = drill.color ? `&color=${drill.color}` : ''
    return (
        <PrimaryButton
            label="Drill this opening"
            onClick={() =>
                onNavigate(`/bot?opening=${encodeURIComponent(drill.opening!)}${colorQuery}`)
            }
        />
    )
}

/** A weakness with no honest drill still gets a real handoff: every finding's
 * evidence is the same measured-game set, so a plain, collapsed-by-default
 * link opens the table rather than leaving the card as a dead end. Plain
 * link, not a button — the drill button (when there is one) stays the only
 * primary action on the card. */
function EvidenceLink({ gameRows }: { gameRows: TutorGameRow[] }) {
    const [open, setOpen] = useState(false)
    const sorted = [...gameRows].sort((a, b) => {
        const ta = a.playedAt ? new Date(a.playedAt).getTime() : 0
        const tb = b.playedAt ? new Date(b.playedAt).getTime() : 0
        return tb - ta
    })

    return (
        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid var(--line-soft)' }}>
            <Box
                component="button"
                onClick={() => setOpen((v) => !v)}
                sx={{
                    all: 'unset',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    cursor: 'pointer',
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    '&:hover': { color: 'var(--accent)' },
                    // `all: unset` above also unsets the focus ring, so put it
                    // back — this is the only keyboard affordance on the card.
                    '&:focus-visible': {
                        outline: '1px solid var(--accent-line)',
                        outlineOffset: '2px',
                        borderRadius: 'var(--radius)',
                    },
                }}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {open ? 'Hide the games' : `See the ${fmtGames(sorted.length)} behind this`}
            </Box>
            {open && (
                <Box sx={{ mt: 1.25 }}>
                    <GamesTable rows={sorted} rowCap={10} />
                </Box>
            )}
        </Box>
    )
}

/**
 * The real games table point D asks for: date, the outcome from THIS
 * player's perspective, how the game ended in plain words, opponent rating,
 * moves and accuracy — every column past date is optional on the row shape,
 * so a wholly-absent field hides its column instead of rendering a blank one
 * down the whole table. Rows link to the game's analysis.
 */
function GamesTable({ rows, rowCap }: { rows: GameRowLike[]; rowCap: number }) {
    const navigate = useNavigate()
    if (rows.length === 0) return null
    const shown = rows.slice(0, rowCap)
    const onOpen = (gameId: string) => navigate(`/analysis/${encodeURIComponent(gameId)}`)
    const cols = {
        result: shown.some((g) => g.color && g.result),
        reason: shown.some((g) => g.reason),
        opp: shown.some((g) => g.oppRating != null),
        moves: shown.some((g) => g.moves != null),
        acc: shown.some((g) => g.accuracy != null),
        clock: shown.some((g) => g.clockLeftPct != null),
    }

    return (
        <Box sx={{ overflowX: 'auto' }}>
            <Box
                component="table"
                sx={{ width: '100%', borderCollapse: 'collapse', minWidth: 460 }}
            >
                <Box component="thead">
                    <Box component="tr">
                        <Th align="left">Date</Th>
                        {cols.result && <Th>Result</Th>}
                        {cols.reason && <Th>Ended</Th>}
                        {cols.opp && <Th>Opp.</Th>}
                        {cols.moves && <Th>Moves</Th>}
                        {cols.acc && <Th>Acc.</Th>}
                        {cols.clock && <Th>Clock left</Th>}
                    </Box>
                </Box>
                <Box component="tbody">
                    {shown.map((g) => (
                        <GameRow key={g.gameId} g={g} cols={cols} onOpen={onOpen} />
                    ))}
                </Box>
            </Box>
            {rows.length > shown.length && (
                <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.75 }}>
                    +{rows.length - shown.length} more not shown
                </Typography>
            )}
        </Box>
    )
}

function GameRow({
    g,
    cols,
    onOpen,
}: {
    g: GameRowLike
    cols: {
        result: boolean
        reason: boolean
        opp: boolean
        moves: boolean
        acc: boolean
        clock: boolean
    }
    onOpen: (gameId: string) => void
}) {
    const outcome = outcomeFor(g)
    const outcomeColor =
        outcome === 'Win'
            ? 'var(--accent)'
            : outcome === 'Loss'
              ? 'var(--danger)'
              : 'var(--text-dim)'

    return (
        <Box
            component="tr"
            onClick={() => onOpen(g.gameId)}
            sx={{
                cursor: 'pointer',
                '&:hover': { bgcolor: 'var(--surface-2)' },
            }}
        >
            <Td align="left">{g.playedAt ? fmtDate(g.playedAt) : '—'}</Td>
            {cols.result && (
                <Td>
                    {outcome ? (
                        <Box component="span" sx={{ color: outcomeColor, fontWeight: 700 }}>
                            {outcome}
                        </Box>
                    ) : (
                        '—'
                    )}
                </Td>
            )}
            {cols.reason && <Td>{endingLabel(g.reason) ?? '—'}</Td>}
            {cols.opp && <Td>{g.oppRating ?? '—'}</Td>}
            {cols.moves && <Td>{g.moves ?? '—'}</Td>}
            {cols.acc && <Td>{g.accuracy != null ? `${g.accuracy}%` : '—'}</Td>}
            {cols.clock && (
                <Td>{g.clockLeftPct != null ? `${Math.round(g.clockLeftPct)}%` : '—'}</Td>
            )}
        </Box>
    )
}

// The game's raw PGN result ('1-0' / '0-1' / '1/2-1/2') is shared by both
// players — resolve it to THIS row's own outcome using its `color`, the same
// idiom TutorOpening.tsx's resultFor and profile/shared.ts's perspective()
// use. Either field can be absent on an older stored row, so this degrades to
// no outcome at all rather than guessing.
function outcomeFor(g: { color?: 'w' | 'b'; result?: string }): 'Win' | 'Loss' | 'Draw' | null {
    if (!g.color || !g.result) return null
    if (g.result === '1/2-1/2') return 'Draw'
    const whiteWon = g.result === '1-0'
    const won = g.color === 'w' ? whiteWon : !whiteWon
    return won ? 'Win' : 'Loss'
}

// How the game ended, in plain words. Falls back to a sentence-cased version
// of whatever the backend sent rather than hiding an unrecognised reason.
function endingLabel(reason?: string): string | null {
    if (!reason) return null
    const r = reason.toLowerCase()
    if (r === 'checkmate') return 'Checkmate'
    if (r === 'stalemate') return 'Stalemate'
    if (r === 'resign') return 'Resigned'
    if (r === 'agreement') return 'Draw agreed'
    if (r === 'adjudicated') return 'Adjudicated'
    if (r.startsWith('timeout')) return 'On time'
    // The stored draw reasons are rule names, not words — spelling them out
    // beats "Draw (seventyfive)", which is what a generic de-hyphenator gives.
    if (r === 'draw-fivefold') return 'Fivefold repetition'
    if (r === 'draw-threefold') return 'Threefold repetition'
    if (r === 'draw-seventyfive') return '75-move rule'
    if (r === 'draw-fiftymove') return '50-move rule'
    if (r === 'draw-insufficient-material') return 'Insufficient material'
    // zugzwang's own string when a flag lands against bare material
    // (gomachine/internal/server/server.go) — a draw, not a loss on time.
    if (r === 'draw-timeout-vs-insufficient-material') return 'Flag, no mating material'
    if (r.startsWith('draw-')) return 'Draw'
    return cap(r.replace(/-/g, ' '))
}

function Th({
    children,
    align = 'center',
}: {
    children: React.ReactNode
    align?: 'left' | 'center'
}) {
    return (
        <Box
            component="th"
            sx={{
                textAlign: align,
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--muted)',
                fontWeight: 600,
                py: 0.6,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </Box>
    )
}

function Td({
    children,
    align = 'center',
}: {
    children: React.ReactNode
    align?: 'left' | 'center'
}) {
    return (
        <Box
            component="td"
            sx={{
                textAlign: align,
                fontSize: 12,
                fontFamily: align === 'left' ? 'inherit' : 'var(--font-mono)',
                color: align === 'left' ? 'var(--text-dim)' : 'var(--text-dim)',
                py: 0.6,
                px: 1,
                borderBottom: '1px solid var(--line-soft)',
                whiteSpace: 'nowrap',
            }}
        >
            {children}
        </Box>
    )
}
