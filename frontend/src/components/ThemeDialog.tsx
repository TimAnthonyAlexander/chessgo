import { useState } from 'react'
import {
    Box,
    Button,
    Dialog,
    DialogContent,
    Slider,
    Switch,
    Tab,
    Tabs,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
} from '@mui/material'
import {
    BOARD_THEMES,
    PIECE_SETS,
    themeStore,
    useBoardThemeId,
    usePieceSet,
    type BoardTheme,
    type PieceSet,
} from '../lib/boardTheme'
import {
    SOUND_MATERIALS,
    soundThemeStore,
    useSoundMaterial,
    type SoundMaterial,
} from '../lib/soundTheme'
import { previewMaterial, setSoundEnabled } from '../lib/sounds'
import { settingsStore, usePrefs, type Prefs } from '../lib/settings'
import {
    SITE_BACKDROPS,
    SITE_PALETTES,
    siteThemeStore,
    paletteSwatch,
    useSiteTheme,
    type BackdropId,
    type SitePaletteId,
} from '../lib/siteTheme'
import { pieceImageUrl } from '../lib/chess'
import MiniBoard from './MiniBoard'

// A fixed, pieces-rich middlegame used purely to showcase the active board theme +
// piece set in the preview. lastMove tints two squares so the highlight color shows.
const PREVIEW_FEN = 'r2q1rk1/ppp2ppp/2np1n2/2b1p1B1/2B1P1b1/2NP1N2/PPP2PPP/R2Q1RK1 w - - 0 1'
const PREVIEW_LAST = 'c1g5'

type TabKey = 'theme' | 'board' | 'gameplay' | 'sound'

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

/** Appearance + preferences picker. Every selection updates its store immediately
 * (live-previewed on the board behind the dialog) and persists — there is no
 * Apply/Save step, just a Done to close. Organized into Board / Gameplay / Sound
 * tabs so the ~30 settings fit cleanly; the search box flattens all four tabs into
 * one filtered list so a setting is never more than a few keystrokes away. */
export default function ThemeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const [tab, setTab] = useState<TabKey>('theme')
    const [query, setQuery] = useState('')
    const searching = query.trim().length > 0

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
            <DialogContent sx={{ p: 3, maxHeight: '86vh', overflowY: 'auto' }}>
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 2,
                        mb: 2,
                    }}
                >
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-display)',
                            fontWeight: 600,
                            fontSize: 22,
                        }}
                    >
                        Settings
                    </Typography>
                    <TextField
                        size="small"
                        placeholder="Search settings"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        sx={{
                            width: 200,
                            '& .MuiOutlinedInput-root': {
                                fontSize: 13,
                                bgcolor: 'var(--surface-2)',
                                '& fieldset': { borderColor: 'var(--line)' },
                                '&:hover fieldset': { borderColor: 'var(--line)' },
                                '&.Mui-focused fieldset': { borderColor: 'var(--accent)' },
                            },
                        }}
                    />
                </Box>

                {!searching && (
                    <Tabs
                        value={tab}
                        onChange={(_, v: TabKey) => setTab(v)}
                        sx={{
                            mb: 2.5,
                            minHeight: 0,
                            borderBottom: '1px solid var(--line-soft)',
                            '& .MuiTab-root': {
                                textTransform: 'none',
                                fontWeight: 600,
                                fontSize: 14,
                                minHeight: 40,
                                color: 'var(--text-dim)',
                                '&.Mui-selected': { color: 'var(--accent)' },
                            },
                            '& .MuiTabs-indicator': { backgroundColor: 'var(--accent)' },
                        }}
                    >
                        <Tab value="theme" label="Theme" />
                        <Tab value="board" label="Board" />
                        <Tab value="gameplay" label="Gameplay" />
                        <Tab value="sound" label="Sound" />
                    </Tabs>
                )}

                {searching ? (
                    <>
                        <ThemeTab query={query} />
                        <BoardTab query={query} />
                        <GameplayTab query={query} />
                        <SoundTab query={query} />
                    </>
                ) : (
                    <>
                        {tab === 'theme' && <ThemeTab />}
                        {tab === 'board' && <BoardTab />}
                        {tab === 'gameplay' && <GameplayTab />}
                        {tab === 'sound' && <SoundTab />}
                    </>
                )}

                <Box
                    sx={{
                        mt: 3,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                    }}
                >
                    <Button
                        onClick={() => {
                            settingsStore.reset()
                            siteThemeStore.reset()
                            themeStore.reset()
                            soundThemeStore.reset()
                        }}
                        sx={{ textTransform: 'none', color: 'var(--text-dim)', fontSize: 13 }}
                    >
                        Reset to defaults
                    </Button>
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

