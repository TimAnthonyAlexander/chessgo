import { Box, TableCell, TableRow, Typography } from '@mui/material'
import { useNavigate, Link as RouterLink } from 'react-router-dom'
import type { AdminUserRow } from '../../../api/client'
import RoleChip from './RoleChip'
import UserStatusChip from './UserStatusChip'
import FlagBadge from './FlagBadge'
import TitleBadge from '../../TitleBadge'
import { fmtDate, gamesOf, ratingOf, RATING_COLS } from './shared'

/** One directory row. The whole row navigates to the account detail; nested
 * links (name, flag badge) stop propagation so they can target their own route. */
export default function UserRow({ user }: { user: AdminUserRow }) {
    const navigate = useNavigate()
    const to = `/admin/users/${encodeURIComponent(user.id)}`

    return (
        <TableRow
            hover
            onClick={() => navigate(to)}
            sx={{
                cursor: 'pointer',
                '&:last-child td': { borderBottom: 'none' },
                '& td': { borderColor: 'var(--line-soft)' },
                '&:hover': { bgcolor: 'var(--line)' },
            }}
        >
            <TableCell>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                    <TitleBadge title={user.title} />
                    <Box
                        component={RouterLink}
                        to={to}
                        onClick={(e) => e.stopPropagation()}
                        sx={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: 'var(--text)',
                            textDecoration: 'none',
                            '&:hover': { color: 'var(--accent)' },
                        }}
                    >
                        {user.name}
                    </Box>
                </Box>
            </TableCell>

            <TableCell>
                <Typography
                    sx={{
                        fontSize: 12.5,
                        color: 'var(--text-dim)',
                        maxWidth: 200,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                    title={user.email}
                >
                    {user.email}
                </Typography>
            </TableCell>

            <TableCell>
                <RoleChip role={user.role} />
            </TableCell>

            <TableCell>
                <UserStatusChip active={user.active} />
            </TableCell>

            {RATING_COLS.map((c) => (
                <TableCell key={c.key} align="right">
                    <RatingCell rating={ratingOf(user, c.key)} games={gamesOf(user, c.key)} />
                </TableCell>
            ))}

            <TableCell>
                {user.flagged ? (
                    <FlagBadge
                        userId={user.id}
                        totalFlags={user.total_flags}
                        status={user.flag_status}
                        onClick={(e) => e.stopPropagation()}
                    />
                ) : (
                    <Box component="span" sx={{ color: 'var(--muted)' }}>
                        —
                    </Box>
                )}
            </TableCell>

            <TableCell align="right">
                <Typography sx={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    {fmtDate(user.created_at)}
                </Typography>
            </TableCell>
        </TableRow>
    )
}

function RatingCell({ rating, games }: { rating: number; games: number }) {
    const played = games > 0
    return (
        <Box sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.5, whiteSpace: 'nowrap' }}>
            <Typography
                component="span"
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    fontWeight: 700,
                    color: played ? 'var(--text)' : 'var(--muted)',
                }}
            >
                {rating}
            </Typography>
            <Typography
                component="span"
                sx={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)' }}
            >
                · {games}g
            </Typography>
        </Box>
    )
}
