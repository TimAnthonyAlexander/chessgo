import { useMemo, useState } from 'react'
import { Box, Tooltip, Typography } from '@mui/material'
import {
    Check,
    Copy,
    Dices,
    Download,
    FileInput,
    FileText,
    Link2,
    RotateCcw,
    SquarePen,
} from 'lucide-react'
import { Chess } from 'chess.js'
import { START_FEN } from '../lib/analysisTree'
import { random960 } from '../lib/variants'
import { computeMaterial, type Material } from '../lib/material'
import { copyText, downloadPgn, fromPgn, pgnFilename, type ParsedPgn } from '../lib/pgn'
import { useSetting } from '../lib/settings'
import BoardActions from './BoardActions'
import { ToolMenu } from './PanelUI'

// Returns the FEN if chess.js accepts it, else null.
function validFen(fen: string): string | null {
    try {
        new Chess(fen.trim())
        return fen.trim()
    } catch {
        return null
    }
}

export default function AnalysisAside({
    fen,
    onLoadFen,
    playBotDisabled = false,
    showSetup = true,
    hideActions = false,
    onEnableDuck,
    getPgn,
    onImportPgn,
}: {
    fen: string
    onLoadFen: (fen: string) => void
    playBotDisabled?: boolean
    showSetup?: boolean
    // Duck review: hide the cross-navigation actions (edit/play-bot/engine-vs) — they
    // seed a STANDARD board from a duck position, which would be misleading.
    hideActions?: boolean
    // Free mode only: switch the analysis board into interactive Duck Chess. When
    // provided, a "Duck Chess" button sits beside the Chess960 setup button.
    onEnableDuck?: () => void
    // Returns the current game as a PGN string, computed on demand (so it's
    // always up to date). Copy/Download PGN are hidden when this is absent.
    getPgn?: () => string
    // Called with a successfully parsed pasted PGN — the caller owns loading it
    // into the board. Import is a no-op (button hidden) when this is absent.
    onImportPgn?: (parsed: ParsedPgn) => void
}) {
    const mat = useMemo(() => computeMaterial(fen), [fen])
    // Single-key subscription — showCaptured gates this card the same way it
    // gates the equivalent readouts in LiveGame/BotGame/SpectateInfoCard.
    const showCaptured = useSetting('showCaptured')

    return (
        <Box
            sx={{
                display: { xs: 'none', md: 'flex' },
                flexDirection: 'column',
                gap: 2,
                alignSelf: 'start',
                width: '100%',
            }}
        >
            {showCaptured && <MaterialCard mat={mat} />}
            {showSetup && (
                <PositionCard fen={fen} onLoadFen={onLoadFen} onEnableDuck={onEnableDuck} />
            )}
            {/* Copy link always works (just the current URL); Copy/Download PGN and
                Import PGN degrade away individually when their prop is absent. */}
            <GameCard
                getPgn={getPgn}
                onImportPgn={showSetup ? onImportPgn : undefined}
            />
            {/* Cross-links: edit the board, play a bot, or (admins) run an engine
                match — all seeded from the position on the board. "Analyse this
                position" is omitted (you're already in analysis). */}
            {!hideActions && (
                <BoardActions fen={fen} omit={['analyze-position']} playDisabled={playBotDisabled} />
            )}
        </Box>
    )
}

/** The same three blocks as the column above (position setup, game/PGN, board
 *  cross-links) collapsed into ONE row of menu buttons — what the side-rail layout
 *  puts at the very top of the engine panel.
 *
 *  The rail is a single fixed-height column shared with the move tree, so three
 *  stacked cards cost the move list its entire height (it's the only `flex: 1`
 *  child, so it's the one that collapses to nothing when the rail overflows). Each
 *  block therefore lives in a popover anchored to its own button: opening one
 *  paints over the board instead of pushing anything, so the row costs 48px flat
 *  and nothing in the panel moves when a menu opens or closes. */
