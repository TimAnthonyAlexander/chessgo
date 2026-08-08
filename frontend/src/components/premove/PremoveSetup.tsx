import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'
import { Infinity as InfinityIcon, Play, Timer, Zap } from 'lucide-react'
import { ActionBtn, ErrorBanner } from '../PanelUI'
import type { PremoveFormat } from '../../api/client'
import { Card, Label } from './PremoveUI'

/** Desktop-only left rail on the format-picker screen. */
export function SetupAside({ bestStreak }: { bestStreak: number }) {
    return (
        <Card sx={{ p: 2.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
                <Box
                    sx={{
                        width: 34,
                        height: 34,
                        borderRadius: '10px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        bgcolor: 'var(--accent-soft)',
                        border: '1px solid var(--accent-line)',
                        color: 'var(--accent)',
                    }}
                >
                    <Zap size={18} />
                </Box>
                <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}>
                    Premove Trainer
                </Typography>
            </Box>

            <Typography sx={{ fontSize: 13, color: 'var(--muted)', mt: 1.25, lineHeight: 1.5 }}>
                You're handed a forced mate. Queue the whole line blind, release it, and watch it
                play out. No feedback between moves — either you mated them or you didn't.
            </Typography>

            <Box sx={{ borderTop: '1px solid var(--line-soft)', mt: 2.25, pt: 2.25 }}>
                <Label>Best streak</Label>
                <Typography
                    sx={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, lineHeight: 1 }}
                >
                    {bestStreak}
                </Typography>
            </Box>
        </Card>
    )
}

export function SetupCard({
    format,
    creating,
    error,
    onFormat,
    onStart,
}: {
    format: PremoveFormat
    creating: boolean
    error: string | null
    onFormat: (f: PremoveFormat) => void
    onStart: () => void
}) {
    return (
        <Card sx={{ overflow: 'hidden' }}>
            <Box
                sx={{
                    px: 2.25,
                    py: 1.75,
                    borderBottom: '1px solid var(--line-soft)',
                }}
            >
                <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20 }}>
                    New attempt
                </Typography>
            </Box>

            <Box sx={{ px: 2.25, py: 2.25 }}>
                <Label>Format</Label>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    <FormatTile
                        active={format === 'rated'}
                        icon={<Timer size={19} />}
                        title="Rated"
                        subtitle="10s clock"
                        onClick={() => onFormat('rated')}
                    />
                    <FormatTile
                        active={format === 'casual'}
                        icon={<InfinityIcon size={19} />}
                        title="Casual"
                        subtitle="One shot"
                        onClick={() => onFormat('casual')}
                    />
                </Box>
                <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 1.5, lineHeight: 1.5 }}>
                    {format === 'rated'
                        ? 'A real 15-second clock runs while you queue. Releasing costs nothing — a queued premove stops your clock. If the chain breaks you keep going, clock running.'
                        : 'No clock, no rating. Queue the forced mate, release, see it play.'}
                </Typography>
            </Box>

            <Box sx={{ px: 2.25, pb: 2.25, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                <ActionBtn
                    tone="primary"
                    large
                    icon={<Play size={17} />}
                    label={creating ? 'Starting…' : 'Start'}
                    onClick={onStart}
                    disabled={creating}
                />
                {error && <ErrorBanner sx={{ mx: 0 }}>{error}</ErrorBanner>}
            </Box>
        </Card>
    )
}

function FormatTile({
    active,
    icon,
    title,
    subtitle,
    onClick,
}: {
    active: boolean
    icon: ReactNode
    title: string
    subtitle: string
    onClick: () => void
}) {
    return (
        <Box
            component="button"
            onClick={onClick}
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.35,
                py: 1.4,
                cursor: 'pointer',
                borderRadius: '12px',
                transition: 'background .15s, color .15s, border-color .15s',
                color: active ? 'var(--accent)' : 'var(--text)',
                bgcolor: active ? 'var(--accent-soft)' : 'var(--surface-2)',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
                '&:hover': { borderColor: 'var(--accent-line)' },
                '&:active': { transform: 'translateY(1px)' },
            }}
        >
            {icon}
            <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 15 }}>
                {title}
            </Typography>
            <Typography sx={{ fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)' }}>
                {subtitle}
            </Typography>
        </Box>
    )
}
