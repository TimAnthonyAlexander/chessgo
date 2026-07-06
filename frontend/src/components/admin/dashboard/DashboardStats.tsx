import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Ban, Flag, Gamepad2, Star, UserCheck, UserPlus, Users } from 'lucide-react'
import type { AdminDashboard } from '../../../api/client'

/** The headline KPI row: users (total/active/banned/new) + games (total/rated) +
 * flagged users. Mirrors the home rating-card idiom — surface tile, mono number,
 * uppercase micro-label — so the admin dashboard reads as the same system. */
export default function DashboardStats({ data }: { data: AdminDashboard }) {
    const { users, games, anticheat } = data
    return (
        <Box
            sx={{
                display: 'grid',
                gap: 1.25,
                gridTemplateColumns: {
                    xs: 'repeat(2, 1fr)',
                    sm: 'repeat(3, 1fr)',
                    md: 'repeat(4, 1fr)',
                },
            }}
        >
            <StatTile
                icon={<Users size={14} />}
                label="Users"
                value={users.total}
                sub={`${users.admins} admin${users.admins === 1 ? '' : 's'}`}
            />
            <StatTile
                icon={<UserCheck size={14} />}
                label="Active"
                value={users.active}
                color="#5b9e5b"
            />
            <StatTile icon={<Ban size={14} />} label="Banned" value={users.banned} color="#ca4a4a" />
            <StatTile
                icon={<UserPlus size={14} />}
                label="New (7d)"
                value={users.new_7d}
                color="var(--accent)"
            />
            <StatTile icon={<Gamepad2 size={14} />} label="Games" value={games.total} />
            <StatTile
                icon={<Star size={14} />}
                label="Rated"
                value={games.rated}
                sub={games.total > 0 ? `${Math.round((games.rated / games.total) * 100)}%` : '—'}
            />
            <StatTile
                icon={<Flag size={14} />}
                label="Flagged"
                value={anticheat.flagged_users_total}
                color="#ca4a4a"
                sub={`${anticheat.flag_events_total} event${anticheat.flag_events_total === 1 ? '' : 's'}`}
            />
        </Box>
    )
}

function StatTile({
    icon,
    label,
    value,
    sub,
    color = 'var(--text-dim)',
}: {
    icon: ReactNode
    label: string
    value: number
    sub?: string
    color?: string
}) {
    return (
        <Box
            sx={{
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                p: 1.5,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color }}>
                {icon}
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {label}
                </Typography>
            </Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 24,
                    fontWeight: 600,
                    color: 'var(--text)',
                    mt: 1,
                    lineHeight: 1,
                }}
            >
                {value.toLocaleString()}
            </Typography>
            {sub && (
                <Typography sx={{ fontSize: 12, color: 'var(--muted)', mt: 0.5 }}>{sub}</Typography>
            )}
        </Box>
    )
}
