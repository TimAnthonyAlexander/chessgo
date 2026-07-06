import { Box, Typography } from '@mui/material'
import type { FlagEvent } from '../../../api/client'
import { fmtMs, fmtNum, fmtPct, metaBool, metaNum, metaStr } from './shared'
import MetaField from './MetaField'
import ExactMatchBoards from './ExactMatchBoards'

const RED = '#ca4a4a'
const AMBER = '#e0a33e'

/** Renders a flag event's `meta` bag with a per-category layout — each signal's
 * numbers laid out exactly as the detector measured them, so an admin sees the
 * same evidence that raised the flag. Unknown categories fall back to a raw dump. */
export default function MetaRenderer({ event }: { event: FlagEvent }) {
    const { category, meta } = event

    if (category === 'analysis_during_game') {
        return <ExactMatchBoards meta={meta} />
    }

    return (
        <Box
            sx={{
                display: 'grid',
                gap: 1,
                gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
            }}
        >
            {fields(category, meta)}
        </Box>
    )
}

function fields(category: string, meta: Record<string, unknown>) {
    switch (category) {
        case 'rating_velocity': {
            const gap = metaNum(meta, 'gap')
            const prov = metaBool(meta, 'provisional')
            return (
                <>
                    <MetaField label="Category" value={metaStr(meta, 'category') ?? '—'} />
                    <MetaField label="Rating before" value={fmtNum(metaNum(meta, 'rating_before'), 0)} />
                    <MetaField label="Opponent" value={fmtNum(metaNum(meta, 'opp_rating'), 0)} />
                    <MetaField
                        label="Rating gap"
                        value={`+${fmtNum(gap, 0)}`}
                        accent={gap != null && gap >= 300 ? RED : AMBER}
                        hint="beaten opponent above own rating"
                    />
                    <MetaField
                        label="Provisional"
                        value={prov == null ? '—' : prov ? 'yes' : 'no'}
                        accent={prov ? AMBER : undefined}
                    />
                </>
            )
        }
        case 'move_time_anomaly': {
            const cv = metaNum(meta, 'cv')
            return (
                <>
                    <MetaField label="Moves sampled" value={fmtNum(metaNum(meta, 'moves'), 0)} />
                    <MetaField
                        label="Time CV"
                        value={fmtNum(cv, 3)}
                        accent={cv != null && cv < 0.3 ? RED : undefined}
                        hint="low = robotic timing"
                    />
                    <MetaField label="Mean move time" value={fmtMs(metaNum(meta, 'mean_ms'))} />
                </>
            )
        }
        case 'engine_correlation': {
            const acpl = metaNum(meta, 'acpl')
            const expected = metaNum(meta, 'expected_acpl')
            const t1 = metaNum(meta, 't1_match')
            const better = acpl != null && expected != null && acpl < expected
            return (
                <>
                    <MetaField label="Rating" value={fmtNum(metaNum(meta, 'rating'), 0)} />
                    <MetaField
                        label="ACPL"
                        value={fmtNum(acpl, 1)}
                        accent={better ? RED : undefined}
                        hint={`expected ${fmtNum(expected, 1)}`}
                    />
                    <MetaField
                        label="Top-1 match"
                        value={fmtPct(t1)}
                        accent={t1 != null && (t1 <= 1 ? t1 : t1 / 100) >= 0.6 ? RED : undefined}
                        hint="moves matching engine best"
                    />
                    <MetaField label="Own moves" value={fmtNum(metaNum(meta, 'own_moves'), 0)} />
                </>
            )
        }
        case 'accuracy_rating_mismatch': {
            const acc = metaNum(meta, 'accuracy')
            const expected = metaNum(meta, 'expected_accuracy')
            const gap = metaNum(meta, 'gap')
            return (
                <>
                    <MetaField label="Rating" value={fmtNum(metaNum(meta, 'rating'), 0)} />
                    <MetaField
                        label="Accuracy"
                        value={fmtPct(acc)}
                        accent={RED}
                        hint={`expected ${fmtPct(expected)}`}
                    />
                    <MetaField
                        label="Accuracy gap"
                        value={`+${fmtNum(gap, 1)}`}
                        accent={gap != null && gap >= 15 ? RED : AMBER}
                    />
                    <MetaField label="Own moves" value={fmtNum(metaNum(meta, 'own_moves'), 0)} />
                </>
            )
        }
        default:
            return <RawMeta meta={meta} />
    }
}

/** Fallback for an unrecognised category: a plain key/value dump so no evidence
 * is ever hidden even if a new signal ships before this UI knows its shape. */
function RawMeta({ meta }: { meta: Record<string, unknown> }) {
    const entries = Object.entries(meta)
    if (entries.length === 0) {
        return (
            <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', gridColumn: '1 / -1' }}>
                No additional detail.
            </Typography>
        )
    }
    return (
        <>
            {entries.map(([k, v]) => (
                <MetaField key={k} label={k} value={String(v)} />
            ))}
        </>
    )
}
