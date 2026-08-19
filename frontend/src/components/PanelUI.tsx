import { type ReactNode, useState } from 'react'
import { Box, Popover, Tooltip } from '@mui/material'
import { ChevronDown } from 'lucide-react'

// Shared side-panel UI primitives, so the bot / live / analysis panels look and
// behave identically. Square, flat, restrained, one accent.

/** Card elevation used by every side panel + aside card. Reads the site token
 *  (styles.css `--shadow`) rather than carrying its own value — the name is kept
 *  because a lot of panels import it. */
export const PANEL_SHADOW = 'var(--shadow)'

/** Square avatar chip (player / opponent identity). */
export function Avatar({ small, children }: { small?: boolean; children: ReactNode }) {
    const d = small ? 26 : 34
    return (
        <Box
            sx={{
                width: d,
                height: d,
                flexShrink: 0,
                borderRadius: 'var(--radius)',
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

/** Icon button for toolbars (navigation, flip, mute …). `small` (34px) suits
 *  compact header rows; the default 42px suits dedicated toolbars. */
export function NavBtn({
    label,
    onClick,
    active,
    grow,
    small,
    disabled,
    children,
}: {
    label: string
    onClick: () => void
    active?: boolean
    grow?: boolean
    small?: boolean
    disabled?: boolean
    children: ReactNode
}) {
    const d = small ? 34 : 42
    return (
        <Tooltip title={label} arrow>
            <Box
                component="button"
                onClick={onClick}
                aria-label={label}
                disabled={disabled}
                sx={{
                    flex: grow ? 1 : 'none',
                    width: grow ? 'auto' : d,
                    height: d,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: disabled ? 'default' : 'pointer',
                    border: active ? '1px solid var(--accent-line)' : '1px solid transparent',
                    borderRadius: 'var(--radius)',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    bgcolor: active ? 'var(--accent-soft)' : 'transparent',
                    transition: 'background-color .15s, color .15s, border-color .15s',
                    '&:hover': {
                        color: 'var(--accent)',
                        bgcolor: active ? 'var(--accent-soft)' : 'var(--line)',
                    },
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
                  color: 'var(--on-accent)',
                  background: 'var(--accent-fill)',
                  border: '1px solid var(--accent)',
                  boxShadow: 'none',
                  hover: { background: 'var(--accent-fill-hover)' },
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
                minWidth: 0,
                height: large ? 50 : 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0.75,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                cursor: disabled ? 'default' : 'pointer',
                fontFamily: 'var(--font-display)',
                fontSize: large ? 15.5 : 14,
                fontWeight: 600,
                letterSpacing: 0.2,
                borderRadius: 'var(--radius)',
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
            {/* The icon never shrinks — as a bare flex child it would be the thing
                that gives when the label is long, and a squashed icon reads as broken.
                The label ellipsises instead, which is the correct thing to lose. */}
            {icon && <Box sx={{ display: 'flex', flexShrink: 0 }}>{icon}</Box>}
            <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
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
                borderRadius: 'var(--radius)',
                ...sx,
            }}
        >
            {children}
        </Box>
    )
}

// --- Compact tool row -------------------------------------------------------
//
// A row of short, 32px-tall cells that a side panel can wear as a header strip.
// It exists because the side-rail layout gives a page ONE board-height column
// for what the centered layout splits across two, so a stack of full-width
// 44px action cards is unaffordable there: the cards push whatever fills the
// panel (a move list, a chat) out of the rail. A cell either acts (`ToolBtn`)
// or opens a popover holding the buttons it replaced (`ToolMenu`) — either way
// the row costs one line and nothing it opens moves the panel.

const CELL_SX = (on: boolean) => ({
    flex: 1,
    minWidth: 0,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0.6,
    cursor: 'pointer',
    fontFamily: 'var(--font-display)',
    fontSize: 12.5,
    fontWeight: 600,
    letterSpacing: 0.2,
    whiteSpace: 'nowrap',
    color: on ? 'var(--accent)' : 'var(--text)',
    bgcolor: on ? 'var(--accent-soft)' : 'var(--surface-2)',
    border: `1px solid ${on ? 'var(--accent-line)' : 'var(--line)'}`,
    borderRadius: '8px',
    transition: 'color .15s, background-color .15s, border-color .15s',
    '&:hover': {
        color: 'var(--accent)',
        bgcolor: 'var(--line)',
        borderColor: 'var(--accent-line)',
    },
    '&:disabled': {
        cursor: 'default',
        color: 'var(--muted)',
        bgcolor: 'var(--surface-2)',
        borderColor: 'var(--line)',
    },
})

/** A plain cell: one action, one click. `accent` marks the row's lead action —
 *  the accent outline, not a filled gold button, because at 32px in a header
 *  strip a solid primary shouts over the panel it heads. */
export function ToolBtn({
    icon,
    label,
    onClick,
    accent,
    disabled,
}: {
    icon?: ReactNode
    label: string
    onClick: () => void
    accent?: boolean
    disabled?: boolean
}) {
    return (
        <Box component="button" onClick={onClick} disabled={disabled} sx={CELL_SX(!!accent)}>
            {icon}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {label}
            </Box>
        </Box>
    )
}

/** A cell that opens a popover. A real Popover (portalled, positioned against the
 *  button) rather than an absolutely-positioned dropdown, because the panels this
 *  sits in are `overflow: hidden` and would clip one. */
export function ToolMenu({
    icon,
    label,
    width,
    children,
}: {
    icon?: ReactNode
    label: string
    width: number
    /** Rendered with a `close` callback so an action inside can dismiss the menu. */
    children: (close: () => void) => ReactNode
}) {
    const [anchor, setAnchor] = useState<HTMLElement | null>(null)
    const open = anchor !== null
    const close = () => setAnchor(null)

    return (
        <>
            <Box
                component="button"
                onClick={(e: React.MouseEvent<HTMLElement>) =>
                    setAnchor(open ? null : e.currentTarget)
                }
                aria-haspopup="true"
                aria-expanded={open}
                sx={CELL_SX(open)}
            >
                {icon}
                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {label}
                </Box>
                <ChevronDown
                    size={13}
                    style={{
                        flexShrink: 0,
                        opacity: 0.55,
                        transform: open ? 'rotate(180deg)' : 'none',
                        transition: 'transform .15s',
                    }}
                />
            </Box>

            <Popover
                open={open}
                anchorEl={anchor}
                onClose={close}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                marginThreshold={12}
                slotProps={{
                    paper: {
                        sx: {
                            mt: 0.75,
                            width,
                            maxWidth: 'calc(100vw - 24px)',
                            p: 1.5,
                            bgcolor: 'var(--surface)',
                            backgroundImage: 'none',
                            border: '1px solid var(--line)',
                            borderRadius: '11px',
                            boxShadow: '0 20px 50px -24px rgba(0,0,0,0.85)',
                        },
                    },
                }}
            >
                {children(close)}
            </Popover>
        </>
    )
}
