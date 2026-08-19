import { useEffect, useRef, useState } from 'react'
import { Box, Button, Tooltip, Typography } from '@mui/material'
import { ArrowLeft, FlipVertical2, Gauge, Target, User, Volume2, VolumeX } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import Board from '../components/Board'
import Clock, { ClockBar } from '../components/Clock'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import { tbLabel, toWhiteEval } from '../lib/engineEval'
import MoveList from '../components/MoveList'
import { MoveSan } from '../components/MoveSan'
import { Avatar, NavBtn, PANEL_SHADOW } from '../components/PanelUI'
import TitleBadge from '../components/TitleBadge'
import BoardActions from '../components/BoardActions'
import BoardPage, { useBoardLayout } from '../components/BoardPage'
import SpectateInfoCard from '../components/SpectateInfoCard'
import { analyze, type Color, type MoveEntry } from '../api/client'
import { pvToSan, START_FEN } from '../lib/analysisTree'
import {
    type SpectateGame,
    type SpectateSide,
    spectateRemaining,
    spectateSocket,
} from '../lib/spectate'
import { useSpectate } from '../lib/useSpectate'
import { variantHasCheck } from '../lib/variants'
import { useAuth } from '../lib/auth'
import { usePrefs } from '../lib/settings'
import { playForSan, setSoundEnabled, soundEnabled, sounds } from '../lib/sounds'
import { useShortcuts } from '../lib/shortcuts'

// Admins get a full-strength eval bar + best-move arrow over the spectated board,
// each independently toggleable (persisted in localStorage). Ordinary spectators
// see the board as-is — no analyze traffic for them.
const LS_EVAL = 'spectate-eval-bar'
const MOVE_LIST_ROWS = 7

const LS_ARROW = 'spectate-best-arrow'

function loadFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === '1'
    } catch {
        return false
    }
}

function saveFlag(key: string, on: boolean): void {
    try {
        localStorage.setItem(key, on ? '1' : '0')
    } catch {
        // ignore storage failures (private mode, quota)
    }
}

