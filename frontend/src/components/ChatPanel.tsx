import { memo, useEffect, useRef, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { MessageSquare, Send } from 'lucide-react'
import { PANEL_SHADOW } from './PanelUI'
import type { ChatMessage } from '../lib/socket'

// Players-only in-game chat. Read-only history + a single-line composer; the
// store relays text to the opponent and echoes our own line back, so every
// message (mine or theirs) arrives via the same `chat` event.
//
// memo()'d: `messages` only gets a new array reference from GameSocket when a
// chat message actually arrives (a move/offer/presence update spreads the game
// object without touching it), `onSend` is expected to be a useCallback-stable
// closure at the call site (LiveGame's `gameSocket.sendChat` wrapper), and
// `disabled` is a primitive boolean — so this bails on every LiveGame render
// that isn't a chat event, a game start/end, or the disabled flag flipping.
function ChatPanel({
    messages,
    onSend,
    disabled,
}: {
    messages: ChatMessage[]
    onSend: (text: string) => void
    disabled?: boolean
}) {
    const [text, setText] = useState('')
    const endRef = useRef<HTMLDivElement>(null)

    // Keep the newest message in view.
    useEffect(() => {
        endRef.current?.scrollIntoView({ block: 'end' })
    }, [messages.length])

    const send = () => {
        const t = text.trim()
        if (!t) return
        onSend(t)
        setText('')
    }

    return (
        <Box
            sx={{
                // Fills whatever the cards above it leave in the column.
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                bgcolor: 'var(--surface)',
                border: '1px solid var(--line-soft)',
                borderRadius: 'var(--radius)',
                overflow: 'hidden',
                boxShadow: PANEL_SHADOW,
            }}
        >
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.75,
                    px: 1.75,
                    py: 1.25,
                    bgcolor: 'var(--bg-2)',
                    borderBottom: '1px solid var(--line-soft)',
                    color: 'var(--text-dim)',
                }}
            >
                <MessageSquare size={14} />
                <Typography
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: 0.3,
                    }}
                >
                    Chat
                </Typography>
            </Box>

            <Box
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-label="Chat messages"
                tabIndex={0}
                sx={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: 'auto',
                    px: 1.5,
                    py: 1.25,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 0.75,
                    '&:focus-visible': { outline: '2px solid #5a6bd8', outlineOffset: '-2px' },
                }}
            >
                {messages.map((m) => (
                    <ChatLine key={m.id} m={m} />
                ))}
                <div ref={endRef} />
            </Box>

            <Box
                component="form"
                onSubmit={(e) => {
                    e.preventDefault()
                    send()
                }}
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    p: 1,
                    borderTop: '1px solid var(--line-soft)',
                    bgcolor: 'var(--bg-2)',
                }}
            >
                <Box
                    component="input"
                    aria-label="Chat message"
                    value={text}
                    maxLength={280}
                    disabled={disabled}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setText(e.target.value)}
                    placeholder={disabled ? 'Chat unavailable' : 'Message…'}
                    sx={{
                        flex: 1,
                        minWidth: 0,
                        height: 36,
                        px: 1.25,
                        fontSize: 13.5,
                        fontFamily: 'var(--font-body)',
                        color: 'var(--text)',
                        bgcolor: 'var(--surface-2)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        outline: 'none',
                        '&:focus': { borderColor: 'var(--accent-line)' },
                        '&::placeholder': { color: 'var(--muted)' },
                        '&:disabled': { opacity: 0.5 },
                    }}
                />
                <Box
                    component="button"
                    type="submit"
                    aria-label="Send message"
                    disabled={disabled || !text.trim()}
                    sx={{
                        width: 36,
                        height: 36,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        color: 'var(--text-dim)',
                        bgcolor: 'var(--surface-2)',
                        border: '1px solid var(--line)',
                        borderRadius: 'var(--radius)',
                        transition: 'color .15s, background-color .15s',
                        '&:hover': { color: 'var(--accent)', bgcolor: 'var(--line)' },
                        '&:disabled': { opacity: 0.4, pointerEvents: 'none' },
                    }}
                >
                    <Send size={15} />
                </Box>
            </Box>
        </Box>
    )
}

export default memo(ChatPanel)

function ChatLine({ m }: { m: ChatMessage }) {
    return (
        <Box
            sx={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: m.mine ? 'flex-end' : 'flex-start',
            }}
        >
            <Typography sx={{ fontSize: 10.5, color: 'var(--muted)', lineHeight: 1, mb: 0.25 }}>
                {m.mine ? 'You' : m.name || 'Opponent'}
            </Typography>
            <Box
                sx={{
                    maxWidth: '85%',
                    px: 1.25,
                    py: 0.65,
                    borderRadius: 'var(--radius)',
                    fontSize: 13,
                    lineHeight: 1.35,
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                    color: m.mine ? 'var(--on-accent)' : 'var(--text)',
                    bgcolor: m.mine ? 'var(--accent)' : 'var(--surface-2)',
                    border: m.mine ? '1px solid var(--accent)' : '1px solid var(--line)',
                }}
            >
                {m.text}
            </Box>
        </Box>
    )
}
