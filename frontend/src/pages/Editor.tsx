import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material'
import {
    Bot,
    Check,
    Copy,
    Cpu,
    Dices,
    Eraser,
    FileInput,
    FlipVertical2,
    Microscope,
    RotateCcw,
    UserPlus,
} from 'lucide-react'
import { Chess } from 'chess.js'
import BoardEditor, { type Brush, EditorPalette } from '../components/BoardEditor'
import BoardPage from '../components/BoardPage'
import ChallengeDialog from '../components/ChallengeDialog'
import EvalBar, { type WhiteEval } from '../components/EvalBar'
import { toWhiteEval } from '../lib/engineEval'
import { ActionBtn } from '../components/PanelUI'
import { analyze, type Color, nextPuzzle } from '../api/client'
import { useAuth } from '../lib/auth'
import { parseFen } from '../lib/chess'
import {
    type Active,
    START_FEN,
    activeOf,
    castlingAvailability,
    castlingOf,
    validateSetup,
    withActive,
    withCastling,
    withClearedBoard,
} from '../lib/fenEdit'

// Returns the FEN if chess.js accepts it, else null.
function validFen(fen: string): string | null {
    try {
        new Chess(fen.trim())
        return fen.trim()
    } catch {
        return null
    }
}

const CASTLE_RIGHTS: { code: string; label: string }[] = [
    { code: 'K', label: 'White O-O' },
    { code: 'Q', label: 'White O-O-O' },
    { code: 'k', label: 'Black O-O' },
    { code: 'q', label: 'Black O-O-O' },
]