export function AnalysisToolbar({
    fen,
    onLoadFen,
    playBotDisabled = false,
    showSetup = true,
    hideActions = false,
    onEnableDuck,
    getPgn,
    onImportPgn,
}: {
    fen: string
    onLoadFen: (fen: string) => void
    playBotDisabled?: boolean
    showSetup?: boolean
    hideActions?: boolean
    onEnableDuck?: () => void
    getPgn?: () => string
    onImportPgn?: (parsed: ParsedPgn) => void
}) {
    return (
        <Box
            sx={{
                flexShrink: 0,
                display: 'flex',
                gap: 0.75,
                px: 1,
                py: 1,
                borderBottom: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
            }}
        >
            {showSetup && (
                <ToolMenu icon={<Dices size={14} />} label="Position" width={340}>
                    {(close) => (
                        <PositionBody
                            fen={fen}
                            onLoadFen={onLoadFen}
                            onEnableDuck={onEnableDuck}
                            onDone={close}
                        />
                    )}
                </ToolMenu>
            )}
            <ToolMenu icon={<FileText size={14} />} label="Game" width={340}>
                {(close) => (
                    <GameBody
                        getPgn={getPgn}
                        onImportPgn={showSetup ? onImportPgn : undefined}
                        onDone={close}
                    />
                )}
            </ToolMenu>
            {!hideActions && (
                <ToolMenu icon={<SquarePen size={14} />} label="Board" width={300}>
                    {(close) => (
                        <Box onClick={close}>
                            <BoardActions
                                fen={fen}
                                omit={['analyze-position']}
                                playDisabled={playBotDisabled}
                            />
                        </Box>
                    )}
                </ToolMenu>
            )}
        </Box>
    )
}

function Card({
    label,
    children,
    flat = false,
}: {
    label: string
    children: React.ReactNode
    // Drop the card's own chrome and end in a hairline, so it can head another
    // panel as its first block instead of standing as a separate card.
    flat?: boolean
}) {
    return (
        <Box
            sx={{
                border: flat ? 'none' : '1px solid var(--line-soft)',
                borderBottom: flat ? '1px solid var(--line-soft)' : undefined,
                borderRadius: 'var(--radius)',
                bgcolor: 'var(--surface)',
                overflow: 'hidden',
                boxShadow: flat ? 'none' : '0 18px 50px -28px rgba(0,0,0,0.8)',
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
                {label}
            </Typography>
            <Box sx={{ p: 1.75 }}>{children}</Box>
        </Box>
    )
}

/** Material as a single 32px band at the top of the engine panel — what the
 *  side-rail layout shows instead of the column's Material card. The card is three
 *  labelled rows and a header, ~145px; in a rail that also has to hold the move
 *  tree that's most of a move list. Same information, one line: each side's captures
 *  and, on whichever side is ahead, by how much. Renders nothing when the
 *  showCaptured preference is off, exactly like the card it replaces. */
export function MaterialHeader({ fen }: { fen: string }) {
    const mat = useMemo(() => computeMaterial(fen), [fen])
    const showCaptured = useSetting('showCaptured')
    if (!showCaptured) return null
    return (
        <Box
            sx={{
                flexShrink: 0,
                display: 'flex',
                alignItems: 'stretch',
                height: 32,
                px: 1.25,
                borderBottom: '1px solid var(--line-soft)',
                bgcolor: 'var(--bg-2)',
            }}
        >
            <MiniPile
                label="White"
                pieces={mat.capturedByWhite}
                color="b"
                adv={mat.diff > 0 ? mat.diff : 0}
            />
            <Box sx={{ width: '1px', bgcolor: 'var(--line-soft)', my: 0.75, mx: 1.25 }} />
            <MiniPile
                label="Black"
                pieces={mat.capturedByBlack}
                color="w"
                adv={mat.diff < 0 ? -mat.diff : 0}
            />
        </Box>
    )
}

// One side of the compact material band. Pieces are nowrap and clipped rather than
// wrapped: the band's height is fixed so the panel below it can't be shoved down by
// a position with a lot of captures.
function MiniPile({
    label,
    pieces,
    color,
    adv,
}: {
    label: string
    pieces: string[]
    color: 'w' | 'b'
    adv: number
}) {
    return (
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Typography
                sx={{
                    flexShrink: 0,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 1,
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    minWidth: 0,
                    overflow: 'hidden',
                }}
            >
                {pieces.length === 0 ? (
                    <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>—</Typography>
                ) : (
                    pieces.map((t, i) => (
                        <Box
                            key={i}
                            component="img"
                            src={`/piece/cburnett/${color}${t}.svg`}
                            alt={t}
                            sx={{
                                width: 17,
                                height: 17,
                                flexShrink: 0,
                                ml: i > 0 && pieces[i - 1] === t ? '-6px' : 0,
                            }}
                        />
                    ))
                )}
            </Box>
            {adv > 0 && (
                <Typography
                    sx={{
                        ml: 'auto',
                        flexShrink: 0,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 700,
                        color: 'var(--accent)',
                    }}
                >
                    +{adv}
                </Typography>
            )}
        </Box>
    )
}

function MaterialCard({ mat, flat = false }: { mat: Material; flat?: boolean }) {
    return (
        <Card label="Material" flat={flat}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <SideRow
                    label="White"
                    pieces={mat.capturedByWhite}
                    color="b"
                    adv={mat.diff > 0 ? mat.diff : 0}
                />
                <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)' }} />
                <SideRow
                    label="Black"
                    pieces={mat.capturedByBlack}
                    color="w"
                    adv={mat.diff < 0 ? -mat.diff : 0}
                />
            </Box>
        </Card>
    )
}

function SideRow({
    label,
    pieces,
    color,
    adv,
}: {
    label: string
    pieces: string[]
    color: 'w' | 'b'
    adv: number
}) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minHeight: 26 }}>
            <Typography
                sx={{
                    width: 44,
                    flexShrink: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    letterSpacing: 0.3,
                    color: 'var(--text-dim)',
                }}
            >
                {label}
            </Typography>
            <Box
                sx={{
                    flex: 1,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '1px',
                    minWidth: 0,
                }}
            >
                {pieces.length === 0 ? (
                    <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>—</Typography>
                ) : (
                    pieces.map((t, i) => (
                        <Box
                            key={i}
                            component="img"
                            src={`/piece/cburnett/${color}${t}.svg`}
                            alt={t}
                            sx={{
                                width: 20,
                                height: 20,
                                ml: i > 0 && pieces[i - 1] === t ? '-7px' : 0,
                            }}
                        />
                    ))
                )}
            </Box>
            {adv > 0 && (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: 'var(--accent)',
                    }}
                >
                    +{adv}
                </Typography>
            )}
        </Box>
    )
}

