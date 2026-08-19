// The analysis board's local (in-browser) engine control: capability
// messaging, the on/off toggle, and the first-enable download readout — all
// as one compact control meant to sit in EngineLines's header, next to the
// depth indicator. Deliberately text-first and small (matches the existing
// "depth" readout right next to it) rather than a card or a dialog — Super
// KISS, no new visual language.
import { Box, Tooltip, Typography } from '@mui/material'
import type { DownloadState } from '../lib/engine/downloadState'
import { formatDownloadProgress } from '../lib/engine/downloadState'
import { LOCAL_ENGINE_NET_SIZE_MB } from '../lib/engine/config'
import type { EngineCapability } from '../lib/engine/useLocalEngineRace'

export interface LocalEngineControlProps {
    capability: EngineCapability
    enabled: boolean
    onToggle: () => void
    download: DownloadState
    onRetry: () => void
}

const pillSx = {
    fontFamily: 'var(--font-display)',
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
    color: 'var(--text-dim)',
    bgcolor: 'transparent',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    px: 0.7,
    py: '2px',
    cursor: 'pointer',
    // This control shares EngineLines's header flex row with the engine toggle,
    // the Cloud chip and the depth readout. Letting it shrink or wrap squeezes
    // its neighbours — which is how the engine toggle's knob ended up outside
    // its own track.
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
    transition: 'color .12s, background-color .12s, border-color .12s',
    '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
}

export default function LocalEngineControl({ capability, enabled, onToggle, download, onRetry }: LocalEngineControlProps) {
    // Capability missing: explain briefly rather than just omitting the
    // toggle silently — the task's explicit requirement.
    if (!capability.available) {
        return (
            <Tooltip title={capability.reason ?? 'Local engine unavailable in this browser'} arrow placement="top">
                <Typography
                    sx={{
                        fontSize: 10.5,
                        letterSpacing: 0.3,
                        color: 'var(--muted)',
                        cursor: 'default',
                    }}
                >
                    Local engine unavailable
                </Typography>
            </Tooltip>
        )
    }

    if (download.status === 'error') {
        return (
            <Tooltip title={download.message} arrow placement="top">
                <Box
                    component="button"
                    onClick={onRetry}
                    sx={{
                        ...pillSx,
                        color: '#ca4a4a',
                        borderColor: 'color-mix(in srgb, #ca4a4a 45%, transparent)',
                        '&:hover': { color: '#ca4a4a', borderColor: '#ca4a4a' },
                    }}
                >
                    Local engine failed — Retry
                </Box>
            </Tooltip>
        )
    }

    if (enabled && (download.status === 'checking' || download.status === 'downloading')) {
        const label =
            download.status === 'checking'
                ? 'Checking local engine…'
                : formatDownloadProgress(download.loaded, download.total, LOCAL_ENGINE_NET_SIZE_MB.wire)
        return (
            <Typography
                sx={{
                    fontSize: 10.5,
                    letterSpacing: 0.2,
                    color: 'var(--text-dim)',
                    fontFamily: 'var(--font-mono)',
                }}
            >
                {label}
            </Typography>
        )
    }

    return (
        <Tooltip
            title={
                enabled
                    ? 'Turn off the local (in-browser) engine'
                    : `Run the engine locally in your browser (~${LOCAL_ENGINE_NET_SIZE_MB.wire}MB download, kept on this device)`
            }
            arrow
            placement="top"
        >
            <Box
                component="button"
                onClick={onToggle}
                aria-pressed={enabled}
                sx={{
                    ...pillSx,
                    ...(enabled
                        ? { color: 'var(--accent)', borderColor: 'var(--accent-line)', bgcolor: 'var(--accent-soft)' }
                        : {}),
                }}
            >
                Local
            </Box>
        </Tooltip>
    )
}