export default function Editor() {
    const navigate = useNavigate()
    const { user } = useAuth()
    // Seeded from the analysis board ("Edit this board") or starts from scratch.
    const navFen = (useLocation().state as { fen?: string } | null)?.fen ?? null
    const [fen, setFen] = useState<string>(navFen || START_FEN)
    const [orientation, setOrientation] = useState<Color>('w')
    const [brush, setBrush] = useState<Brush>(null)
    const [copied, setCopied] = useState(false)
    const [pasteOpen, setPasteOpen] = useState(false)
    const [pasteVal, setPasteVal] = useState('')
    const [pasteErr, setPasteErr] = useState(false)
    const [challengeOpen, setChallengeOpen] = useState(false)

    const active = activeOf(fen)
    const castling = castlingOf(fen)
    const avail = useMemo(() => castlingAvailability(parseFen(fen)), [fen])
    const valid = useMemo(() => validateSetup(fen), [fen])

    // Live balance read-out: full-strength eval of the position being edited, shown
    // on the EvalBar so you can see how lopsided your setup is. Debounced (editing
    // fires many FEN changes) and only run on legal positions; while invalid the bar
    // just keeps its last known value rather than flickering.
    const [whiteEval, setWhiteEval] = useState<WhiteEval | null>(null)
    useEffect(() => {
        if (!valid.ok) return
        const ctrl = new AbortController()
        const id = setTimeout(() => {
            analyze(fen, { movetime: 300, signal: ctrl.signal })
                .then((r) => {
                    if (!r.eval) return
                    // Engine reports from side-to-move's perspective; flip to
                    // White's (value AND tablebase verdict).
                    setWhiteEval(toWhiteEval(r.eval, active))
                })
                .catch(() => {}) // aborted / transient failure → keep last shown eval
        }, 250)
        return () => {
            ctrl.abort()
            clearTimeout(id)
        }
    }, [fen, active, valid.ok])

    const setActive = (a: Active) => setFen(withActive(fen, a))
    const toggleCastle = (code: string) => {
        const has = castling.includes(code)
        const next = has ? castling.replace(code, '') : castling + code
        setFen(withCastling(fen, next))
    }

    const submitPaste = () => {
        const ok = validFen(pasteVal)
        if (!ok) {
            setPasteErr(true)
            return
        }
        setFen(ok)
        setPasteOpen(false)
        setPasteVal('')
        setPasteErr(false)
    }

    const copyFen = async () => {
        try {
            await navigator.clipboard.writeText(fen)
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
        } catch {
            /* clipboard blocked — no-op */
        }
    }

    // Drop in a real, balanced position from the puzzle corpus (~200k). We use the
    // puzzle's `start_fen` (Lichess convention: BEFORE the setup blunder, so it's a
    // believable middlegame) rather than the post-blunder tactic position.
    const [loadingRandom, setLoadingRandom] = useState(false)
    const loadRandom = async () => {
        if (loadingRandom) return
        setLoadingRandom(true)
        try {
            const p = await nextPuzzle()
            setFen(p.start_fen)
        } catch {
            /* transient fetch failure — leave the current position untouched */
        } finally {
            setLoadingRandom(false)
        }
    }

    const analyse = () => navigate('/analysis', { state: { startFen: fen } })
    const playBot = () => navigate('/bot', { state: { fen } })
    const engineVsEngine = () => navigate('/engine-vs', { state: { fen } })
    const challengePlayer = () => setChallengeOpen(true)

    return (
        <BoardPage
            left={<PaletteCard brush={brush} onPick={setBrush} />}
            evalBar={<EvalBar ev={whiteEval} orientation={orientation} />}
            right={
                <Box
                    sx={{
                        width: '100%',
                        border: '1px solid var(--line-soft)',
                        borderRadius: 'var(--radius)',
                        bgcolor: 'var(--surface)',
                        overflow: 'hidden',
                        boxShadow: 'var(--shadow)',
                    }}
                >
                    <PanelHeader />

                    <Box sx={{ p: 1.75, display: 'flex', flexDirection: 'column', gap: 1.75 }}>
                        {/* Side to move */}
                        <Box>
                            <Label>Side to move</Label>
                            <ToggleButtonGroup
                                exclusive
                                fullWidth
                                size="small"
                                value={active}
                                onChange={(_, v) => v && setActive(v as Active)}
                                sx={toggleSx}
                            >
                                <ToggleButton value="w">White</ToggleButton>
                                <ToggleButton value="b">Black</ToggleButton>
                            </ToggleButtonGroup>
                        </Box>

                        {/* Castling rights — only the structurally-possible ones are enabled. */}
                        <Box>
                            <Label>Castling</Label>
                            <Box sx={{ display: 'flex', gap: 0.75, mt: 1 }}>
                                {CASTLE_RIGHTS.map(({ code, label }) => (
                                    <CastleChip
                                        key={code}
                                        label={code}
                                        title={label}
                                        on={castling.includes(code)}
                                        disabled={!avail[code]}
                                        onClick={() => toggleCastle(code)}
                                    />
                                ))}
                            </Box>
                        </Box>

                        {/* Tools */}
                        <Box sx={{ display: 'flex', gap: 1 }}>
                            <ToolBtn
                                icon={<RotateCcw size={15} />}
                                label="Start position"
                                onClick={() => setFen(START_FEN)}
                            />
                            <ToolBtn
                                icon={<Dices size={15} />}
                                label={loadingRandom ? 'Loading…' : 'Random'}
                                onClick={loadRandom}
                                disabled={loadingRandom}
                            />
                            <ToolBtn
                                icon={<Eraser size={15} />}
                                label="Clear board"
                                onClick={() => setFen(withClearedBoard(fen))}
                            />
                            <ToolBtn
                                icon={<FlipVertical2 size={15} />}
                                label="Flip"
                                onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                            />
                            <ToolBtn
                                icon={<FileInput size={15} />}
                                label="Paste FEN"
                                onClick={() => {
                                    setPasteOpen((v) => !v)
                                    setPasteErr(false)
                                }}
                            />
                        </Box>

                        {pasteOpen && (
                            <Box>
                                <Box
                                    component="input"
                                    autoFocus
                                    value={pasteVal}
                                    placeholder="Paste a FEN, then Enter"
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                                        setPasteVal(e.target.value)
                                        setPasteErr(false)
                                    }}
                                    onKeyDown={(e: React.KeyboardEvent) => {
                                        if (e.key === 'Enter') submitPaste()
                                        else if (e.key === 'Escape') setPasteOpen(false)
                                    }}
                                    sx={{
                                        width: '100%',
                                        boxSizing: 'border-box',
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 12,
                                        color: 'var(--text)',
                                        bgcolor: 'var(--bg)',
                                        border: `1px solid ${pasteErr ? 'var(--danger, #e5484d)' : 'var(--line)'}`,
                                        borderRadius: 'var(--radius)',
                                        px: 1.25,
                                        py: 1,
                                        outline: 'none',
                                        '&:focus': {
                                            borderColor: pasteErr
                                                ? 'var(--danger, #e5484d)'
                                                : 'var(--accent-line)',
                                        },
                                        '&::placeholder': { color: 'var(--muted)' },
                                    }}
                                />
                                {pasteErr && (
                                    <Typography
                                        sx={{ fontSize: 11.5, color: 'var(--danger, #e5484d)', mt: 0.5 }}
                                    >
                                        Not a valid FEN.
                                    </Typography>
                                )}
                            </Box>
                        )}

                        {/* FEN readout */}
                        <Box>
                            <Label>FEN</Label>
                            <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1, mt: 0.75 }}>
                                <Box
                                    sx={{
                                        flex: 1,
                                        minWidth: 0,
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 11.5,
                                        color: 'var(--text-dim)',
                                        bgcolor: 'var(--bg)',
                                        border: '1px solid var(--line-soft)',
                                        borderRadius: 'var(--radius)',
                                        px: 1.25,
                                        py: 0.85,
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                    }}
                                >
                                    {fen}
                                </Box>
                                <Tooltip title={copied ? 'Copied!' : 'Copy FEN'} arrow>
                                    <Box
                                        component="button"
                                        onClick={copyFen}
                                        aria-label="Copy FEN"
                                        sx={{
                                            flexShrink: 0,
                                            width: 40,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            cursor: 'pointer',
                                            color: copied ? 'var(--accent)' : 'var(--text-dim)',
                                            bgcolor: 'var(--surface-2)',
                                            border: '1px solid var(--line)',
                                            borderRadius: 'var(--radius)',
                                            transition: 'color .15s, background-color .15s',
                                            '&:hover': {
                                                color: 'var(--accent)',
                                                bgcolor: 'var(--line)',
                                            },
                                        }}
                                    >
                                        {copied ? <Check size={16} /> : <Copy size={15} />}
                                    </Box>
                                </Tooltip>
                            </Box>
                        </Box>

                        {/* Validity hint */}
                        <Typography
                            sx={{
                                fontSize: 12.5,
                                color: valid.ok ? 'var(--muted)' : '#ca4a4a',
                                minHeight: 18,
                            }}
                        >
                            {valid.ok ? 'Legal position — ready to use.' : valid.reason}
                        </Typography>

                        {/* Actions */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <ActionBtn
                                tone="primary"
                                icon={<Microscope size={16} />}
                                label="Analyse this position"
                                onClick={analyse}
                                disabled={!valid.ok}
                            />
                            <ActionBtn
                                tone="neutral"
                                icon={<Bot size={16} />}
                                label="Play a bot from here"
                                onClick={playBot}
                                disabled={!valid.ok}
                            />
                            {user && (
                                <ActionBtn
                                    tone="neutral"
                                    icon={<UserPlus size={16} />}
                                    label="Challenge a player from here"
                                    onClick={challengePlayer}
                                    disabled={!valid.ok}
                                />
                            )}
                            {user?.role === 'admin' && (
                                <ActionBtn
                                    tone="neutral"
                                    icon={<Cpu size={16} />}
                                    label="Engine vs Engine from here"
                                    onClick={engineVsEngine}
                                    disabled={!valid.ok}
                                />
                            )}
                        </Box>
                    </Box>
                </Box>
            }
        >
            <BoardEditor fen={fen} orientation={orientation} brush={brush} onChange={setFen} />
            {user && (
                <ChallengeDialog
                    open={challengeOpen}
                    onClose={() => setChallengeOpen(false)}
                    startFen={fen}
                />
            )}
        </BoardPage>
    )
}