interface GameBodyProps {
    getPgn?: () => string
    onImportPgn?: (parsed: ParsedPgn) => void
    /** Called once an action is finished — lets the popover host dismiss itself.
     *  Absent in the column layout, where the block is a permanently open card. */
    onDone?: () => void
}

// Copy/Download PGN, Copy link, and Import PGN. Copy link never depends on a
// prop (it's just the current URL); the PGN actions individually disappear
// when their prop isn't supplied by the caller.
function GameCard(props: GameBodyProps) {
    return (
        <Card label="Game">
            <GameBody {...props} />
        </Card>
    )
}

function GameBody({ getPgn, onImportPgn, onDone }: GameBodyProps) {
    const [pasteOpen, setPasteOpen] = useState(false)
    const [pasteVal, setPasteVal] = useState('')
    const [pasteErr, setPasteErr] = useState<string | null>(null)
    const [copiedPgn, setCopiedPgn] = useState(false)
    const [copiedLink, setCopiedLink] = useState(false)

    const submitImport = () => {
        const parsed = fromPgn(pasteVal)
        if (!parsed.ok) {
            setPasteErr(parsed.error)
            return
        }
        onImportPgn?.(parsed)
        setPasteOpen(false)
        setPasteVal('')
        setPasteErr(null)
        onDone?.()
    }

    const copyPgn = async () => {
        if (!getPgn) return
        if (await copyText(getPgn())) {
            setCopiedPgn(true)
            setTimeout(() => setCopiedPgn(false), 1400)
        }
    }

    const downloadCurrentPgn = () => {
        if (!getPgn) return
        const text = getPgn()
        const parsed = fromPgn(text)
        downloadPgn(text, pgnFilename(parsed.ok ? parsed.headers : {}))
    }

    const copyLink = async () => {
        if (await copyText(window.location.href)) {
            setCopiedLink(true)
            setTimeout(() => setCopiedLink(false), 1400)
        }
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
                {getPgn && (
                    <>
                        <AsideBtn
                            icon={copiedPgn ? <Check size={15} /> : <Copy size={15} />}
                            label={copiedPgn ? 'Copied' : 'Copy PGN'}
                            onClick={copyPgn}
                        />
                        <AsideBtn
                            icon={<Download size={15} />}
                            label="Download PGN"
                            onClick={downloadCurrentPgn}
                        />
                    </>
                )}
                <AsideBtn
                    icon={copiedLink ? <Check size={15} /> : <Link2 size={15} />}
                    label={copiedLink ? 'Copied' : 'Copy link'}
                    onClick={copyLink}
                />
            </Box>

            {onImportPgn && (
                <>
                    <AsideBtn
                        icon={<FileInput size={15} />}
                        label="Import PGN…"
                        active={pasteOpen}
                        onClick={() => {
                            setPasteOpen((v) => !v)
                            setPasteErr(null)
                        }}
                    />

                    {pasteOpen && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                            <Box
                                component="textarea"
                                autoFocus
                                value={pasteVal}
                                placeholder="Paste a PGN…"
                                rows={5}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                    setPasteVal(e.target.value)
                                    setPasteErr(null)
                                }}
                                sx={{
                                    width: '100%',
                                    boxSizing: 'border-box',
                                    resize: 'vertical',
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
                                <Typography sx={{ fontSize: 11.5, color: 'var(--danger, #e5484d)' }}>
                                    {pasteErr}
                                </Typography>
                            )}
                            <AsideBtn icon={<FileInput size={15} />} label="Load" onClick={submitImport} />
                        </Box>
                    )}
                </>
            )}
        </Box>
    )
}

