import { Box, Dialog, DialogContent, Typography } from '@mui/material'
import { useRegisteredShortcuts, type Shortcut } from '../lib/shortcuts'

// Display-only lookups so chips read naturally (arrows as glyphs, modifiers
// title-cased) without teaching the registry anything about presentation.
const KEY_DISPLAY: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    Enter: 'Enter',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    ' ': 'Space',
}
const MOD_DISPLAY: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Cmd' }

/** Split an authored `keys` string into one display chip per key. */
function formatKeys(keys: string): string[] {
    const parts = keys.split('+')
    const base = parts.pop() ?? keys
    const mods = parts.map((m) => MOD_DISPLAY[m.toLowerCase()] ?? m)
    const baseDisplay = KEY_DISPLAY[base] ?? (base.length === 1 ? base.toUpperCase() : base)
    return [...mods, baseDisplay]
}

function KeyChip({ children }: { children: string }) {
    return (
        <Box
            component="kbd"
            sx={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 22,
                height: 22,
                px: 0.75,
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1,
                color: 'var(--text)',
                bgcolor: 'var(--line-soft)',
                border: '1px solid var(--line)',
                borderRadius: '6px',
            }}
        >
            {children}
        </Box>
    )
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
    return (
        <Box
            sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
                py: 0.85,
            }}
        >
            <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>{shortcut.label}</Typography>
            <Box sx={{ display: 'flex', gap: 0.5, flexShrink: 0 }}>
                {formatKeys(shortcut.keys).map((k, i) => (
                    <KeyChip key={i}>{k}</KeyChip>
                ))}
            </Box>
        </Box>
    )
}

/** Lists every shortcut currently registered — global bindings plus whatever
 * the active page has wired up — grouped in registration order (globals
 * first, then the page's own groups). Purely a read of lib/shortcuts'
 * registry: there is nothing here to keep in sync by hand when a page adds or
 * changes its bindings. */
export default function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const groups = useRegisteredShortcuts()

    return (
        <Dialog
            open={open}
            onClose={onClose}
            maxWidth={false}
            slotProps={{
                paper: {
                    sx: {
                        bgcolor: 'var(--surface)',
                        border: '1px solid var(--line)',
                        borderRadius: 3,
                        width: '92vw',
                        maxWidth: 440,
                    },
                },
            }}
        >
            <DialogContent sx={{ p: 3, maxHeight: '80vh', overflowY: 'auto' }}>
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: 20,
                        mb: 2.5,
                    }}
                >
                    Keyboard shortcuts
                </Typography>

                {groups.length === 0 && (
                    <Typography sx={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
                        Nothing bound on this page.
                    </Typography>
                )}

                {groups.map(({ group, shortcuts }, i) => (
                    <Box key={group} sx={{ mb: i === groups.length - 1 ? 0 : 2.25 }}>
                        <Typography
                            sx={{
                                fontSize: 11.5,
                                fontWeight: 700,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                color: 'var(--accent)',
                                mb: 0.5,
                            }}
                        >
                            {group}
                        </Typography>
                        {shortcuts.map((s) => (
                            <ShortcutRow key={`${s.keys}-${s.label}`} shortcut={s} />
                        ))}
                    </Box>
                ))}

                <Typography sx={{ mt: 2.5, fontSize: 12, color: 'var(--muted)' }}>
                    Shortcuts depend on the current page — this list only shows what's active here.
                </Typography>
            </DialogContent>
        </Dialog>
    )
}