export default function Spectate() {
    const { id } = useParams<{ id: string }>()
    const navigate = useNavigate()
    const { user } = useAuth()
    const isAdmin = user?.role === 'admin'
    const s = useSpectate()
    const g = s.game
    // Came here from a tournament? Then "back" means back to the tournament
    // (also how you pick up your own next pairing) rather than the general
    // Watch lobby. Unknown until the game's initial state arrives, so this
    // stays "Back to Watch" until then.
    const backTo = g?.tournamentId ? `/tournaments/${g.tournamentId}` : '/watch'
    const backLabel = g?.tournamentId ? 'Back to tournament' : 'Back to Watch'
    const [sound, setSound] = useState(soundEnabled())
    const prefs = usePrefs()
    // Read above the `if (!g)` early return below — a hook after a conditional
    // return runs on some renders and not others, which React rejects outright.
    const chesscom = useBoardLayout() === 'chesscom'

    function toggleSound() {
        const next = !sound
        setSound(next)
        setSoundEnabled(next)
        if (next) sounds.move()
    }

    // Board orientation: spectators have no "own side", so White starts at the
    // bottom by default. Flip is page state (like LiveGame's manual flip), not
    // derived from the streamed game — it must survive `state`/`end` updates
    // rather than reset on the next move.
    const [flipped, setFlipped] = useState(false)
    const orientation: Color = flipped ? 'b' : 'w'
    const flipBoard = () => setFlipped((f) => !f)

    useShortcuts('spectate', [
        { keys: 'f', label: 'Flip board', group: 'Spectate', run: flipBoard },
    ])

    // Admin-only engine overlay: an eval bar and a best-move arrow, each toggled
    // independently (like the Analysis board). We re-read the position at full
    // strength whenever the FEN changes — i.e. only when a move lands, not on every
    // clock tick — and convert the side-to-move eval to White's perspective.
    const [showEval, setShowEval] = useState(() => loadFlag(LS_EVAL))
    const [showArrow, setShowArrow] = useState(() => loadFlag(LS_ARROW))
    // The eval bar also honors the site-wide "Show eval bar" preference (Analysis
    // and BotGame both gate on prefs.showEvalBar); the admin's own showEval flag is
    // an independent extra toggle on top of it, not a replacement for it.
    const evalBarVisible = isAdmin && showEval && prefs.showEvalBar
    const engineOn = isAdmin && (evalBarVisible || showArrow)
    const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
    const [bestUci, setBestUci] = useState<string | null>(null)

    const fen = g?.fen
    const sideToMove = g?.sideToMove
    const over = g?.over
    useEffect(() => {
        if (!engineOn || !fen || over) {
            setBestUci(null)
            return
        }
        let cancelled = false
        const ctrl = new AbortController()
        analyze(fen, { movetime: 500, signal: ctrl.signal })
            .then((r) => {
                if (cancelled) return
                if (r.eval) {
                    // `sideToMove` is optional; anything but 'w' was already
                    // treated as Black here, so keep that reading.
                    setWhiteEval(toWhiteEval(r.eval, sideToMove === 'w' ? 'w' : 'b'))
                }
                setBestUci(r.bestmove)
            })
            .catch(() => {}) // aborted / transient failure → keep last shown eval
        return () => {
            cancelled = true
            ctrl.abort()
        }
    }, [engineOn, fen, sideToMove, over])

    const arrow =
        isAdmin && showArrow && bestUci && !over
            ? { from: bestUci.slice(0, 2), to: bestUci.slice(2, 4) }
            : null

    // Open the spectator stream for this game; tear it down on leave.
    useEffect(() => {
        if (!id) return
        spectateSocket.open(id)
        return () => spectateSocket.close()
    }, [id])

    // Sound: voice each new move as the position advances. A spectator isn't
    // playing, so we voice BOTH sides (unlike LiveGame, which only sounds the
    // opponent). Audio is already unlocked by the click that brought us here (the
    // global pointerdown unlock in lib/sounds). Baseline per game id so opening a
    // mid-game stream doesn't replay the whole history.
    const soundedPly = useRef<{ id: string; ply: number } | null>(null)
    useEffect(() => {
        if (!g) return
        const prev = soundedPly.current
        if (!prev || prev.id !== g.id) {
            soundedPly.current = { id: g.id, ply: g.moves.length } // baseline; don't replay
            return
        }
        if (g.moves.length > prev.ply) {
            soundedPly.current = { id: g.id, ply: g.moves.length }
            playForSan(g.moves[g.moves.length - 1].san, false)
        }
    }, [g?.id, g?.moves.length])

    // Sound: one game-over tone when the game ends (once per game).
    const endedSound = useRef<string | null>(null)
    useEffect(() => {
        if (g && g.over && endedSound.current !== g.id) {
            endedSound.current = g.id
            sounds.end()
        }
    }, [g?.id, g?.over])

    if (!g) {
        return (
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                }}
            >
                <Typography sx={{ color: 'var(--text-dim)' }}>
                    {s.error ? 'This game is no longer available.' : 'Connecting to the game…'}
                </Typography>
                <Button variant="contained" onClick={() => navigate(backTo)}>
                    {backLabel}
                </Button>
            </Box>
        )
    }

    // White is shown at the bottom by default (spectators have no own side);
    // flip toggles it via the button/`F` above.
    const moveEntries: MoveEntry[] = g.moves.map((m, i) => ({
        ply: i + 1,
        san: m.san,
        uci: m.uci,
        by: 'human',
        fen: '',
    }))

    // Built once and placed by layout: rows inside the game panel for the centered
    // layout, board-width strips hugging the board for the side rail. The strips
    // follow the BOARD's orientation — a flipped spectator board would otherwise
    // show black's clock under white's pieces.
    const blackBar = (
        <PlayerBar
            side={g.black}
            getMs={() => spectateRemaining(g, 'b')}
            active={!g.over && g.sideToMove === 'b' && g.moves.length >= 2}
            running={!g.over && g.moves.length >= 2}
            initialMs={g.timeControl.base}
            divider="bottom"
            variant={chesscom ? 'strip' : 'rail'}
        />
    )
    const whiteBar = (
        <PlayerBar
            side={g.white}
            getMs={() => spectateRemaining(g, 'w')}
            active={!g.over && g.sideToMove === 'w' && g.moves.length >= 2}
            running={!g.over && g.moves.length >= 2}
            initialMs={g.timeControl.base}
            divider="top"
            variant={chesscom ? 'strip' : 'rail'}
        />
    )
    const topBar = orientation === 'w' ? blackBar : whiteBar
    const bottomBar = orientation === 'w' ? whiteBar : blackBar

    // The same card is either a rail card (centered layout) or the game panel's
    // header block (side rail), never both.
    const infoCardProps = {
        pool: g.pool,
        variant: g.variant,
        fen: g.fen,
        rated: g.rated,
        live: !g.over,
    }

    return (
        <BoardPage
            // Right card is compact by design (a fixed 7-row move list), so it shrinks
            // to its content and centres against the board — matching LiveGame.
            rightFit
            evalBar={evalBarVisible ? <EvalBar ev={whiteEval} orientation={orientation} /> : undefined}
            // Side-rail layout: this card heads the game panel instead of standing
            // as its own card in the rail — one continuous box, mode first, then the
            // moves. The centered layout keeps it as a left-column card.
            left={chesscom ? undefined : <SpectateInfoCard {...infoCardProps} />}
            // Board-hugging player strips — side rail only. Undefined for the centered
            // layout, where the same two bars live inside the game panel.
            top={chesscom ? topBar : undefined}
            bottom={chesscom ? bottomBar : undefined}
            right={
                <Box
                    sx={{
                        // Sized by its content, not stretched to the column.
                        flex: '0 0 auto',
                        minHeight: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line-soft)',
                        borderRadius: 'var(--radius)',
                        overflow: 'hidden',
                        boxShadow: PANEL_SHADOW,
                        alignSelf: { md: 'stretch' },
                        width: '100%',
                    }}
                >
                    {chesscom && <SpectateInfoCard {...infoCardProps} flat />}

                    {/* Admin engine overlay controls */}
                    {isAdmin && (
                        <AdminControls
                            showEval={showEval}
                            showArrow={showArrow}
                            onToggleEval={() =>
                                setShowEval((v) => {
                                    saveFlag(LS_EVAL, !v)
                                    return !v
                                })
                            }
                            onToggleArrow={() =>
                                setShowArrow((v) => {
                                    saveFlag(LS_ARROW, !v)
                                    return !v
                                })
                            }
                            bestSan={bestUci && !g.over ? bestMoveSan(g.fen, bestUci) : null}
                            whiteEval={engineOn ? whiteEval : null}
                        />
                    )}

                    {/* Black (top) — a strip above the board in the side-rail layout,
                        where the page hands it to the layout instead. */}
                    {!chesscom && blackBar}

                    {/* Fixed 7 rows: padded when the game is short, scrolling (and
                        auto-following the latest move) once it's longer, so the panel
                        height never jumps mid-game. */}
                    <MoveList
                        visibleRows={MOVE_LIST_ROWS}
                        moves={moveEntries}
                        currentPly={moveEntries.length}
                        startPly={g.startPly}
                        onSelectPly={() => {}}
                    />

                    {/* Flip + sound sit under the move list, where LiveGame keeps its
                        board controls. No move-nav yet — this list isn't scrubbable,
                        see docs/tasks/open/spectate-ply-scrubbing.md. */}
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: 1.25,
                            py: 0.75,
                            borderTop: '1px solid var(--line-soft)',
                            bgcolor: 'var(--bg-2)',
                        }}
                    >
                        <NavBtn small label="Flip board" onClick={flipBoard}>
                            <FlipVertical2 size={18} />
                        </NavBtn>
                        <NavBtn small label={sound ? 'Mute' : 'Unmute'} onClick={toggleSound}>
                            {sound ? <Volume2 size={18} /> : <VolumeX size={18} />}
                        </NavBtn>
                    </Box>

                    {g.over ? (
                        <Box
                            sx={{
                                p: 1.25,
                                borderTop: '1px solid var(--line-soft)',
                                bgcolor: 'var(--bg-2)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 1.25,
                            }}
                        >
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-display)',
                                    fontSize: 18,
                                    fontWeight: 700,
                                    textAlign: 'center',
                                }}
                            >
                                {resultText(g)}
                            </Typography>
                            {/* The game's finished — let spectators carry it into
                                analysis / the editor / their own bot game / an engine
                                match. Duck Chess has no analysable standard position;
                                Chess960 can't replay from the standard start (spectated
                                games aren't persisted for id-based replay), so it gets
                                position-level actions only. */}
                            {g.variant !== 'duck' && (
                                <BoardActions
                                    fen={g.fen}
                                    analyzeGame={
                                        g.variant === 'standard'
                                            ? {
                                                  moves: g.moves.map((m) => m.uci),
                                                  startFen: START_FEN,
                                              }
                                            : null
                                    }
                                />
                            )}
                            <Button
                                fullWidth
                                variant="contained"
                                startIcon={<ArrowLeft size={16} />}
                                onClick={() => navigate(backTo)}
                            >
                                {backLabel}
                            </Button>
                        </Box>
                    ) : (
                        <Box
                            sx={{
                                p: 1.25,
                                borderTop: '1px solid var(--line-soft)',
                                bgcolor: 'var(--bg-2)',
                            }}
                        >
                            <Button
                                fullWidth
                                color="inherit"
                                startIcon={<ArrowLeft size={15} />}
                                onClick={() => navigate(backTo)}
                                sx={{ color: 'var(--text-dim)', justifyContent: 'center' }}
                            >
                                {backLabel}
                            </Button>
                        </Box>
                    )}

                    {/* White (bottom) — a strip below the board in the side-rail layout. */}
                    {!chesscom && whiteBar}
                </Box>
            }
        >
            <Board
                fen={g.fen}
                orientation={orientation}
                sideToMove={g.sideToMove}
                legalMoves={[]}
                lastMove={g.lastMove}
                showCheck={variantHasCheck(g.variant)}
                interactive={false}
                onMove={() => {}}
                duck={g.variant === 'duck' ? g.duck : null}
                arrow={arrow}
            />
        </BoardPage>
    )
}