// --- Search -------------------------------------------------------------------

/** Case-insensitive substring match against a row's label + hint, used by the
 * search box. An empty query always matches (today's behaviour when not
 * searching). Threaded into RowShell so every Toggle/Segment/Slider row filters
 * itself with no per-callsite plumbing. */
function matches(query: string, label: string, hint?: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    return label.toLowerCase().includes(q) || !!hint?.toLowerCase().includes(q)
}

// --- Tabs -------------------------------------------------------------------

/** Site theme: light/dark mode, accent+neutral palette, and page backdrop. These
 * control the WEBSITE chrome and are fully independent of the board theme below —
 * changing one never touches the other. Every choice applies live to the whole
 * app behind the dialog (no Apply step), mirroring the board picker. */
function ThemeTab({ query = '' }: { query?: string }) {
    const site = useSiteTheme()
    const searching = query.trim().length > 0

    return (
        <>
            {!searching && <SectionHeading>Appearance</SectionHeading>}

            {(!searching || matches(query, 'Palette')) && (
                <Box sx={{ mt: 2.5 }}>
                    <SectionHeading>Palette</SectionHeading>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                            gap: 1.25,
                            mb: 3,
                        }}
                    >
                        {SITE_PALETTES.map((p) => (
                            <PaletteCard
                                key={p.id}
                                id={p.id}
                                label={p.label}
                                note={p.note}
                                mode={site.resolved}
                                selected={site.palette === p.id}
                                onSelect={() => siteThemeStore.setPalette(p.id)}
                            />
                        ))}
                    </Box>
                </Box>
            )}

            {(!searching || matches(query, 'Backdrop')) && (
                <>
                    <SectionHeading>Backdrop</SectionHeading>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(3, 1fr)',
                            gap: 1.25,
                        }}
                    >
                        {SITE_BACKDROPS.map((b) => (
                            <BackdropCard
                                key={b.id}
                                id={b.id}
                                label={b.label}
                                note={b.note}
                                selected={site.backdrop === b.id}
                                onSelect={() => siteThemeStore.setBackdrop(b.id)}
                            />
                        ))}
                    </Box>
                </>
            )}
        </>
    )
}