interface PositionBodyProps {
    fen: string
    onLoadFen: (fen: string) => void
    onEnableDuck?: () => void
    /** See GameBodyProps.onDone. */
    onDone?: () => void
}

function PositionCard(props: PositionBodyProps) {
    return (
        <Card label="Position">
            <PositionBody {...props} />
        </Card>
    )
}

function PositionBody({ fen, onLoadFen, onEnableDuck, onDone }: PositionBodyProps) {
    const [pasteOpen, setPasteOpen] = useState(false)
    const [pasteVal, setPasteVal] = useState('')
    const [pasteErr, setPasteErr] = useState(false)
    const [copied, setCopied] = useState(false)

    const load = (next: string) => {
        onLoadFen(next)
        onDone?.()
    }

    const submitPaste = () => {
        const ok = validFen(pasteVal)
        if (!ok) {
            setPasteErr(true)
            return
        }
        onLoadFen(ok)
        setPasteOpen(false)
        setPasteVal('')
        setPasteErr(false)
        onDone?.()
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

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', gap: 1 }}>
                <AsideBtn
                    icon={<RotateCcw size={15} />}
                    label="New game"
                    onClick={() => load(START_FEN)}
                />
                <AsideBtn
                    icon={<Dices size={15} />}
                    label="Chess960"
                    onClick={() => load(random960())}
                />
                {onEnableDuck && (
                    <AsideBtn
                        icon={
                            <Box component="span" sx={{ fontSize: 15, lineHeight: 1 }}>
                                🦆
                            </Box>
                        }
                        label="Duck Chess"
                        onClick={() => {
                            onEnableDuck()
                            onDone?.()
                        }}
                    />
                )}
            </Box>
            <AsideBtn
                icon={<FileInput size={15} />}
                label="Paste FEN…"
                active={pasteOpen}
                onClick={() => {
                    setPasteOpen((v) => !v)
                    setPasteErr(false)
                }}
            />

            {pasteOpen && (
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
                        border: `1px solid ${pasteErr ? '#ca4a4a' : 'var(--line)'}`,
                        borderRadius: 'var(--radius)',
                        px: 1.25,
                        py: 1,
                        outline: 'none',
                        '&:focus': { borderColor: pasteErr ? '#ca4a4a' : 'var(--accent-line)' },
                        '&::placeholder': { color: 'var(--muted)' },
                    }}
                />
            )}

            <Box sx={{ height: '1px', bgcolor: 'var(--line-soft)', my: 0.5 }} />

            <Typography
                sx={{
                    fontSize: 10.5,
                    letterSpacing: 1.2,
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                Current FEN
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1 }}>
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
                            '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                        }}
                    >
                        {copied ? <Check size={16} /> : <Copy size={15} />}
                    </Box>
                </Tooltip>
            </Box>
        </Box>
    )
}

function AsideBtn({
    icon,
    label,
    active,
    onClick,
}: {
    icon: React.ReactNode
    label: string
    active?: boolean
    onClick: () => void
}) {
    return (
        <Box
            component="button"
            onClick={onClick}
            sx={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.75,
                height: 40,
                cursor: 'pointer',
                fontFamily: 'var(--font-display)',
                fontSize: 13.5,
                fontWeight: 600,
                letterSpacing: 0.2,
                color: active ? 'var(--accent)' : 'var(--text)',
                bgcolor: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
                borderRadius: 'var(--radius)',
                transition: 'color .15s, background-color .15s, border-color .15s, transform .05s',
                '&:hover': {
                    color: 'var(--accent)',
                    bgcolor: 'var(--line)',
                    borderColor: 'var(--accent-line)',
                },
                '&:active': { transform: 'translateY(1px)' },
            }}
        >
            {icon}
            {label}
        </Box>
    )
}
