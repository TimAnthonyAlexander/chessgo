import { Box, Button, Dialog, DialogContent, Typography } from '@mui/material'
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

                <SectionHeading>Board</SectionHeading>
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
                        gap: 1.25,
                        mb: 3,
                    }}
                >
                    {BOARD_THEMES.map((theme) => (
                        <BoardSwatch
                            key={theme.id}
                            theme={theme}
                            selected={boardId === theme.id}
                            onSelect={() => themeStore.setBoard(theme.id)}
                        />
                    ))}
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

function BoardSwatch({
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
    return (
        <Box onClick={onSelect} sx={selectionSx(selected)}>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    aspectRatio: '1 / 1',
                    borderRadius: '6px',
                    overflow: 'hidden',
                }}
            >
                {Array.from({ length: 16 }, (_, i) => {
                    const row = Math.floor(i / 4)
                    const col = i % 4
                    const isLight = (col + row) % 2 === 1
                    return <Box key={i} sx={{ bgcolor: isLight ? light : dark }} />
                })}
            </Box>
            <Typography
                sx={{
                    mt: 0.75,
                    fontSize: 12.5,
                    textAlign: 'center',
                    color: selected ? 'var(--text)' : 'var(--text-dim)',
                    fontWeight: selected ? 600 : 400,
                }}
            >
                {theme.label}
            </Typography>
        </Box>
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