function PanelHeader() {
    return (
        <Box
            sx={{
                px: 1.75,
                py: 1.5,
                bgcolor: 'var(--bg-2)',
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16 }}>
                Board editor
            </Typography>
            <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', mt: 0.25 }}>
                Set up any position, then analyse it or play it out.
            </Typography>
        </Box>
    )
}

function PaletteCard({ brush, onPick }: { brush: Brush; onPick: (b: Brush) => void }) {
    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                bgcolor: 'var(--surface)',
                overflow: 'hidden',
                boxShadow: 'var(--shadow)',
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 1.8,
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    px: 1.75,
                    py: 1.25,
                    borderBottom: '1px solid var(--line-soft)',
                    bgcolor: 'var(--bg-2)',
                }}
            >
                Pieces
            </Typography>
            <Box sx={{ p: 1.75 }}>
                <EditorPalette brush={brush} onPick={onPick} />
                <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)', my: 1.5 }} />
                {[
                    'Click a piece, then click squares to place it.',
                    'Drag-paint to fill; the pointer tool drags pieces.',
                    'Right-click a square to clear it.',
                ].map((t, i) => (
                    <Typography
                        key={i}
                        sx={{ fontSize: 12, color: 'var(--muted)', mb: 0.5, lineHeight: 1.45 }}
                    >
                        • {t}
                    </Typography>
                ))}
            </Box>
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
                mb: 0.5,
            }}
        >
            {children}
        </Typography>
    )
}

