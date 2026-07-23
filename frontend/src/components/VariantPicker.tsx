import { Box, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { type Variant, VARIANT_BLURB, VARIANT_LABEL } from '../lib/variants'

const ORDER: Variant[] = [
    'standard',
    'chess960',
    'duck',
    'crazyhouse',
    'antichess',
    'fading',
    'glassjaw',
    'doublemove',
]

/**
 * Controlled variant selector for the "New game" setup card — Standard / Chess960 /
 * Duck Chess / Crazyhouse / Antichess / Fading / Glass Jaw / Double Move, each with
 * its one-line blurb. Styled to match the Setup card's toggle aesthetic (gold-selected
 * pills on the dark surface).
 *
 * `only` restricts the rendered options to a subset (in ORDER's order) — e.g. the
 * live challenge dialog offers just Standard / Chess960. Omit for all variants.
 */
export default function VariantPicker({
    value,
    onChange,
    disabled = false,
    only,
}: {
    value: Variant
    onChange: (v: Variant) => void
    disabled?: boolean
    only?: Variant[]
}) {
    const options = only ? ORDER.filter((v) => only.includes(v)) : ORDER
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
        borderRadius: '10px !important',
        textTransform: 'none',
        justifyContent: 'flex-start',
        px: 1.5,
        py: 1.1,
        transition: 'color .15s, background .15s, border-color .15s',
        '&:hover': { background: 'var(--line)', color: 'var(--accent)' },
        '&.Mui-selected': {
            color: '#15171c',
            background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
            borderColor: 'var(--accent)',
            '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
        },
    },
}