function PlayerBar({
    side,
    getMs,
    active,
    running,
    initialMs,
    divider,
    variant = 'rail',
}: {
    side: SpectateSide
    getMs: () => number
    active: boolean
    running: boolean
    /** The time control's initial time (ms), for the clockBar strip. */
    initialMs?: number
    divider?: 'top' | 'bottom'
    /** Where this bar is standing.
     *  `rail` — a narrow row inside the game panel, hairline-divided from its
     *  neighbours. The centered layout's arrangement, and the default.
     *  `strip` — a standalone board-width band hugging the board, with its own card
     *  chrome. The side-rail layout's arrangement. */
    variant?: 'rail' | 'strip'
}) {
    const strip = variant === 'strip'
    return (
        <Box
            sx={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.75,
                overflow: 'hidden',
                ...(strip
                    ? {
                          height: { xs: 'auto', md: '100%' },
                          // Real vertical padding even at full height: an active clock
                          // cell draws a border, and with no padding that border reaches
                          // the strip's edges and covers the ClockBar along the bottom.
                          py: { xs: 1.25, md: 0.75 },
                          bgcolor: 'var(--surface)',
                          border: '1px solid var(--line-soft)',
                          borderRadius: 'var(--radius)',
                      }
                    : {
                          py: 1.25,
                          bgcolor: 'var(--bg-2)',
                          borderTop: divider === 'top' ? '1px solid var(--line-soft)' : undefined,
                          borderBottom:
                              divider === 'bottom' ? '1px solid var(--line-soft)' : undefined,
                      }),
            }}
        >
            <Avatar small>
                <User size={15} />
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, minWidth: 0 }}>
                    <TitleBadge title={side.title} />
                    <Typography
                        sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }}
                        noWrap
                    >
                        {side.name}
                    </Typography>
                    {!side.anon && (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                color: 'var(--text-dim)',
                            }}
                        >
                            {side.rating}
                        </Typography>
                    )}
                </Box>
            </Box>
            <Box sx={{ ml: 'auto' }}>
                <Clock getMs={getMs} active={active} running={running} compact={strip} />
            </Box>
            {/* Full-bleed along the bottom of the whole row, not just under the digits. */}
            <ClockBar getMs={getMs} active={active} running={running} initialMs={initialMs} />
        </Box>
    )
}

