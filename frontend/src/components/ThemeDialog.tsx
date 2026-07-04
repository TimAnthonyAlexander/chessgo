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
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 3,
                        minWidth: 380,
                        maxWidth: 460,
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
                {/* One continuous chessboard, 8 squares wide. Each theme is a 2×2
                 * block (4 per band); the checker orientation is shared so the whole
                 * grid reads as a single board. Scrolls vertically as themes grow. */}
                <Box
                    sx={{
                        maxHeight: 260,
                        overflowY: 'auto',
                        borderRadius: 2,
                        border: '1px solid var(--line)',
                        mb: 3,
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

                <SectionHeading>Pieces</SectionHeading>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
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

/** Shared selection frame styles for both swatches and piece cards. */
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
                            bgcolor: tone === 'light' ? light : dark,
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
                            aspectRatio: '1 / 1',
                            bgcolor:
                                i % 2 === 0 ? 'var(--board-light)' : 'var(--board-dark)',
                            backgroundImage: `url(${pieceImageUrl(char, set.id)})`,
                            backgroundSize: '86%',
                            backgroundPosition: 'center',
                            backgroundRepeat: 'no-repeat',
                        }}
                    />
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
