import { Box, CircularProgress, Typography } from '@mui/material'
import {
    CheckCircle2,
    ChevronRight,
    Infinity as InfinityIcon,
    Undo2,
    Volume2,
    VolumeX,
    XCircle,
    Zap,
} from 'lucide-react'
import ClockCmp from '../Clock'
import { ActionBtn, ErrorBanner, NavBtn } from '../PanelUI'
import type { PremoveGame, PremoveReleaseResult } from '../../api/client'
import { Card, Chip, Label, Row, SideBadge, type Phase } from './PremoveUI'

// The clock's remaining time. `resume_at` is a future stamp until it passes
// (see the contract's §2.2/§2.3), so this reads as FROZEN at `clock_ms` right
// up until that instant, then counts down for real — no local timer needed.
function remainingMsFor(clockMs: number | null, resumeAt: number | null): number {
    if (clockMs == null) return 0
    if (resumeAt == null) return clockMs
    const now = Date.now()
    if (now < resumeAt) return clockMs
    return Math.max(0, clockMs - (now - resumeAt))
}

const END_REASON_TEXT: Record<string, (collapsedAt: number | null) => string> = {
    mated: () => 'The defender mated you.',
    flagged: () => "Flagged — you're out of time.",
    stalemate: () => 'Stalemate.',
    draw: () => 'Drawn.',
    'chain-broke': (k) => `The chain broke at move ${(k ?? 0) + 1}.`,
    unresolved: () => "The chain ran out — no mate found.",
}

/** Desktop-only left rail while a game is live or just finished. */
export function PlayingAside({
    game,
    streak,
    bestStreak,
}: {
    game: PremoveGame
    streak: number
    bestStreak: number
}) {
    return (
        <Card sx={{ p: 2.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                <Box
                    sx={{
                        width: 34,
                        height: 34,
                        borderRadius: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: 'var(--accent-soft)',
                        border: '1px solid var(--accent-line)',
                        color: 'var(--accent)',
                    }}
                >
                    <Zap size={18} />
                </Box>
                <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}>
                    Premove Trainer
                </Typography>
            </Box>

            {game.rating && (
                <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
                    <Label>Your premove rating</Label>
                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 30,
                                fontWeight: 700,
                                color: 'var(--accent)',
                                lineHeight: 1,
                            }}
                        >
                            {game.rating.after ?? game.rating.before}
                            {game.rating.provisional ? '?' : ''}
                        </Typography>
                    </Box>
                </Box>
            )}

            <Box
                sx={{
                    borderTop: '1px solid var(--line-soft)',
                    mt: 2.25,
                    pt: 2.25,
                    display: 'flex',
                    gap: 2.5,
                }}
            >
                <Box>
                    <Label>Streak</Label>
                    <Typography
                        sx={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, lineHeight: 1 }}
                    >
                        {streak}
                    </Typography>
                </Box>
                <Box>
                    <Label>Best</Label>
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 22,
                            fontWeight: 700,
                            lineHeight: 1,
                            color: 'var(--muted)',
                        }}
                    >
                        {bestStreak}
                    </Typography>
                </Box>
            </Box>

            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25, display: 'flex', gap: 0.75 }}>
                <Chip>{game.format === 'rated' ? '15+0 · Rated' : 'Casual'}</Chip>
            </Box>
        </Card>
    )
}

