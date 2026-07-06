import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, CircularProgress, Slider, Typography } from '@mui/material'
import {
    ChevronFirst,
    ChevronLast,
    ChevronLeft,
    ChevronRight,
    FlipVertical2,
    Pause,
    Play,
    Volume2,
    VolumeX,
} from 'lucide-react'
import Board from '../components/Board'
import BoardPage from '../components/BoardPage'
import MoveList from '../components/MoveList'
import { ErrorBanner, NavBtn } from '../components/PanelUI'
import {
    type Color,
    guessEloGuess,
    guessEloNew,
    type GuessReveal,
    type GuessRound,
    type MoveEntry,
} from '../api/client'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useMoveNavKeys } from '../lib/useMoveNavKeys'

// The guessable human-Elo band + granularity — must match the server
// (GuessGameService: 700..2500, step 25).
const RATING_MIN = 700
const RATING_MAX = 2500
const RATING_STEP = 25
const DEFAULT_GUESS = 1600
const MOVE_DELAY = 500 // ms between plies on autoplay, so it's watchable

const sideToMoveOf = (fen: string): Color => (fen.split(' ')[1] === 'b' ? 'b' : 'w')

/** Map a raw result string to a human label. */
function resultLabel(result: string | null): string {
    if (result === '1-0') return 'White won'
    if (result === '0-1') return 'Black won'
    if (result === '1/2-1/2') return 'Draw'
    return ''
}

/**
 * Guess the Elo — watch a full gomachine-vs-itself game (played server-side at a
 * SECRET rating) and guess how strong it was. The client never receives the
 * rating; the game arrives looking like any "random game", and the answer is only
 * revealed server-side once you lock in a guess. See SPEC §Guess the Elo.
 */
export default function GuessTheElo() {
    const [round, setRound] = useState<GuessRound | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Replay state: ply = number of plies shown (0 = start position).
    const [ply, setPly] = useState(0)
    const [playing, setPlaying] = useState(false)
    const [orientation, setOrientation] = useState<Color>('w')
    const [sound, setSound] = useState(soundEnabled())

    // Guess + reveal.
    const [guess, setGuess] = useState(DEFAULT_GUESS)
    const [reveal, setReveal] = useState<GuessReveal | null>(null)
    const [submitting, setSubmitting] = useState(false)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        setReveal(null)
        setRound(null)
        setPly(0)
        setPlaying(false)
        setGuess(DEFAULT_GUESS)
        try {
            const r = await guessEloNew()
            setRound(r)
            setPly(0)
            setPlaying(true) // start watching immediately
        } catch (e) {
            setError(e instanceof Error ? e.message : 'could not load a game')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    // MoveList wants full MoveEntry[]; the round's moves carry no `by`, so tag them.
    const moves: MoveEntry[] = useMemo(
        () => (round?.moves ?? []).map((m) => ({ ...m, by: 'bot' as const })),
        [round],
    )
    const n = moves.length
    const startFen = round?.startFen ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

    const boardFen = ply === 0 ? startFen : moves[ply - 1].fen
    const lastMove =
        ply > 0 ? { from: moves[ply - 1].uci.slice(0, 2), to: moves[ply - 1].uci.slice(2, 4) } : null
    const atEnd = ply >= n

    // Autoplay: advance one ply on a timer, playing the move's sound as it lands.
    useEffect(() => {
        if (!playing || !round) return
        if (ply >= n) {
            setPlaying(false)
            return
        }
        const id = setTimeout(() => {
            const isLast = ply + 1 >= n
            playForSan(moves[ply].san, isLast && round.result !== null)
            setPly((p) => p + 1)
        }, MOVE_DELAY)
        return () => clearTimeout(id)
    }, [playing, ply, n, round, moves])

    // Manual scrubbing pauses autoplay so the two don't fight.
    const seek = useCallback(
        (p: number) => {
            setPlaying(false)
            setPly(Math.max(0, Math.min(n, p)))
        },
        [n],
    )
    const goFirst = useCallback(() => seek(0), [seek])
    const goPrev = useCallback(() => seek(ply - 1), [seek, ply])
    const goNext = useCallback(() => seek(ply + 1), [seek, ply])
    const goLast = useCallback(() => seek(n), [seek, n])
    useMoveNavKeys({ onPrev: goPrev, onNext: goNext, onFirst: goFirst, onLast: goLast })

    function togglePlay() {
        if (atEnd) {
            setPly(0)
            setPlaying(true)
        } else {
            setPlaying((p) => !p)
        }
    }

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    async function submitGuess() {
        if (!round || reveal || submitting) return
        setSubmitting(true)
        try {
            const r = await guessEloGuess(round.id, guess)
            setReveal(r)
            setPlaying(false)
            setPly(n) // jump to the finish so the whole game is visible on reveal
        } catch (e) {
            setError(e instanceof Error ? e.message : 'could not submit your guess')
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return (
            <Centered>
                <CircularProgress size={26} sx={{ color: 'var(--accent)' }} />
                <Typography sx={{ color: 'var(--text-dim)', mt: 2 }}>
                    Loading a random game…
                </Typography>
            </Centered>
        )
    }
    if (error || !round) {
        return (
            <Centered>
                <ErrorBanner>{error ?? 'No game to show.'}</ErrorBanner>
                <Button onClick={() => void load()} sx={{ mt: 2, color: 'var(--accent)' }}>
                    Try again
                </Button>
            </Centered>
        )
    }

    const caption = atEnd && round.result ? resultLabel(round.result) : `Move ${ply} / ${n}`

    return (
        <BoardPage
            left={
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Card>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontSize: 20,
                                fontWeight: 700,
                                letterSpacing: '-0.01em',
                            }}
                        >
                            Guess the Elo
                        </Typography>
                        <Typography sx={{ fontSize: 13, color: 'var(--text-dim)', mt: 0.5 }}>
                            One engine played both sides at a single hidden rating. Watch the game,
                            then guess how strong it was.
                        </Typography>
                    </Card>

                    {reveal ? (
                        <RevealCard reveal={reveal} onNew={() => void load()} />
                    ) : (
                        <Card>
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'baseline',
                                    justifyContent: 'space-between',
                                }}
                            >
                                <Label>Your guess</Label>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 22,
                                        fontWeight: 800,
                                        color: 'var(--accent)',
                                    }}
                                >
                                    {guess}
                                </Typography>
                            </Box>
                            <Slider
                                value={guess}
                                onChange={(_, v) => setGuess(v as number)}
                                min={RATING_MIN}
                                max={RATING_MAX}
                                step={RATING_STEP}
                                sx={sliderSx}
                            />
                            <Box
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    mt: -0.5,
                                    mb: 1,
                                }}
                            >
                                <Micro>{RATING_MIN}</Micro>
                                <Micro>{RATING_MAX}</Micro>
                            </Box>
                            <Button
                                fullWidth
                                onClick={() => void submitGuess()}
                                disabled={submitting}
                                sx={primaryBtnSx}
                            >
                                Lock in guess
                            </Button>
                        </Card>
                    )}
                </Box>
            }
            right={
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    <Card sx={{ gap: 1, py: 1.25 }}>
                        <Typography
                            sx={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dim)' }}
                        >
                            {caption}
                        </Typography>
                        {/* Controls on their own row: wrap + stay within the card so
                            the seven buttons never overflow the fixed side column. */}
                        <Box
                            sx={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 0.5,
                                minWidth: 0,
                                maxWidth: '100%',
                            }}
                        >
                            <NavBtn small label="First" onClick={goFirst}>
                                <ChevronFirst size={17} />
                            </NavBtn>
                            <NavBtn small label="Previous" onClick={goPrev}>
                                <ChevronLeft size={17} />
                            </NavBtn>
                            <NavBtn small label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
                                {playing ? <Pause size={17} /> : <Play size={17} />}
                            </NavBtn>
                            <NavBtn small label="Next" onClick={goNext}>
                                <ChevronRight size={17} />
                            </NavBtn>
                            <NavBtn small label="Last" onClick={goLast}>
                                <ChevronLast size={17} />
                            </NavBtn>
                            <NavBtn
                                small
                                label="Flip board"
                                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                            >
                                <FlipVertical2 size={17} />
                            </NavBtn>
                            <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                                {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
                            </NavBtn>
                        </Box>
                    </Card>

                    <Box sx={{ height: 460, display: 'flex' }}>
                        <MoveList fill moves={moves} currentPly={ply} onSelectPly={seek} />
                    </Box>
                </Box>
            }
        >
            <Board
                fen={boardFen}
                orientation={orientation}
                sideToMove={sideToMoveOf(boardFen)}
                legalMoves={[]}
                lastMove={lastMove}
                inCheck={false}
                interactive={false}
                onMove={() => {}}
            />
        </BoardPage>
    )
}

