import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import type { FlagEvent } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'
import { fmtDate } from '../../profile/shared'
import { CATEGORY_META, categoryLabel } from './shared'
import SeverityChip from './SeverityChip'

/** The flags tied to this game, compact — each links back to the flagged user's
 * review. `user_id` is present on the per-game endpoint's events. */
export default function GameFlagList({ flags }: { flags: FlagEvent[] }) {
    return (
        <Panel>
            <PanelHead
                title="Flags on this game"
                sub={`${flags.length} event${flags.length === 1 ? '' : 's'} tied to this game`}
            />
            {flags.length === 0 ? (
                <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                    No flag events reference this game.
                </Typography>
            ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                    {flags.map((f) => {
                        const { icon: Icon, color } = CATEGORY_META[
                            f.category as keyof typeof CATEGORY_META
                        ] ?? { icon: ChevronRight, color: 'var(--muted)' }
                        const row = (
                            <Box
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1,
                                    px: 1.25,
                                    py: 1,
                                    borderRadius: 'var(--radius)',
                                    bgcolor: 'var(--surface-2)',
                                    border: '1px solid var(--line-soft)',
                                    textDecoration: 'none',
                                    transition: 'border-color .1s ease',
                                    '&:hover': f.user_id
                                        ? { borderColor: 'var(--accent-line)' }
                                        : undefined,
                                }}
                            >
                                <Box sx={{ display: 'flex', color, flexShrink: 0 }}>
                                    <Icon size={16} />
                                </Box>
                                <SeverityChip severity={f.severity} dense />
                                <Box sx={{ minWidth: 0, flex: 1 }}>
                                    <Typography
                                        sx={{
                                            fontSize: 12.5,
                                            fontWeight: 600,
                                            color: 'var(--text)',
                                        }}
                                    >
                                        {categoryLabel(f.category)}
                                    </Typography>
                                    <Typography
                                        sx={{
                                            fontSize: 11.5,
                                            color: 'var(--text-dim)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {f.detail}
                                    </Typography>
                                </Box>
                                <Typography
                                    sx={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 10.5,
                                        color: 'var(--muted)',
                                        flexShrink: 0,
                                        display: { xs: 'none', sm: 'block' },
                                    }}
                                >
                                    {fmtDate(f.created_at)}
                                </Typography>
                                {f.user_id && (
                                    <Box sx={{ display: 'flex', color: 'var(--muted)', flexShrink: 0 }}>
                                        <ChevronRight size={16} />
                                    </Box>
                                )}
                            </Box>
                        )
                        return f.user_id ? (
                            <Box
                                key={f.id}
                                component={Link}
                                to={`/admin/anticheat/${f.user_id}`}
                                sx={{ textDecoration: 'none' }}
                            >
                                {row}
                            </Box>
                        ) : (
                            <Box key={f.id}>{row}</Box>
                        )
                    })}
                </Box>
            )}
        </Panel>
    )
}
