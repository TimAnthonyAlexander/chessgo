import { Box, Typography } from '@mui/material'
import type { AcSideSummary, FlagEvent, GameSummaryRow } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { fmtMs, fmtNum, fmtPct, metaNum } from './shared'

const RED = '#ca4a4a'

interface Bundle {
    acpl: number | null
    expectedAcpl: number | null
    accuracy: number | null
    expectedAccuracy: number | null
    t1: number | null
    cv: number | null
    meanMs: number | null
    color: 'w' | 'b' | null
}

/** Distil the flagged-side metrics straight from the flag meta (so the numbers
 * match exactly what raised the flag), scanning every flag for the relevant keys
 * and noting which side is flagged via the game's per-colour user ids. */
function distil(flags: FlagEvent[], game: GameSummaryRow): Bundle {
    const b: Bundle = {
        acpl: null,
        expectedAcpl: null,
        accuracy: null,
        expectedAccuracy: null,
        t1: null,
        cv: null,
        meanMs: null,
        color: null,
    }
    for (const f of flags) {
        const m = f.meta
        b.acpl ??= metaNum(m, 'acpl')
        b.expectedAcpl ??= metaNum(m, 'expected_acpl')
        b.accuracy ??= metaNum(m, 'accuracy')
        b.expectedAccuracy ??= metaNum(m, 'expected_accuracy')
        b.t1 ??= metaNum(m, 't1_match')
        b.cv ??= metaNum(m, 'cv')
        b.meanMs ??= metaNum(m, 'mean_ms')
        if (b.color == null && f.user_id) {
            if (f.user_id === game.white_user_id) b.color = 'w'
            else if (f.user_id === game.black_user_id) b.color = 'b'
        }
    }
    return b
}

/** Headline metrics for the flagged side of a game, sourced from the flag meta and
 * backfilled from the cached analysis summary (ACPL / accuracy) when a game was
 * scanned but carries no such flag. */
export default function AcStatTiles({
    flags,
    summary,
    game,
}: {
    flags: FlagEvent[]
    summary: { w: AcSideSummary; b: AcSideSummary } | null
    game: GameSummaryRow
}) {
    const b = distil(flags, game)
    const side = b.color ? summary?.[b.color] ?? null : null

    const acpl = b.acpl ?? side?.acpl ?? null
    const accuracy = b.accuracy ?? side?.accuracy ?? null

    const flaggedLabel =
        b.color === 'w'
            ? `White · ${game.white_name}`
            : b.color === 'b'
              ? `Black · ${game.black_name}`
              : 'flagged side'

    const t1Frac = b.t1 == null ? null : b.t1 <= 1 ? b.t1 : b.t1 / 100

    return (
        <Panel>
            <PanelHead
                title="Flagged-side metrics"
                sub={`Signals measured for ${flaggedLabel}`}
            />
            <Box
                sx={{
                    display: 'grid',
                    gap: 1,
                    gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' },
                }}
            >
                <Tile
                    label="ACPL"
                    value={fmtNum(acpl, 1)}
                    hint={b.expectedAcpl != null ? `expected ${fmtNum(b.expectedAcpl, 1)}` : undefined}
                    accent={
                        acpl != null && b.expectedAcpl != null && acpl < b.expectedAcpl
                            ? RED
                            : undefined
                    }
                />
                <Tile
                    label="Accuracy"
                    value={fmtPct(accuracy)}
                    hint={
                        b.expectedAccuracy != null
                            ? `expected ${fmtPct(b.expectedAccuracy)}`
                            : undefined
                    }
                    accent={
                        accuracy != null &&
                        b.expectedAccuracy != null &&
                        (accuracy <= 1 ? accuracy * 100 : accuracy) >
                            (b.expectedAccuracy <= 1 ? b.expectedAccuracy * 100 : b.expectedAccuracy)
                            ? RED
                            : undefined
                    }
                />
                <Tile
                    label="Top-1 match"
                    value={fmtPct(b.t1)}
                    hint="engine best moves"
                    accent={t1Frac != null && t1Frac >= 0.6 ? RED : undefined}
                />
                <Tile
                    label="Move-time CV"
                    value={fmtNum(b.cv, 3)}
                    hint={b.meanMs != null ? `mean ${fmtMs(b.meanMs)}` : undefined}
                    accent={b.cv != null && b.cv < 0.3 ? RED : undefined}
                />
            </Box>
        </Panel>
    )
}

function Tile({
    label,
    value,
    hint,
    accent,
}: {
    label: string
    value: string
    hint?: string
    accent?: string
}) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: '10px',
                px: 1.25,
                py: 1.125,
            }}
        >
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9.5,
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                }}
            >
                {label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 20,
                    fontWeight: 700,
                    color: accent ?? 'var(--text)',
                    mt: 0.375,
                    lineHeight: 1,
                }}
            >
                {value}
            </Typography>
            {hint && (
                <Typography sx={{ fontSize: 10.5, color: 'var(--muted)', mt: 0.5 }}>
                    {hint}
                </Typography>
            )}
        </Box>
    )
}