function RevealCard({ reveal, onNew }: { reveal: GuessReveal; onNew: () => void }) {
    return (
        <Card>
            <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <Label>Actual rating</Label>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 26,
                        fontWeight: 800,
                        color: 'var(--accent)',
                    }}
                >
                    {reveal.actual}
                </Typography>
            </Box>
            <Row k="Your guess" v={String(reveal.guess)} />
            <Row k="Off by" v={`${reveal.delta} Elo`} />
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    mt: 1,
                    pt: 1,
                    borderTop: '1px solid var(--line-soft)',
                }}
            >
                <Label>Score</Label>
                <Typography
                    sx={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 800 }}
                >
                    {reveal.score}
                    <Box component="span" sx={{ fontSize: 14, color: 'var(--muted)' }}>
                        {' '}
                        / 100
                    </Box>
                </Typography>
            </Box>
            <Button fullWidth onClick={onNew} sx={{ ...primaryBtnSx, mt: 1.5 }}>
                New game
            </Button>
        </Card>
    )
}

function Row({ k, v }: { k: string; v: string }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                mt: 0.75,
            }}
        >
            <Label>{k}</Label>
            <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700 }}>
                {v}
            </Typography>
        </Box>
    )
}

function Card({ children, sx }: { children: React.ReactNode; sx?: object }) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '14px',
                p: 1.75,
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
                ...sx,
            }}
        >
            {children}
        </Box>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                p: 4,
            }}
        >
            {children}
        </Box>
    )
}

function Label({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
            }}
        >
            {children}
        </Typography>
    )
}

function Micro({ children }: { children: React.ReactNode }) {
    return (
        <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)' }}>
            {children}
        </Typography>
    )
}

const sliderSx = {
    color: 'var(--accent)',
    height: 5,
    mt: 0.5,
    '& .MuiSlider-rail': { opacity: 0.4, bgcolor: 'var(--line)' },
    '& .MuiSlider-track': { border: 'none' },
    '& .MuiSlider-thumb': { width: 18, height: 18, bgcolor: '#f3eee2' },
}

const primaryBtnSx = {
    height: 46,
    textTransform: 'none',
    fontFamily: 'var(--font-display)',
    fontSize: 14.5,
    fontWeight: 700,
    borderRadius: '10px',
    color: '#15171c',
    background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
    border: '1px solid var(--accent)',
    boxShadow: '0 0 16px -4px rgba(216,166,87,0.6)',
    '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
    '&.Mui-disabled': { opacity: 0.6, color: '#15171c' },
}
