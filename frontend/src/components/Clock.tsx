import { Box } from '@mui/material'

interface ClockProps {
  ms: number
  active: boolean
  low?: boolean
}

function format(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 100) / 10) // tenths
  const mins = Math.floor(total / 60)
  const secs = total - mins * 60
  if (mins === 0 && ms < 10_000) {
    // Under 10s: show tenths (e.g. 7.3)
    return secs.toFixed(1)
  }
  return `${mins}:${Math.floor(secs).toString().padStart(2, '0')}`
}

/** A chess clock cell: monospace time, brightened + accented when running. */
export default function Clock({ ms, active, low }: ClockProps) {
  const urgent = ms < 10_000
  return (
    <Box
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: 26,
        fontWeight: 600,
        letterSpacing: '0.02em',
        px: 1.75,
        py: 0.75,
        borderRadius: 1.5,
        minWidth: 96,
        textAlign: 'center',
        color: active ? (urgent ? '#e9c46a' : 'var(--text)') : 'var(--text-dim)',
        bgcolor: active ? 'var(--surface-2)' : 'transparent',
        border: '1px solid',
        borderColor: active ? (urgent ? 'rgba(202,74,74,0.6)' : 'var(--accent-line)') : 'transparent',
        transition: 'color 0.15s ease, background 0.15s ease, border-color 0.15s ease',
        ...(low && active ? { color: '#e07a5f' } : {}),
      }}
    >
      {format(ms)}
    </Box>
  )
}
