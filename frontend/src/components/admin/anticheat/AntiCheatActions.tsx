import { useState } from 'react'
import { Box, Button, CircularProgress, Snackbar, Typography } from '@mui/material'
import { Ban, Check, RotateCcw } from 'lucide-react'
import { setFlagVerdict, type FlagStatus } from '../../../api/client'
import { STATUS_META } from '../dashboard/labels'
import { Panel, PanelHead } from '../../home/Panel'
import BanConfirmDialog from './BanConfirmDialog'

// The three review-lifecycle states an admin moves an account through (banned is
// reached via the dedicated Ban action, not this segmented control).
const REVIEW_STATES: FlagStatus[] = ['open', 'reviewing', 'cleared']

/** Account-level verdict controls: a segmented open→reviewing→cleared status
 * control, a confirm-gated Ban, and a Reinstate action when already banned. Every
 * mutation reports the new state up so the page reconciles from the server. */
export default function AntiCheatActions({
    userId,
    userName,
    status,
    onChanged,
}: {
    userId: string
    userName: string
    status: FlagStatus
    onChanged: (status: FlagStatus) => void
}) {
    const [busy, setBusy] = useState<FlagStatus | 'ban' | 'unban' | null>(null)
    const [confirmBan, setConfirmBan] = useState(false)
    const [toast, setToast] = useState<string | null>(null)
    const [err, setErr] = useState<string | null>(null)

    async function setStatus(next: FlagStatus) {
        if (next === status || busy) return
        setBusy(next)
        setErr(null)
        try {
            const res = await setFlagVerdict(userId, { status: next })
            onChanged(res.status as FlagStatus)
            setToast(`Verdict set to “${STATUS_META[next].label}”`)
        } catch (e) {
            setErr((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    async function ban() {
        setBusy('ban')
        setErr(null)
        try {
            const res = await setFlagVerdict(userId, { status: 'banned', ban: true })
            onChanged(res.status as FlagStatus)
            setToast(`${userName} has been banned`)
            setConfirmBan(false)
        } catch (e) {
            setErr((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    async function unban() {
        setBusy('unban')
        setErr(null)
        try {
            const res = await setFlagVerdict(userId, { ban: false })
            onChanged(res.status as FlagStatus)
            setToast(`${userName} has been reinstated`)
        } catch (e) {
            setErr((e as Error).message)
        } finally {
            setBusy(null)
        }
    }

    const banned = status === 'banned'

    return (
        <Panel>
            <PanelHead title="Verdict" sub="Move the account through review, or ban it" />

            {/* Segmented status control */}
            <Box
                sx={{
                    display: 'flex',
                    gap: 0.5,
                    p: 0.5,
                    borderRadius: 'var(--radius)',
                    bgcolor: 'var(--surface-2)',
                    border: '1px solid var(--line-soft)',
                    opacity: banned ? 0.55 : 1,
                }}
            >
                {REVIEW_STATES.map((s) => {
                    const active = status === s
                    const { label, color } = STATUS_META[s]
                    const loading = busy === s
                    return (
                        <Box
                            key={s}
                            component="button"
                            disabled={banned || busy != null}
                            onClick={() => setStatus(s)}
                            sx={{
                                flex: 1,
                                appearance: 'none',
                                cursor: banned ? 'default' : 'pointer',
                                border: '1px solid',
                                borderColor: active
                                    ? `color-mix(in srgb, ${color} 46%, transparent)`
                                    : 'transparent',
                                borderRadius: 'var(--radius)',
                                py: 0.875,
                                bgcolor: active
                                    ? `color-mix(in srgb, ${color} 16%, transparent)`
                                    : 'transparent',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 0.5,
                                '&:hover': {
                                    bgcolor:
                                        active || banned ? undefined : 'rgba(255,255,255,0.04)',
                                },
                                '&:disabled': { cursor: 'default' },
                            }}
                        >
                            {loading && (
                                <CircularProgress size={12} sx={{ color: 'var(--text-dim)' }} />
                            )}
                            <Typography
                                sx={{
                                    fontSize: 12,
                                    fontWeight: 700,
                                    letterSpacing: '0.05em',
                                    textTransform: 'uppercase',
                                    color: active ? color : 'var(--text-dim)',
                                }}
                            >
                                {label}
                            </Typography>
                        </Box>
                    )
                })}
            </Box>

            {/* Ban / reinstate */}
            <Box sx={{ mt: 1.5 }}>
                {banned ? (
                    <Button
                        fullWidth
                        onClick={unban}
                        disabled={busy != null}
                        startIcon={
                            busy === 'unban' ? (
                                <CircularProgress size={15} sx={{ color: 'var(--text)' }} />
                            ) : (
                                <RotateCcw size={16} />
                            )
                        }
                        sx={{
                            textTransform: 'none',
                            fontWeight: 700,
                            color: 'var(--text)',
                            border: '1px solid var(--line)',
                            bgcolor: 'var(--surface-2)',
                            py: 1,
                            '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
                        }}
                    >
                        Reinstate account
                    </Button>
                ) : (
                    <Button
                        fullWidth
                        onClick={() => setConfirmBan(true)}
                        disabled={busy != null}
                        startIcon={<Ban size={16} />}
                        sx={{
                            textTransform: 'none',
                            fontWeight: 700,
                            color: '#e06a6a',
                            border: '1px solid color-mix(in srgb, #ca4a4a 42%, transparent)',
                            bgcolor: 'color-mix(in srgb, #ca4a4a 12%, transparent)',
                            py: 1,
                            '&:hover': { bgcolor: 'color-mix(in srgb, #ca4a4a 20%, transparent)' },
                        }}
                    >
                        Ban account
                    </Button>
                )}
            </Box>

            {banned && (
                <Box
                    sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 0.75,
                        mt: 1.25,
                        color: 'var(--muted)',
                    }}
                >
                    <Check size={13} />
                    <Typography sx={{ fontSize: 11.5 }}>
                        Account is banned and signed out.
                    </Typography>
                </Box>
            )}

            <BanConfirmDialog
                open={confirmBan}
                userName={userName}
                busy={busy === 'ban'}
                onConfirm={ban}
                onCancel={() => setConfirmBan(false)}
            />

            <Snackbar
                open={toast != null}
                autoHideDuration={4000}
                onClose={() => setToast(null)}
                message={toast ?? ''}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            />
            <Snackbar
                open={err != null}
                autoHideDuration={6000}
                onClose={() => setErr(null)}
                message={err ? `Action failed: ${err}` : ''}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            />
        </Panel>
    )
}
