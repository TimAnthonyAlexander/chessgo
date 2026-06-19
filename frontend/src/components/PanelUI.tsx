import { type ReactNode } from 'react'
import { Box, Tooltip } from '@mui/material'

// Shared side-panel UI primitives, so the bot / live / analysis panels look and
// behave identically. Apple-esque: rounded, restrained, gold accent.

/** Card shadow used by every side panel + aside card. */
export const PANEL_SHADOW = '0 18px 50px -28px rgba(0,0,0,0.8)'

/** Square avatar chip (player / opponent identity). */
export function Avatar({ small, children }: { small?: boolean; children: ReactNode }) {
  const d = small ? 26 : 34
  return (
    <Box
      sx={{
        width: d,
        height: d,
        flexShrink: 0,
        borderRadius: '9px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-dim)',
        bgcolor: 'var(--surface-2)',
        border: '1px solid var(--line)',
      }}
    >
      {children}
    </Box>
  )
}

/** Icon button for toolbars (navigation, flip, mute …). */
export function NavBtn({
  label,
  onClick,
  active,
  grow,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  grow?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip title={label} arrow>
      <Box
        component="button"
        onClick={onClick}
        aria-label={label}
        disabled={disabled}
        sx={{
          flex: grow ? 1 : 'none',
          width: grow ? 'auto' : 42,
          height: 42,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: disabled ? 'default' : 'pointer',
          border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
          borderRadius: '9px',
          color: active ? 'var(--accent)' : 'var(--text-dim)',
          bgcolor: active ? 'var(--accent-soft)' : 'transparent',
          transition: 'background-color .15s, color .15s, border-color .15s',
          '&:hover': { color: 'var(--accent)', bgcolor: active ? 'var(--accent-soft)' : 'var(--line)' },
          '&:active': { transform: 'translateY(1px)' },
          '&:disabled': { opacity: 0.4, pointerEvents: 'none' },
        }}
      >
        {children}
      </Box>
    </Tooltip>
  )
}

/** Primary (gold) / danger (red) / neutral text+icon action button. */
export function ActionBtn({
  tone,
  icon,
  label,
  onClick,
  large,
  disabled,
}: {
  tone: 'primary' | 'danger' | 'neutral'
  icon?: ReactNode
  label: string
  onClick: () => void
  large?: boolean
  disabled?: boolean
}) {
  const styles =
    tone === 'primary'
      ? {
          color: '#15171c',
          background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
          border: '1px solid var(--accent)',
          boxShadow: '0 0 18px -5px rgba(216,166,87,0.6)',
          hover: { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
        }
      : tone === 'danger'
        ? {
            color: '#e6a3a3',
            background: 'rgba(202, 74, 74, 0.10)',
            border: '1px solid rgba(202, 74, 74, 0.4)',
            boxShadow: 'none',
            hover: { background: 'rgba(202, 74, 74, 0.18)', color: '#f0b8b8' },
          }
        : {
            color: 'var(--text)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            boxShadow: 'none',
            hover: { background: 'var(--line)', color: 'var(--accent)' },
          }
  return (
    <Box
      component="button"
      onClick={onClick}
      disabled={disabled}
      sx={{
        flex: 1,
        height: large ? 50 : 44,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0.75,
        cursor: disabled ? 'default' : 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: large ? 15.5 : 14,
        fontWeight: 600,
        letterSpacing: 0.2,
        borderRadius: '11px',
        opacity: disabled ? 0.6 : 1,
        color: styles.color,
        background: styles.background,
        border: styles.border,
        boxShadow: styles.boxShadow,
        transition: 'background .15s, color .15s, border-color .15s, box-shadow .2s',
        '&:hover': disabled ? {} : styles.hover,
        '&:active': { transform: disabled ? 'none' : 'translateY(1px)' },
      }}
    >
      {icon}
      {label}
    </Box>
  )
}

/** Inline error banner shared by the panels. */
export function ErrorBanner({ children, sx }: { children: ReactNode; sx?: object }) {
  return (
    <Box
      sx={{
        m: 1.25,
        px: 1.5,
        py: 1,
        fontSize: 13,
        color: '#e6a3a3',
        bgcolor: 'rgba(202, 74, 74, 0.10)',
        border: '1px solid rgba(202, 74, 74, 0.4)',
        borderRadius: '10px',
        ...sx,
      }}
    >
      {children}
    </Box>
  )
}
