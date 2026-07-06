import { Box, Typography } from '@mui/material'
import type { ReactNode } from 'react'
import { Swords, Users } from 'lucide-react'
import type { AdminDashboard } from '../../../api/client'
import { Panel, PanelHead } from '../../home/Panel'

/** The live lobby snapshot from the realtime hub: players online + games in play.
 * Degrades gracefully to zeros when the hub is unreachable (backend contract). */
export default function LiveStatsCard({ data }: { data: AdminDashboard['live'] }) {
    return (
        <Panel>
            <PanelHead
                title="Live now"
                action={
                    <Box
                        sx={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            bgcolor: 'var(--live)',
                            boxShadow: '0 0 0 3px rgba(123, 182, 97, 0.18)',
                            mt: 0.75,
                        }}
                    />
                }
            />
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <LiveRow
                    icon={<Users size={16} />}
                    label="Players online"
                    value={data.players_online}
                />
                <LiveRow
                    icon={<Swords size={16} />}
                    label="Active games"
                    value={data.active_games}
                />
            </Box>
        </Panel>
    )
}

function LiveRow({ icon, label, value }: { icon: ReactNode; label: string; value: number }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                px: 1.25,
                py: 1,
                borderRadius: '10px',
                bgcolor: 'var(--surface-2)',
            }}
        >
            <Box sx={{ display: 'flex', color: 'var(--live)', flexShrink: 0 }}>{icon}</Box>
            <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)', flex: 1, minWidth: 0 }}>
                {label}
            </Typography>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 20,
                    fontWeight: 700,
                    lineHeight: 1,
                    color: 'var(--text)',
                }}
            >
                {value.toLocaleString()}
            </Typography>
        </Box>
    )
}