function BoardTab({ query = '' }: { query?: string }) {
    const boardId = useBoardThemeId()
    const pieceId = usePieceSet()
    const prefs = usePrefs()
    const boardLabel = BOARD_THEMES.find((t) => t.id === boardId)?.label ?? ''
    const searching = query.trim().length > 0

    return (
        <>
            {!searching && <SectionHeading>Layout</SectionHeading>}
            <SegmentRow
                label="Page layout"
                hint="Board centered between two columns, or beside a single rail with player strips"
                value={prefs.boardLayout}
                options={[
                    { value: 'lichess', label: 'Center board' },
                    { value: 'chesscom', label: 'Side rail' },
                ]}
                onChange={(v) => settingsStore.set('boardLayout', v as Prefs['boardLayout'])}
                query={query}
            />

            {(!searching || matches(query, 'Board')) && (
                <>
                    <SectionHeading>Board — {boardLabel}</SectionHeading>
                    {/* Left: the selector (one continuous 8×8 board, each theme a 2×2 block).
                     * Right: a live preview of the active theme + piece set. */}
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
                            <Box sx={{ border: '1px solid var(--line)', overflow: 'hidden' }}>
                                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)' }}>
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
                </>
            )}

            {(!searching || matches(query, 'Pieces')) && (
                <>
                    <SectionHeading>Pieces</SectionHeading>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(2, 1fr)',
                            gap: 1.25,
                            mb: 3,
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
                </>
            )}

            {!searching && <SectionHeading>Display</SectionHeading>}
            <ToggleRow
                label="Legal move indicators"
                hint="Show dots on the squares a selected piece can move to"
                checked={prefs.showLegalMoves}
                onChange={(v) => settingsStore.set('showLegalMoves', v)}
                query={query}
            />
            <SegmentRow
                label="Coordinates"
                hint="a–h / 1–8 labels on the board"
                value={prefs.showCoordinates}
                options={[
                    { value: 'inside', label: 'Inside' },
                    { value: 'outside', label: 'Outside' },
                    { value: 'off', label: 'Off' },
                ]}
                onChange={(v) => settingsStore.set('showCoordinates', v as Prefs['showCoordinates'])}
                query={query}
            />
            <ToggleRow
                label="Highlight last move"
                hint="Tint the from/to squares of the most recent move"
                checked={prefs.highlightLastMove}
                onChange={(v) => settingsStore.set('highlightLastMove', v)}
                query={query}
            />
            <ToggleRow
                label="Highlight check"
                hint="Glow the king's square when it is in check"
                checked={prefs.highlightCheck}
                onChange={(v) => settingsStore.set('highlightCheck', v)}
                query={query}
            />
            <ToggleRow
                label="Highlight square under piece"
                hint="Ring the legal square your dragged piece is hovering"
                checked={prefs.highlightDragOver}
                onChange={(v) => settingsStore.set('highlightDragOver', v)}
                query={query}
            />
            <SegmentRow
                label="Piece animation"
                hint="Speed of the piece appear animation"
                value={prefs.animationSpeed}
                options={[
                    { value: 'none', label: 'None' },
                    { value: 'fast', label: 'Fast' },
                    { value: 'normal', label: 'Normal' },
                    { value: 'slow', label: 'Slow' },
                ]}
                onChange={(v) => settingsStore.set('animationSpeed', v as Prefs['animationSpeed'])}
                query={query}
            />
            <SliderRow
                label="Board brightness"
                hint="Dim the board squares (pieces stay crisp)"
                value={prefs.boardBrightness}
                min={70}
                max={100}
                step={5}
                format={(v) => `${v}%`}
                onChange={(v) => settingsStore.set('boardBrightness', v)}
                query={query}
            />
            <SliderRow
                label="Board contrast"
                hint="Adjust the contrast between the light and dark squares"
                value={prefs.boardContrast}
                min={70}
                max={130}
                step={5}
                format={(v) => `${v}%`}
                onChange={(v) => settingsStore.set('boardContrast', v)}
                query={query}
            />
            <ToggleRow
                label="Blindfold mode"
                hint="Hide all pieces — squares, coordinates and last move stay"
                checked={prefs.blindfold}
                onChange={(v) => settingsStore.set('blindfold', v)}
                query={query}
            />
            <ToggleRow
                label="Show captured pieces"
                hint="Material captured by each side, next to the clocks"
                checked={prefs.showCaptured}
                onChange={(v) => settingsStore.set('showCaptured', v)}
                query={query}
            />
        </>
    )
}

