import { Box, Button, Dialog, DialogContent, Tooltip, Typography } from '@mui/material'
import {
    BOARD_THEMES,
    PIECE_SETS,
    themeStore,
    useBoardThemeId,
    usePieceSet,
    type BoardTheme,
    type PieceSet,
} from '../lib/boardTheme'
import { pieceImageUrl } from '../lib/chess'
import MiniBoard from './MiniBoard'

// A fixed, pieces-rich middlegame used purely to showcase the active board theme +
// piece set in the preview. lastMove tints two squares so the highlight color shows.
const PREVIEW_FEN = 'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 1'
const PREVIEW_LAST = 'c1g5'

/** A board square's paint: a plain color, or (for photographic themes like Cherry)
 * a url() texture sized to cover. Keeps color- and image-valued themes uniform. */
function paintSquare(value: string) {
    return value.startsWith('url(')
        ? {
              backgroundImage: value,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
          }
        : { bgcolor: value }
}

/** Appearance picker: choose the board color theme + piece set. Every selection
 * updates the appearance store immediately (live-previewed on the board behind the
 * dialog) and persists — there is no Apply/Save step, just a Done to close. */
export default function ThemeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const boardId = useBoardThemeId()
    const pieceId = usePieceSet()
    const boardLabel = BOARD_THEMES.find((t) => t.id === boardId)?.label ?? ''

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth={false}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 3,
                        width: '92vw',
                        maxWidth: 860,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3 }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 22,
                        mb: 2.5,
                    }}
                >
                    Appearance
                </Typography>

                <SectionHeading>Board — {boardLabel}</SectionHeading>
                {/* Left: the selector (one continuous 8×8 board, each theme a 2×2
                 * block). Right: a live preview of the active theme + piece set. */}
                <Box
                    sx={{
                        display: 'flex',
                        gap: 2,
                        mb: 3,
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                    }}
                >
                    <Box sx={{ flex: '1 1 260px', minWidth: 240 }}>
                        <Box
                            sx={{
                                border: '1px solid var(--line)',
                                overflow: 'hidden',
                            }}
                        >
                            <Box
                                sx={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(4, 1fr)',
                                }}
                            >
                                {BOARD_THEMES.map((theme) => (
                                    <BoardTile
                                        key={theme.id}
                                        theme={theme}
                                        selected={boardId === theme.id}
                                        onSelect={() => themeStore.setBoard(theme.id)}
                                    />
                                ))}
                            </Box>
                        </Box>
                    </Box>

                    <Box sx={{ flex: '1 1 260px', minWidth: 240 }}>
                        <MiniBoard fen={PREVIEW_FEN} lastMove={PREVIEW_LAST} />
                        <Typography
                            sx={{
                                mt: 1,
                                fontSize: 11,
                                textAlign: 'center',
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                color: 'var(--text-dim)',
                            }}
                        >
                            Live preview
                        </Typography>
                    </Box>
                </Box>

                <SectionHeading>Pieces</SectionHeading>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(2, 1fr)',
                        gap: 1.25,
                    }}
                >
                    {PIECE_SETS.map((set) => (
                        <PieceCard
                            key={set.id}
                            set={set}
                            selected={pieceId === set.id}
                            onSelect={() => themeStore.setPieces(set.id)}
                        />
                    ))}
                </Box>

                <Box sx={{ mt: 3, textAlign: 'right' }}>
                    <Button
                        variant="contained"
                        onClick={onClose}
                        sx={{ textTransform: 'none', px: 3 }}
                    >
                        Done
                    </Button>
                </Box>
            </DialogContent>
        </Dialog>
    )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                color: 'var(--text-dim)',
                mb: 1.25,
            }}
        >
            {children}
        </Typography>
    )
}