function CastleChip({
    label,
    title,
    on,
    disabled,
    onClick,
}: {
    label: string
    title: string
    on: boolean
    disabled: boolean
    onClick: () => void
}) {
    return (
        <Tooltip title={disabled ? `${title} — pieces not on home squares` : title} arrow>
            <Box component="span" sx={{ flex: 1, display: 'flex' }}>
                <Box
                    component="button"
                    onClick={onClick}
                    disabled={disabled}
                    sx={{
                        flex: 1,
                        height: 38,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 15,
                        fontWeight: 700,
                        cursor: disabled ? 'default' : 'pointer',
                        color: disabled ? 'var(--muted)' : on ? 'var(--on-accent)' : 'var(--text-dim)',
                        background: on && !disabled ? 'var(--accent-fill)' : 'var(--surface-2)',
                        border: `1px solid ${on && !disabled ? 'var(--accent)' : 'var(--line)'}`,
                        borderRadius: 'var(--radius)',
                        opacity: disabled ? 0.45 : 1,
                        transition: 'color .15s, background .15s, border-color .15s',
                        '&:hover': disabled ? {} : { borderColor: 'var(--accent-line)' },
                        '&:active': disabled ? {} : { transform: 'translateY(1px)' },
                    }}
                >
                    {label}
                </Box>
            </Box>
        </Tooltip>
    )
}

function ToolBtn({
    icon,
    label,
    onClick,
    disabled = false,
}: {
    icon: React.ReactNode
    label: string
    onClick: () => void
    disabled?: boolean
}) {
    return (
        <Box
            component="button"
            onClick={onClick}
            disabled={disabled}
            sx={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.4,
                height: 52,
                cursor: disabled ? 'default' : 'pointer',
                fontFamily: 'var(--font-display)',
                fontSize: 11.5,
                fontWeight: 600,
                color: 'var(--text)',
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius)',
                opacity: disabled ? 0.55 : 1,
                transition: 'color .15s, background-color .15s, border-color .15s, transform .05s',
                '&:hover': disabled
                    ? {}
                    : {
                          color: 'var(--accent)',
                          bgcolor: 'var(--line)',
                          borderColor: 'var(--accent-line)',
                      },
                '&:active': disabled ? {} : { transform: 'translateY(1px)' },
            }}
        >
            {icon}
            {label}
        </Box>
    )
}

const toggleSx = {
    mt: 1,
    gap: 0.75,
    '& .MuiToggleButton-root': {
        color: 'var(--text-dim)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius) !important',
        textTransform: 'none',
        fontFamily: 'var(--font-display)',
        fontWeight: 600,
        fontSize: 13.5,
        py: 0.7,
        transition: 'color .15s, background .15s, border-color .15s',
        '&:hover': { background: 'var(--line)', color: 'var(--accent)' },
        '&.Mui-selected': {
            color: 'var(--on-accent)',
            background: 'var(--accent-fill)',
            borderColor: 'var(--accent)',
            '&:hover': { background: 'var(--accent-fill-hover)' },
        },
    },
}