function GameplayTab({ query = '' }: { query?: string }) {
    const prefs = usePrefs()
    const searching = query.trim().length > 0
    return (
        <>
            {!searching && <SectionHeading>Moving</SectionHeading>}
            <SegmentRow
                label="Move method"
                hint="How you move a piece"
                value={prefs.moveMethod}
                options={[
                    { value: 'both', label: 'Both' },
                    { value: 'click', label: 'Click' },
                    { value: 'drag', label: 'Drag' },
                ]}
                onChange={(v) => settingsStore.set('moveMethod', v as Prefs['moveMethod'])}
                query={query}
            />
            <ToggleRow
                label="Auto-promote to Queen"
                hint="Skip the promotion picker and always choose a queen"
                checked={prefs.autoQueen}
                onChange={(v) => settingsStore.set('autoQueen', v)}
                query={query}
            />
            <ToggleRow
                label="Premoves"
                hint="Queue a move during your opponent's turn"
                checked={prefs.premoves}
                onChange={(v) => settingsStore.set('premoves', v)}
                query={query}
            />
            <ToggleRow
                label="Click the rook to castle"
                hint="Otherwise, move the king two squares"
                checked={prefs.rookCastle}
                onChange={(v) => settingsStore.set('rookCastle', v)}
                query={query}
            />
            <ToggleRow
                label="Play with the keyboard"
                hint="Arrow keys move a cursor around the board, Enter selects and moves. Off by default: it makes squares focusable and takes the arrow keys away from the move list."
                checked={prefs.keyboardBoard}
                onChange={(v) => settingsStore.set('keyboardBoard', v)}
                query={query}
            />
            <SegmentRow
                label="Confirm move before sending"
                hint="Adds a confirm step so you can't mouse-slip. 'Slow games' = classical and correspondence only."
                value={prefs.confirmMove}
                options={[
                    { value: 'never', label: 'Never' },
                    { value: 'slow', label: 'Slow games' },
                    { value: 'always', label: 'Always' },
                ]}
                onChange={(v) => settingsStore.set('confirmMove', v as Prefs['confirmMove'])}
                query={query}
            />
            <SegmentRow
                label="Default arrow color"
                hint="Color of a right-click arrow with no modifier held"
                value={prefs.arrowColor}
                options={[
                    { value: 'green', label: 'Green' },
                    { value: 'blue', label: 'Blue' },
                    { value: 'red', label: 'Red' },
                    { value: 'yellow', label: 'Yellow' },
                ]}
                onChange={(v) => settingsStore.set('arrowColor', v as Prefs['arrowColor'])}
                query={query}
            />
            <SegmentRow
                label="Move notation"
                hint="How moves read in every move list"
                value={prefs.notation}
                options={[
                    { value: 'san', label: 'SAN (Nf3)' },
                    { value: 'figurine', label: 'Figurine (♘f3)' },
                ]}
                onChange={(v) => settingsStore.set('notation', v as Prefs['notation'])}
                query={query}
            />

            {!searching && <SectionHeading>During a game</SectionHeading>}
            <ToggleRow
                label="Confirm resignation"
                hint="Ask before resigning a game"
                checked={prefs.confirmResign}
                onChange={(v) => settingsStore.set('confirmResign', v)}
                query={query}
            />
            <ToggleRow
                label="Auto-flip board"
                hint="Orient the board to the side to move"
                checked={prefs.autoFlip}
                onChange={(v) => settingsStore.set('autoFlip', v)}
                query={query}
            />
            <ToggleRow
                label="Zen mode"
                hint="Hide clocks, ratings and side panels while playing"
                checked={prefs.zenMode}
                onChange={(v) => settingsStore.set('zenMode', v)}
                query={query}
            />
            <ToggleRow
                label="Show opponent rating"
                hint="Display your opponent's rating during play"
                checked={prefs.showOpponentRating}
                onChange={(v) => settingsStore.set('showOpponentRating', v)}
                query={query}
            />
            <ToggleRow
                label="Show evaluation bar"
                hint="Show the engine eval bar"
                checked={prefs.showEvalBar}
                onChange={(v) => settingsStore.set('showEvalBar', v)}
                query={query}
            />
            <ToggleRow
                label="Show move list"
                hint="Show the move/notation panel beside the board"
                checked={prefs.showMoveList}
                onChange={(v) => settingsStore.set('showMoveList', v)}
                query={query}
            />

            {!searching && <SectionHeading>Clock</SectionHeading>}
            <SegmentRow
                label="Show tenths of a second"
                hint="When the clock displays fractional seconds"
                value={prefs.clockTenths}
                options={[
                    { value: 'never', label: 'Never' },
                    { value: 'lowtime', label: 'Under 10s' },
                    { value: 'always', label: 'Always' },
                ]}
                onChange={(v) => settingsStore.set('clockTenths', v as Prefs['clockTenths'])}
                query={query}
            />
            <ToggleRow
                label="Clock progress bar"
                hint="A bar under each clock that drains as time runs out"
                checked={prefs.clockBar}
                onChange={(v) => settingsStore.set('clockBar', v)}
                query={query}
            />
        </>
    )
}

function SoundTab({ query = '' }: { query?: string }) {
    const prefs = usePrefs()
    const materialId = useSoundMaterial()
    const searching = query.trim().length > 0

    return (
        <>
            {!searching && <SectionHeading>Output</SectionHeading>}
            <ToggleRow
                label="Sounds"
                hint="Master switch for all sound effects"
                checked={prefs.soundEnabled}
                onChange={(v) => setSoundEnabled(v)}
                query={query}
            />
            <SliderRow
                label="Volume"
                hint="Master output level"
                value={prefs.soundVolume}
                min={0}
                max={100}
                step={5}
                disabled={!prefs.soundEnabled}
                format={(v) => `${v}%`}
                onChange={(v) => settingsStore.set('soundVolume', v)}
                query={query}
            />
            <ToggleRow
                label="Low-time warning"
                hint="Play a cue when your clock runs low"
                checked={prefs.soundLowTime}
                onChange={(v) => settingsStore.set('soundLowTime', v)}
                query={query}
            />

            {(!searching || matches(query, 'Sound')) && (
                <Box sx={{ mt: 3 }}>
                    <SectionHeading>Sound — click to hear</SectionHeading>
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                            gap: 1.25,
                        }}
                    >
                        {SOUND_MATERIALS.map((material) => (
                            <MaterialCard
                                key={material.id}
                                material={material}
                                selected={materialId === material.id}
                                onSelect={() => {
                                    soundThemeStore.set(material.id)
                                    previewMaterial(material.id)
                                }}
                            />
                        ))}
                    </Box>
                </Box>
            )}
        </>
    )
}