// Render the engine's UCI best move ("e2e4") as SAN ("e4") for the readout.
function bestMoveSan(fen: string, uci: string): string {
    return pvToSan(fen, [uci])[0]?.san ?? uci
}

// Short eval from White's view: "+0.34", "-1.20", "#3" / "-#2" for mate, or
// "TB" / "-TB" when Syzygy has already settled it (lib/engineEval.ts).
function evalText(ev: WhiteEval): string {
    if (ev.tb) return tbLabel(ev.tb)
    if (ev.type === 'mate') return `${ev.white < 0 ? '-' : ''}#${Math.abs(ev.white)}`
    const v = ev.white / 100
    return (v > 0 ? '+' : '') + v.toFixed(2)
}

// Admin-only control strip: two independent toggles (eval bar + best-move arrow)
// plus a compact readout of the current best move and eval.
function AdminControls({
    showEval,
    showArrow,
    onToggleEval,
    onToggleArrow,
    bestSan,
    whiteEval,
}: {
    showEval: boolean
    showArrow: boolean
    onToggleEval: () => void
    onToggleArrow: () => void
    bestSan: string | null
    whiteEval: WhiteEval | null
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: 1.75,
                py: 1,
                bgcolor: 'var(--bg-2)',
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            <AdminToggle
                label="Eval bar"
                icon={<Gauge size={14} />}
                on={showEval}
                onChange={onToggleEval}
            />
            <AdminToggle
                label="Best move"
                icon={<Target size={14} />}
                on={showArrow}
                onChange={onToggleArrow}
            />
            {(showEval || showArrow) && (bestSan || whiteEval) && (
                <Box
                    sx={{
                        ml: 'auto',
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 0.75,
                        minWidth: 0,
                        overflow: 'hidden',
                    }}
                >
                    {bestSan && (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 13.5,
                                fontWeight: 700,
                                color: 'var(--accent)',
                            }}
                            noWrap
                        >
                            <MoveSan san={bestSan} />
                        </Typography>
                    )}
                    {whiteEval && (
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11.5,
                                color: 'var(--text-dim)',
                            }}
                            noWrap
                        >
                            {evalText(whiteEval)}
                        </Typography>
                    )}
                </Box>
            )}
        </Box>
    )
}

