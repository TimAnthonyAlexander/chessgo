import { Box, MenuItem, Select, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { type Variant, VARIANT_BLURB, VARIANT_LABEL } from '../lib/variants'

const ORDER: Variant[] = [
    'standard',
    'chess960',
    'duck',
    'crazyhouse',
    'antichess',
    'secretqueen',
    'fading',
    'glassjaw',
    'doublemove',
]

/**
 * Controlled variant selector for the "New game" setup card — Standard / Chess960 /
 * Duck Chess / Crazyhouse / Antichess / Secret Queen / Fading / Glass Jaw / Double
 * Move, each with its one-line blurb. Styled to match the Setup card's toggle
 * aesthetic (gold-selected pills on the dark surface).
 *
 * `only` restricts the rendered options to a subset (in ORDER's order) — e.g. the
 * live challenge dialog offers just Standard / Chess960. Omit for all variants.
 *
 * `layout` picks the rendering: 'list' (default) is the original full-height
 * vertical stack, one full-width button per variant with its own blurb — fine
 * inside ChallengeDialog's modal, where height is free. 'menu' collapses that
 * into a compact dropdown for sidebar use (BotGame's setup card), where 8 stacked
 * variant buttons would run taller than the board itself.
 */
export default function VariantPicker({
    value,
    onChange,
    disabled = false,
    only,
    layout = 'list',
}: {
    value: Variant
    onChange: (v: Variant) => void
    disabled?: boolean
    only?: Variant[]
    layout?: 'list' | 'menu'
}) {
    const options = only ? ORDER.filter((v) => only.includes(v)) : ORDER

    if (layout === 'menu') {
        return (
            <Box>
                <Select<Variant>
                    value={value}
                    disabled={disabled}
                    onChange={(e) => onChange(e.target.value as Variant)}
                    aria-label="Game variant"
                    renderValue={(v) => (
                        <Typography
                            component="span"
                            sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 14.5 }}
                        >
                            {VARIANT_LABEL[v]}
                        </Typography>
                    )}
                    MenuProps={{ PaperProps: { sx: menuPaperSx } }}
                    sx={selectSx}
                >
                    {options.map((v) => (
                        <MenuItem key={v} value={v} sx={menuItemSx}>
                            <Box sx={{ width: '100%' }}>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-display)',
                                        fontWeight: 700,
                                        fontSize: 14,
                                        lineHeight: 1.2,
                                    }}
                                >
                                    {VARIANT_LABEL[v]}
                                </Typography>
                                <Typography
                                    sx={{
                                        fontSize: 12,
                                        lineHeight: 1.35,
                                        mt: 0.25,
                                        color: 'var(--text-dim)',
                                        whiteSpace: 'normal',
                                    }}
                                >
                                    {VARIANT_BLURB[v]}
                                </Typography>
                            </Box>
                        </MenuItem>
                    ))}
                </Select>
                {/* The closed dropdown only has room for the label — the blurb (what
                    "Glass Jaw" actually means) still needs to be visible for whichever
                    variant is currently selected. */}
                <Typography
                    sx={{
                        fontSize: 12.5,
                        lineHeight: 1.4,
                        color: 'var(--text-dim)',
                        mt: 0.75,
                    }}
                >
                    {VARIANT_BLURB[value]}
                </Typography>
            </Box>
        )
    }

    return (
        <ToggleButtonGroup
            exclusive
            orientation="vertical"
            fullWidth
            value={value}
            disabled={disabled}
            onChange={(_, v) => v && onChange(v as Variant)}
            sx={pickerSx}
        >
            {options.map((v) => (
                <ToggleButton key={v} value={v}>
                    <Box sx={{ textAlign: 'left', width: '100%' }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontWeight: 700,
                                fontSize: 14.5,
                                lineHeight: 1.2,
                            }}
                        >
                            {VARIANT_LABEL[v]}
                        </Typography>
                        <Typography
                            sx={{
                                fontSize: 12,
                                lineHeight: 1.3,
                                mt: 0.25,
                                opacity: 0.72,
                                textTransform: 'none',
                            }}
                        >
                            {VARIANT_BLURB[v]}
                        </Typography>
                    </Box>
                </ToggleButton>
            ))}
        </ToggleButtonGroup>
    )
}

const pickerSx = {
    mt: 1,
    gap: 0.75,
    '& .MuiToggleButton-root': {
        color: 'var(--text-dim)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius) !important',
        textTransform: 'none',
        justifyContent: 'flex-start',
        px: 1.5,
        py: 1.1,
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

const selectSx = {
    width: '100%',
    color: 'var(--text)',
    bgcolor: 'var(--surface-2)',
    borderRadius: 'var(--radius)',
    '& .MuiSelect-select': { py: 1.1, px: 1.5 },
    '& .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--line)' },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent)' },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--accent)' },
    '&.Mui-disabled': { opacity: 0.6 },
    '& .MuiSvgIcon-root': { color: 'var(--text-dim)' },
}

const menuPaperSx = {
    mt: 0.5,
    bgcolor: 'var(--surface)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)',
}

const menuItemSx = {
    alignItems: 'flex-start',
    whiteSpace: 'normal',
    py: 1,
    px: 1.5,
    color: 'var(--text)',
    '&:hover': { bgcolor: 'var(--line)' },
    '&.Mui-selected': {
        bgcolor: 'var(--accent-soft)',
        '&:hover': { bgcolor: 'var(--accent-soft)' },
    },
}