// --- Reusable setting rows --------------------------------------------------

function RowShell({
    label,
    hint,
    control,
    query = '',
}: {
    label: string
    hint?: string
    control: React.ReactNode
    /** Search-box query. When set and it matches neither label nor hint, the row
     * renders nothing — the single choke point every row type filters through. */
    query?: string
}) {
    if (!matches(query, label, hint)) return null
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
                py: 1,
                borderBottom: '1px solid var(--line-soft)',
            }}
        >
            <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {label}
                </Typography>
                {hint && (
                    <Typography sx={{ fontSize: 12, color: 'var(--text-dim)', mt: 0.25 }}>
                        {hint}
                    </Typography>
                )}
            </Box>
            <Box sx={{ flexShrink: 0 }}>{control}</Box>
        </Box>
    )
}

function ToggleRow({
    label,
    hint,
    checked,
    onChange,
    query,
}: {
    label: string
    hint?: string
    checked: boolean
    onChange: (v: boolean) => void
    query?: string
}) {
    return (
        <RowShell
            label={label}
            hint={hint}
            query={query}
            control={
                <Switch
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    sx={{
                        '& .MuiSwitch-switchBase.Mui-checked': { color: 'var(--accent)' },
                        '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
                            backgroundColor: 'var(--accent)',
                        },
                    }}
                />
            }
        />
    )
}

function SegmentRow<T extends string>({
    label,
    hint,
    value,
    options,
    onChange,
    query,
}: {
    label: string
    hint?: string
    value: T
    options: { value: T; label: string }[]
    onChange: (v: T) => void
    query?: string
}) {
    return (
        <RowShell
            label={label}
            hint={hint}
            query={query}
            control={
                <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={value}
                    onChange={(_, v: T | null) => v != null && onChange(v)}
                    sx={{
                        flexWrap: 'wrap',
                        justifyContent: 'flex-end',
                        '& .MuiToggleButton-root': {
                            textTransform: 'none',
                            fontSize: 12.5,
                            fontWeight: 600,
                            px: 1.4,
                            py: 0.4,
                            color: 'var(--text-dim)',
                            borderColor: 'var(--line)',
                            '&.Mui-selected': {
                                color: 'var(--accent)',
                                bgcolor: 'var(--accent-soft)',
                                '&:hover': { bgcolor: 'var(--accent-soft)' },
                            },
                        },
                    }}
                >
                    {options.map((o) => (
                        <ToggleButton key={o.value} value={o.value}>
                            {o.label}
                        </ToggleButton>
                    ))}
                </ToggleButtonGroup>
            }
        />
    )
}

function SliderRow({
    label,
    hint,
    value,
    min,
    max,
    step,
    disabled,
    format,
    onChange,
    query,
}: {
    label: string
    hint?: string
    value: number
    min: number
    max: number
    step: number
    disabled?: boolean
    format: (v: number) => string
    onChange: (v: number) => void
    query?: string
}) {
    return (
        <RowShell
            label={label}
            hint={hint}
            query={query}
            control={
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, width: 200 }}>
                    <Slider
                        value={value}
                        min={min}
                        max={max}
                        step={step}
                        disabled={disabled}
                        onChange={(_, v) => onChange(v as number)}
                        sx={{ color: 'var(--accent)' }}
                    />
                    <Typography
                        sx={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 12,
                            color: 'var(--text-dim)',
                            width: 42,
                            textAlign: 'right',
                        }}
                    >
                        {format(value)}
                    </Typography>
                </Box>
            }
        />
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
                mt: 0.5,
            }}
        >
            {children}
        </Typography>
    )
}

/** Shared selection frame styles for the piece / material cards. */
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

