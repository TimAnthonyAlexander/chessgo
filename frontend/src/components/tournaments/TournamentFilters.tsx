import { Box } from '@mui/material'
import type { TournamentVariant } from '../../api/client'
import { VARIANT_LABEL } from '../../lib/variants'
import { SPEED_LABEL, type Speed } from './timing'

const VARIANTS: TournamentVariant[] = ['standard', 'chess960', 'duck', 'crazyhouse', 'antichess']
const SPEEDS: Speed[] = ['bullet', 'blitz', 'rapid', 'classical']

/** A quiet filter bar — variant, then speed — for cutting the hourly rota
 * down to size. Plain text pills, one accent for the active choice, no
 * per-option colour. */
export default function TournamentFilters({
    variant,
    onVariant,
    speed,
    onSpeed,
}: {
    variant: TournamentVariant | null
    onVariant: (v: TournamentVariant | null) => void
    speed: Speed | null
    onSpeed: (s: Speed | null) => void
}) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: 1.5,
                rowGap: 0.75,
                mb: 2,
            }}
        >
            <Pills
                value={variant}
                onChange={onVariant}
                options={VARIANTS.map((v) => ({ value: v, label: VARIANT_LABEL[v] }))}
            />
            <Box sx={{ width: '1px', alignSelf: 'stretch', bgcolor: 'var(--line-soft)', display: { xs: 'none', sm: 'block' } }} />
            <Pills
                value={speed}
                onChange={onSpeed}
                options={SPEEDS.map((s) => ({ value: s, label: SPEED_LABEL[s] }))}
            />
        </Box>
    )
}

function Pills<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T | null
    onChange: (v: T | null) => void
    options: { value: T; label: string }[]
}) {
    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            <Pill active={value === null} onClick={() => onChange(null)} label="All" />
            {options.map((o) => (
                <Pill
                    key={o.value}
                    active={value === o.value}
                    onClick={() => onChange(value === o.value ? null : o.value)}
                    label={o.label}
                />
            ))}
        </Box>
    )
}

function Pill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
    return (
        <Box
            component="button"
            onClick={onClick}
            sx={{
                px: 1,
                py: 0.35,
                fontSize: 11.5,
                fontFamily: 'var(--font-ui)',
                fontWeight: 600,
                borderRadius: '6px',
                border: '1px solid',
                borderColor: active ? 'var(--accent-line)' : 'var(--line)',
                bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--text-dim)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                '&:hover': { borderColor: active ? 'var(--accent-line)' : 'var(--muted)' },
            }}
        >
            {label}
        </Box>
    )
}