export function StatusCard({
    phase,
    game,
    resultData,
    mateInN,
    queuedCount,
    maxChain,
    lastBreak,
    error,
    sound,
    streak,
    bestStreak,
    creating,
    onToggleSound,
    onRelease,
    onNext,
    onChangeFormat,
}: {
    phase: Phase
    game: PremoveGame
    resultData: PremoveReleaseResult | null
    /** Player-move count in a won attempt ("Mate in N"); null otherwise. */
    mateInN: number | null
    queuedCount: number
    maxChain: number
    /**
     * Set only in the rated format, when a release came back with the attempt
     * still ongoing: either the chain collapsed against a defence we didn't
     * assume (`collapsedAt` = 0-based index into the chain we sent), or it simply
     * ran out without mating (`collapsedAt` null).
     *
     * This is the moment the whole mode exists for, and it is easy to miss: the
     * board just changed and the clock is running again. Without a line saying so
     * the player is left working out from scratch why it's their turn.
     */
    lastBreak: { collapsedAt: number | null } | null
    error: string | null
    sound: boolean
    streak: number
    bestStreak: number
    /** A new attempt (NEXT) is in flight — disables NEXT/Change format so a
     *  double-click can't fire two createPremoveGame requests racing to
     *  decide the current game. */
    creating: boolean
    onToggleSound: () => void
    onRelease: () => void
    onNext: () => void
    onChangeFormat: () => void
}) {
    const terminal = phase === 'result'

    return (
        <Card sx={{ overflow: 'hidden' }}>
            {/* Clock + sound */}
            <Box
                sx={{
                    px: 2.25,
                    py: 1.75,
                    borderBottom: '1px solid var(--line-soft)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.75, minWidth: 0 }}>
                    {game.format === 'rated' ? (
                        <ClockCmp
                            getMs={() => remainingMsFor(game.clock_ms, game.resume_at)}
                            active={game.status === 'ongoing'}
                            running={game.status === 'ongoing'}
                        />
                    ) : (
                        <Box
                            sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--text-dim)' }}
                        >
                            <InfinityIcon size={18} />
                            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 15 }}>
                                Casual
                            </Typography>
                        </Box>
                    )}
                    <SideBadge color={game.player_color} />
                </Box>
                {/* The mobile Rated/Casual chip that used to sit here is gone: the
                    left group already says it (a running clock IS the rated format,
                    the infinity mark IS casual), and at 375px it crowded out the
                    side badge, which carries information nothing else does. */}
                <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={onToggleSound}>
                    {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                </NavBtn>
            </Box>

            {/* Headline */}
            <Box sx={{ px: 2.25, py: 2.25 }}>
                {(phase === 'queuing' || phase === 'releasing') && (
                    <>
                        <Typography
                            sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20 }}
                        >
                            {lastBreak ? 'Keep going' : 'Force the mate'}
                        </Typography>
                        <Typography
                            sx={{
                                fontSize: 13.5,
                                mt: 0.25,
                                color: lastBreak ? 'var(--warn)' : 'var(--muted)',
                            }}
                        >
                            {lastBreak
                                ? lastBreak.collapsedAt !== null
                                    ? `Your chain broke at move ${lastBreak.collapsedAt + 1} — the defender went elsewhere. Clock's running.`
                                    : "Chain played out, no mate yet. Clock's running."
                                : "There is a forced mate. Queue the whole thing — it works against any defence."}
                        </Typography>
                    </>
                )}
                {phase === 'animating' && (
                    <Row>
                        <CircularProgress size={16} sx={{ color: 'var(--muted)' }} />
                        <Typography sx={{ fontSize: 15, color: 'var(--text-dim)' }}>
                            Playing it out…
                        </Typography>
                    </Row>
                )}
                {terminal && game.status === 'won' && (
                    <Row>
                        <CheckCircle2 size={24} color="#7bb661" />
                        <Box>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-display)',
                                    fontWeight: 700,
                                    fontSize: 20,
                                    color: '#7bb661',
                                }}
                            >
                                {mateInN != null ? `Mate in ${mateInN}` : 'Checkmate!'}
                            </Typography>
                        </Box>
                    </Row>
                )}
                {terminal && game.status === 'lost' && (
                    <Row>
                        <XCircle size={24} color="#e0796b" />
                        <Box>
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-display)',
                                    fontWeight: 700,
                                    fontSize: 20,
                                    color: '#e0796b',
                                }}
                            >
                                {game.end_reason
                                    ? (END_REASON_TEXT[game.end_reason]?.(resultData?.collapsed_at ?? null) ??
                                      'Not this time.')
                                    : 'Not this time.'}
                            </Typography>
                        </Box>
                    </Row>
                )}

                {/* Anonymous player, rated format: nothing is being rated. Shown
                    quietly, doesn't block play (contract §7/§11). */}
                {game.format === 'rated' && !game.rated && (
                    <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 1.25 }}>
                        Sign in to be rated.
                    </Typography>
                )}

                {terminal && game.rating?.delta != null && (
                    <Typography
                        sx={{
                            mt: 1.25,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13.5,
                            color: game.rating.delta >= 0 ? '#7bb661' : '#e0796b',
                        }}
                    >
                        Your rating {game.rating.after}
                        {game.rating.provisional ? '?' : ''} ({game.rating.delta >= 0 ? '+' : ''}
                        {game.rating.delta})
                    </Typography>
                )}
            </Box>

            {/* Controls */}
            <Box sx={{ px: 2.25, pb: 2.25, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                {!terminal && (
                    <>
                        <ActionBtn
                            tone="primary"
                            large
                            icon={<Zap size={17} />}
                            label={
                                phase === 'releasing'
                                    ? 'Releasing…'
                                    : `GO${queuedCount > 0 ? ` (${queuedCount})` : ''}`
                            }
                            onClick={onRelease}
                            disabled={phase !== 'queuing' || queuedCount === 0}
                        />
                        <Typography sx={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
                            {queuedCount}/{maxChain} queued · Enter or Space also releases
                        </Typography>
                    </>
                )}
                {terminal && (
                    <ActionBtn
                        tone="primary"
                        large
                        icon={<ChevronRight size={16} />}
                        label={creating ? 'Starting…' : 'Next'}
                        onClick={onNext}
                        disabled={creating}
                    />
                )}
                <ActionBtn
                    tone="neutral"
                    icon={<Undo2 size={15} />}
                    label="Change format"
                    onClick={onChangeFormat}
                    disabled={creating}
                />

                {error && <ErrorBanner sx={{ mx: 0, mt: 0 }}>{error}</ErrorBanner>}

                {/* Mobile-only: the desktop aside already carries this. */}
                <Typography
                    sx={{ display: { xs: 'block', md: 'none' }, fontSize: 12.5, color: 'var(--muted)' }}
                >
                    Streak:{' '}
                    <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        {streak}
                    </Box>{' '}
                    · Best:{' '}
                    <Box component="span" sx={{ fontFamily: 'var(--font-mono)', color: 'var(--text-dim)' }}>
                        {bestStreak}
                    </Box>
                </Typography>
            </Box>
        </Card>
    )
}