function AdminToggle({
    label,
    icon,
    on,
    onChange,
}: {
    label: string
    icon: React.ReactNode
    on: boolean
    onChange: () => void
}) {
    return (
        <Tooltip
            title={`${on ? 'Hide' : 'Show'} ${label.toLowerCase()} (admin)`}
            arrow
            placement="top"
        >
            <Box
                role="switch"
                aria-checked={on}
                aria-label={label}
                tabIndex={0}
                onClick={onChange}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onChange()
                    }
                }}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    cursor: 'pointer',
                    outline: 'none',
                }}
            >
                <Box
                    sx={{
                        display: 'flex',
                        color: on ? 'var(--accent)' : 'var(--text-dim)',
                        transition: 'color .2s',
                    }}
                >
                    {icon}
                </Box>
                <Toggle on={on} />
            </Box>
        </Tooltip>
    )
}

// Hand-built on/off switch — a gold track with a sliding knob and a soft glow when
// live. Mirrors the Analysis board's engine toggle (replaces the stock MUI Switch).
// Display-only: the parent Box owns the click/keyboard + ARIA.
function Toggle({ on }: { on: boolean }) {
    return (
        <Box
            sx={{
                position: 'relative',
                flexShrink: 0,
                width: 38,
                height: 22,
                borderRadius: 'var(--radius)',
                bgcolor: on ? 'var(--accent)' : 'var(--surface-2)',
                boxShadow: on ? '0 0 0 1px var(--accent-line)' : 'inset 0 0 0 1px var(--line)',
                transition: 'background-color .22s ease, box-shadow .22s ease',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    top: 3,
                    left: 3,
                    width: 16,
                    height: 16,
                    borderRadius: 'var(--radius)',
                    bgcolor: on ? 'var(--on-accent)' : 'var(--text-dim)',
                    transform: on ? 'translateX(16px)' : 'translateX(0)',
                    transition:
                        'transform .24s cubic-bezier(.34, 1.4, .5, 1), background-color .22s ease',
                    boxShadow: 'var(--shadow)',
                }}
            />
        </Box>
    )
}

function resultText(g: SpectateGame): string {
    if (g.reason === 'aborted' || g.status === 'aborted') return 'Game aborted'
    if (g.result === '1/2-1/2') return 'Draw'
    if (g.result === '1-0' || g.result === '0-1') {
        const who = g.result === '1-0' ? 'White' : 'Black'
        const how = reasonText(g.reason)
        return `${who} wins${how ? ` · ${how}` : ''}`
    }
    return 'Game over'
}

function reasonText(reason: string | null): string {
    switch (reason) {
        case 'resign':
            return 'resignation'
        case 'timeout':
            return 'on time'
        case 'abandon':
            return 'abandonment'
        case 'checkmate':
            return 'checkmate'
        default:
            return reason ?? ''
    }
}
