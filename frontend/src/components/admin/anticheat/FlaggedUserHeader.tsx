import { Box, Typography } from '@mui/material'
import { Link } from 'react-router-dom'
import { ExternalLink, Flag, ShieldAlert, UserCog } from 'lucide-react'
import type { FlaggedUserDetail } from '../../../api/client'
import { fmtDate } from '../../profile/shared'
import { Panel } from '../../home/Panel'
import StatusChip from './StatusChip'
import SeverityChip from './SeverityChip'

/** The flagged-user hero: name, current verdict + top severity, headline flag
 * count, first/last-flagged window, and jump links to the public profile and the
 * full admin account record. */
export default function FlaggedUserHeader({ detail }: { detail: FlaggedUserDetail }) {
    return (
        <Panel>
            <Box
                sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 2,
                }}
            >
                <Box sx={{ minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
                        <ShieldAlert size={20} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontSize: 24,
                                fontWeight: 700,
                                color: 'var(--text)',
                                lineHeight: 1.1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                            }}
                        >
                            {detail.user_name}
                        </Typography>
                    </Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                        <StatusChip status={detail.status} />
                        <SeverityChip severity={detail.top_severity} />
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 0.5 }}>
                            <Flag size={13} style={{ color: 'var(--muted)' }} />
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 13,
                                    fontWeight: 700,
                                    color: 'var(--text)',
                                }}
                            >
                                {detail.total_flags}
                            </Typography>
                            <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>
                                flag{detail.total_flags === 1 ? '' : 's'}
                            </Typography>
                        </Box>
                    </Box>
                </Box>

                <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                    <JumpLink
                        to={`/admin/users/${detail.user_id}`}
                        icon={<UserCog size={14} />}
                        label="Account"
                    />
                    <JumpLink
                        to={`/@/${encodeURIComponent(detail.user_name)}`}
                        icon={<ExternalLink size={14} />}
                        label="Profile"
                    />
                </Box>
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 1,
                    mt: 2,
                    maxWidth: 380,
                }}
            >
                <Stat label="First flagged" value={fmtDate(detail.first_flagged_at)} />
                <Stat label="Last flagged" value={fmtDate(detail.last_flagged_at)} />
            </Box>
        </Panel>
    )
}

function JumpLink({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
    return (
        <Box
            component={Link}
            to={to}
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.625,
                px: 1.25,
                py: 0.75,
                borderRadius: 'var(--radius)',
                textDecoration: 'none',
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                color: 'var(--text-dim)',
                fontSize: 12,
                fontWeight: 600,
                '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
            }}
        >
            {icon}
            {label}
        </Box>
    )
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                px: 1.25,
                py: 0.875,
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
            <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', mt: 0.25 }}>
                {value || '—'}
            </Typography>
        </Box>
    )
}