/** A site-palette option. Renders a miniature of the chrome in THIS palette's own
 * colors (canvas, a surface chip, a heading/body line, an accent pill) for the
 * currently resolved light/dark mode — so options are comparable at a glance
 * regardless of which is active. */
function PaletteCard({
    id,
    label,
    note,
    mode,
    selected,
    onSelect,
}: {
    id: SitePaletteId
    label: string
    note: string
    mode: 'light' | 'dark'
    selected: boolean
    onSelect: () => void
}) {
    const sw = paletteSwatch(id, mode)
    return (
        <Tooltip title={note} arrow disableInteractive enterDelay={300}>
            <Box
                onClick={onSelect}
                role="button"
                aria-label={label}
                aria-pressed={selected}
                sx={selectionSx(selected)}
            >
                {/* Miniature chrome in this palette's colors. */}
                <Box
                    sx={{
                        borderRadius: 1.5,
                        overflow: 'hidden',
                        border: `1px solid ${sw.line}`,
                        bgcolor: sw.bg,
                        p: 1,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 0.75,
                    }}
                >
                    <Box
                        sx={{
                            bgcolor: sw.surface,
                            border: `1px solid ${sw.line}`,
                            borderRadius: 1,
                            px: 0.75,
                            py: 0.6,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 0.5,
                        }}
                    >
                        <Box sx={{ height: 5, width: '62%', borderRadius: 2, bgcolor: sw.text }} />
                        <Box sx={{ height: 4, width: '88%', borderRadius: 2, bgcolor: sw.text, opacity: 0.35 }} />
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Box
                            sx={{
                                height: 14,
                                minWidth: 34,
                                borderRadius: 2,
                                bgcolor: sw.accent,
                            }}
                        />
                        <Box sx={{ height: 8, width: 8, borderRadius: '50%', bgcolor: sw.accent }} />
                    </Box>
                </Box>
                <Typography
                    sx={{ mt: 0.75, fontSize: 13.5, fontWeight: selected ? 600 : 500, color: 'var(--text)' }}
                >
                    {label}
                </Typography>
            </Box>
        </Tooltip>
    )
}

/** A backdrop option — the preview box paints the actual backdrop the choice would
 * apply under the active palette/mode (accent-tinted glows, hairline grid, or a
 * flat fill), so the difference is visible before committing. */
function BackdropCard({
    id,
    label,
    note,
    selected,
    onSelect,
}: {
    id: BackdropId
    label: string
    note: string
    selected: boolean
    onSelect: () => void
}) {
    const bd = siteThemeStore.backdropPreview(id)
    return (
        <Box
            onClick={onSelect}
            role="button"
            aria-label={label}
            aria-pressed={selected}
            sx={selectionSx(selected)}
        >
            <Box
                sx={{
                    height: 56,
                    borderRadius: 1.5,
                    border: '1px solid var(--line)',
                    bgcolor: 'var(--bg)',
                    backgroundImage: bd.image === 'none' ? undefined : bd.image,
                    backgroundSize: bd.size,
                    backgroundPosition: 'center',
                }}
            />
            <Typography
                sx={{ mt: 0.75, fontSize: 13, fontWeight: selected ? 600 : 500, color: 'var(--text)' }}
            >
                {label}
            </Typography>
            <Typography sx={{ fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                {note}
            </Typography>
        </Box>
    )
}

/** A sound-material option. Selecting it both persists the choice and auditions
 * the timbre (the synth is instant, so a click plays a sample move + capture). */
function MaterialCard({
    material,
    selected,
    onSelect,
}: {
    material: SoundMaterial
    selected: boolean
    onSelect: () => void
}) {
    return (
        <Box
            onClick={onSelect}
            role="button"
            aria-label={material.label}
            aria-pressed={selected}
            sx={selectionSx(selected)}
        >
            <Typography sx={{ fontSize: 13.5, fontWeight: selected ? 600 : 500, color: 'var(--text)' }}>
                {material.label}
            </Typography>
            <Typography sx={{ mt: 0.25, fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                {material.description}
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
                            position: 'relative',
                            aspectRatio: '1 / 1',
                            background: i % 2 === 0 ? 'var(--board-light)' : 'var(--board-dark)',
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
            <Typography sx={{ mt: 0.75, fontSize: 13.5, fontWeight: selected ? 600 : 500, color: 'var(--text)' }}>
                {set.label}
            </Typography>
            <Typography
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.4 }}
            >
                {set.credit}
            </Typography>
        </Box>
    )
}