/** Shared selection frame styles for the piece cards. */
function selectionSx(selected: boolean) {
    return {
        border: selected ? '2px solid var(--accent)' : '2px solid var(--line)',
        bgcolor: selected ? 'var(--accent-soft)' : 'transparent',
        borderRadius: 2,
        p: 1,
        cursor: 'pointer',
        transition: 'border-color 120ms, background-color 120ms',
        '&:hover': {
            borderColor: selected ? 'var(--accent)' : 'var(--text-dim)',
        },
    } as const
}

// A single theme as a 2×2 block of the shared chessboard. The checker pattern is
// fixed ([dark, light] / [light, dark]) so that, tiled at even offsets, adjacent
// blocks line up into one continuous board regardless of each block's palette.
const TILE_PATTERN = ['dark', 'light', 'light', 'dark'] as const

function BoardTile({
    theme,
    selected,
    onSelect,
}: {
    theme: BoardTheme
    selected: boolean
    onSelect: () => void
}) {
    const light = theme.vars['--board-light']
    const dark = theme.vars['--board-dark']
    const border = theme.vars['--board-border-color']
    const cellBorder =
        border && border !== 'transparent' ? `inset 0 0 0 1px ${border}` : undefined
    return (
        <Tooltip title={theme.label} arrow disableInteractive enterDelay={200}>
            <Box
                onClick={onSelect}
                role="button"
                aria-label={theme.label}
                aria-pressed={selected}
                sx={{
                    position: 'relative',
                    aspectRatio: '1 / 1',
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gridTemplateRows: '1fr 1fr',
                    cursor: 'pointer',
                    '&:hover .tile-ring': { opacity: 1 },
                }}
            >
                {TILE_PATTERN.map((tone, i) => (
                    <Box
                        key={i}
                        sx={{
                            ...paintSquare(tone === 'light' ? light : dark),
                            boxShadow: cellBorder,
                        }}
                    />
                ))}
                {/* Selection / hover ring, drawn over the block edges. */}
                <Box
                    className="tile-ring"
                    sx={{
                        position: 'absolute',
                        inset: 0,
                        pointerEvents: 'none',
                        zIndex: 2,
                        boxShadow: selected
                            ? 'inset 0 0 0 3px var(--accent)'
                            : 'inset 0 0 0 2px var(--accent)',
                        opacity: selected ? 1 : 0,
                        transition: 'opacity 120ms',
                    }}
                />
            </Box>
        </Tooltip>
    )
}

const PREVIEW_PIECES = ['N', 'q', 'k', 'P']

function PieceCard({
    set,
    selected,
    onSelect,
}: {
    set: PieceSet
    selected: boolean
    onSelect: () => void
}) {
    return (
        <Box onClick={onSelect} sx={selectionSx(selected)}>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    borderRadius: '6px',
                    overflow: 'hidden',
                }}
            >
                {PREVIEW_PIECES.map((char, i) => (
                    <Box
                        key={char}
                        sx={{
                            position: 'relative',
                            aspectRatio: '1 / 1',
                            // Cell background follows the active board theme. The
                            // `background` shorthand takes either a color or a url()
                            // (resolved from the var at render); cover sizes a texture.
                            // The piece is an overlay so a url() theme isn't clobbered.
                            background:
                                i % 2 === 0 ? 'var(--board-light)' : 'var(--board-dark)',
                            backgroundSize: 'cover',
                            backgroundPosition: 'center',
                        }}
                    >
                        <Box
                            sx={{
                                position: 'absolute',
                                inset: 0,
                                backgroundImage: `url(${pieceImageUrl(char, set.id)})`,
                                backgroundSize: '86%',
                                backgroundPosition: 'center',
                                backgroundRepeat: 'no-repeat',
                            }}
                        />
                    </Box>
                ))}
            </Box>
            <Typography
                sx={{
                    mt: 0.75,
                    fontSize: 13.5,
                    fontWeight: selected ? 600 : 500,
                    color: 'var(--text)',
                }}
            >
                {set.label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10.5,
                    color: 'var(--text-dim)',
                    lineHeight: 1.4,
                }}
            >
                {set.credit}
            </Typography>
        </Box>
    )
}
