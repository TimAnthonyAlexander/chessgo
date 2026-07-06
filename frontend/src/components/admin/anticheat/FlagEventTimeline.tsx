import { useEffect, useState } from 'react'
import { Box, Snackbar, Typography } from '@mui/material'
import { setFlagEventReviewed, type FlagEvent } from '../../../api/client'
import FlagEventRow from './FlagEventRow'

/** The per-user event timeline (newest first). Owns a local copy of the events so
 * the reviewed toggle can update optimistically, reconciling to the server's
 * response and rolling back on failure. */
export default function FlagEventTimeline({
    userId,
    events,
}: {
    userId: string
    events: FlagEvent[]
}) {
    const [rows, setRows] = useState<FlagEvent[]>(events)
    const [busy, setBusy] = useState<Set<string>>(new Set())
    const [err, setErr] = useState<string | null>(null)

    // Re-sync when the parent refetches (e.g. after a verdict change).
    useEffect(() => {
        setRows(events)
    }, [events])

    async function toggle(id: string, next: boolean) {
        // Optimistic: flip immediately (only this id, so a concurrent sibling toggle
        // is never clobbered).
        setRows((rs) => rs.map((e) => (e.id === id ? { ...e, reviewed: next } : e)))
        setBusy((b) => new Set(b).add(id))
        try {
            const res = await setFlagEventReviewed(userId, id, next)
            // Reconcile to the server's truth (in case it differs).
            setRows((rs) => rs.map((e) => (e.id === id ? { ...e, reviewed: res.reviewed } : e)))
        } catch (e) {
            // Roll back only this id to its pre-toggle value.
            setRows((rs) => rs.map((e) => (e.id === id ? { ...e, reviewed: !next } : e)))
            setErr((e as Error).message)
        } finally {
            setBusy((b) => {
                const n = new Set(b)
                n.delete(id)
                return n
            })
        }
    }

    if (rows.length === 0) {
        return (
            <Typography sx={{ fontSize: 13, color: 'var(--muted)' }}>
                No flag events recorded for this account.
            </Typography>
        )
    }

    return (
        <>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.875 }}>
                {rows.map((e) => (
                    <FlagEventRow
                        key={e.id}
                        event={e}
                        busy={busy.has(e.id)}
                        onToggleReviewed={(next) => toggle(e.id, next)}
                    />
                ))}
            </Box>
            <Snackbar
                open={err != null}
                autoHideDuration={5000}
                onClose={() => setErr(null)}
                message={err ?? ''}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            />
        </>
    )
}
