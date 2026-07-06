import { useState } from 'react'
import { Box, Checkbox, CircularProgress, Tooltip, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { ChevronRight, ExternalLink } from 'lucide-react'
import type { FlagEvent } from '../../../api/client'
import { fmtDate } from '../../profile/shared'
import { CATEGORY_META, categoryLabel, metaGameId } from './shared'
import SeverityChip from './SeverityChip'
import MetaRenderer from './MetaRenderer'

/** One row of the per-user event timeline: severity, signal, the human detail,
 * timestamp, and a reviewed checkbox. Expands to reveal the per-category evidence
 * (`MetaRenderer`) and a link to the tied game when the flag carries one. */
export default function FlagEventRow({
    event,
    busy,
    onToggleReviewed,
}: {
    event: FlagEvent
    busy: boolean
    onToggleReviewed: (next: boolean) => void
}) {
    const [open, setOpen] = useState(false)
    const gameId = metaGameId(event.meta)
    const { icon: Icon, color } = CATEGORY_META[event.category as keyof typeof CATEGORY_META] ?? {
        icon: ChevronRight,
        color: 'var(--muted)',
    }

    return (
        <Box
            sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '10px',
                bgcolor: event.reviewed ? 'var(--bg-2)' : 'var(--surface)',
                overflow: 'hidden',
                transition: 'background .12s ease',
            }}
        >
            {/* Header row */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1.25,
                    py: 1,
                    cursor: 'pointer',
                    opacity: event.reviewed ? 0.72 : 1,
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.025)' },
                }}
                onClick={() => setOpen((v) => !v)}
            >
                <Box
                    sx={{
                        display: 'flex',
                        color: 'var(--muted)',
                        transform: open ? 'rotate(90deg)' : 'none',
                        transition: 'transform .12s ease',
                    }}
                >
                    <ChevronRight size={16} />
                </Box>

                <Box sx={{ display: 'flex', alignItems: 'center', color, flexShrink: 0 }}>
                    <Icon size={16} />
                </Box>

                <SeverityChip severity={event.severity} dense />

                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography
                        sx={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: 'var(--text)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {categoryLabel(event.category)}
                    </Typography>
                    <Typography
                        sx={{
                            fontSize: 12,
                            color: 'var(--text-dim)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        {event.detail}
                    </Typography>
                </Box>

                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--muted)',
                        flexShrink: 0,
                        display: { xs: 'none', sm: 'block' },
                    }}
                >
                    {fmtDate(event.created_at)}
                </Typography>

                {/* Reviewed toggle — stop the click from also toggling the expander. */}
                <Box
                    sx={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                >
                    {busy ? (
                        <CircularProgress size={16} sx={{ color: 'var(--accent)', mx: 1 }} />
                    ) : (
                        <Tooltip arrow title={event.reviewed ? 'Reviewed' : 'Mark reviewed'}>
                            <Checkbox
                                size="small"
                                checked={event.reviewed}
                                onChange={(e) => onToggleReviewed(e.target.checked)}
                                sx={{
                                    color: 'var(--muted)',
                                    '&.Mui-checked': { color: '#5b9e5b' },
                                }}
                            />
                        </Tooltip>
                    )}
                </Box>
            </Box>

            {/* Expanded evidence */}
            {open && (
                <Box
                    sx={{
                        px: 1.5,
                        py: 1.5,
                        borderTop: '1px solid var(--line-soft)',
                        bgcolor: 'var(--bg-2)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1.25,
                    }}
                >
                    <MetaRenderer event={event} />
                    {gameId && (
                        <Box
                            component={Link}
                            to={`/admin/anticheat/game/${gameId}`}
                            sx={{
                                display: 'inline-flex',
                                alignSelf: 'flex-start',
                                alignItems: 'center',
                                gap: 0.625,
                                px: 1.25,
                                py: 0.625,
                                borderRadius: '8px',
                                textDecoration: 'none',
                                bgcolor: 'var(--accent-soft)',
                                border: '1px solid var(--accent-line)',
                                color: 'var(--accent)',
                                fontSize: 12,
                                fontWeight: 700,
                                '&:hover': { bgcolor: 'var(--accent-soft-strong)' },
                            }}
                        >
                            <ExternalLink size={13} />
                            Open game
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    )
}
