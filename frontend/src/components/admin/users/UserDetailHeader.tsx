import { Box, Typography } from '@mui/material'
import { AlertTriangle, Mail } from 'lucide-react'
import { Link as RouterLink } from 'react-router-dom'
import type { AdminUserRecord, FlaggedUserRollup } from '../../../api/client'
import { Panel } from '../../home/Panel'
import RoleChip from './RoleChip'
import UserStatusChip from './UserStatusChip'
import { fmtDate, fmtRelative } from './shared'
import { initials, monogramColor } from '../../profile/shared'

/** The account hero: monogram + name + email, role/status chips, join date, and
 * (when flagged) a prominent deep link into the anti-cheat review page. */
export default function UserDetailHeader({
    user,
    rollup,
}: {
    user: AdminUserRecord
    rollup: FlaggedUserRollup | null
}) {
    return (
        <Panel>
            <Box
                sx={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 2,
                }}
            >
                <Box
                    sx={{
                        width: 56,
                        height: 56,
                        flexShrink: 0,
                        borderRadius: '14px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontFamily: 'var(--font-display)',
                        fontWeight: 700,
                        fontSize: 20,
                        color: '#16140f',
                        bgcolor: monogramColor(user.name),
                    }}
                >
                    {initials(user.name)}
                </Box>

                <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-display)',
                                fontSize: 24,
                                fontWeight: 700,
                                lineHeight: 1.1,
                            }}
                        >
                            {user.name}
                        </Typography>
                        <RoleChip role={user.role} />
                        <UserStatusChip active={user.active} />
                    </Box>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 2,
                            mt: 0.75,
                            flexWrap: 'wrap',
                        }}
                    >
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            <Mail size={13} color="var(--muted)" />
                            <Typography sx={{ fontSize: 13, color: 'var(--text-dim)' }}>
                                {user.email}
                            </Typography>
                        </Box>
                        <Typography
                            sx={{ fontSize: 12.5, color: 'var(--muted)' }}
                            title={fmtDate(user.created_at)}
                        >
                            Joined {fmtDate(user.created_at)} · {fmtRelative(user.created_at)}
                        </Typography>
                    </Box>
                </Box>

                {rollup && (
                    <Box
                        component={RouterLink}
                        to={`/admin/anticheat/${encodeURIComponent(user.id)}`}
                        sx={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 0.75,
                            px: 1.4,
                            py: 0.9,
                            borderRadius: '10px',
                            textDecoration: 'none',
                            fontSize: 13,
                            fontWeight: 700,
                            color: '#ca4a4a',
                            bgcolor: 'rgba(202, 74, 74, 0.12)',
                            border: '1px solid rgba(202, 74, 74, 0.45)',
                            transition: 'background .12s ease',
                            '&:hover': { bgcolor: 'rgba(202, 74, 74, 0.2)' },
                        }}
                    >
                        <AlertTriangle size={15} />
                        Flagged — review {rollup.total_flags} event
                        {rollup.total_flags === 1 ? '' : 's'}
                    </Box>
                )}
            </Box>
        </Panel>
    )
}
