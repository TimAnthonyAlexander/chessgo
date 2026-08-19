import { useState, type ElementType } from 'react'
import { Box, Button, Typography, type ButtonProps } from '@mui/material'
import { Copy, Check } from 'lucide-react'
import { Link, isRouteErrorResponse, useLocation, useRouteError } from 'react-router-dom'
import Logo from './Logo'

// Error internals (message, stack, component stack) are shown ONLY on the local
// dev server. Anywhere else — prod, a preview host, a phone on the LAN — the
// page shows the same calm copy with nothing leaked.
const DEV_ORIGINS = ['http://127.0.0.1:6465', 'http://localhost:6465']
const isDevOrigin = (): boolean =>
    typeof window !== 'undefined' && DEV_ORIGINS.includes(window.location.origin)

interface Shape {
    /** Small mono eyebrow: "404", "500", "OFFLINE". */
    code: string
    title: string
    body: string
    /** Reload is the primary action when the app itself is the stale part. */
    primary: 'home' | 'reload'
}

// A lazy route chunk that 404s is almost always a deploy that landed while the
// tab was open — the fix is a reload, not a bug report.
const isStaleChunk = (err: unknown): boolean =>
    err instanceof Error &&
    /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
        err.message,
    )

function shapeOf(err: unknown): Shape {
    if (isRouteErrorResponse(err) && err.status === 404) {
        return {
            code: '404',
            title: 'No such square.',
            body: 'That page never existed, or it moved.',
            primary: 'home',
        }
    }
    if (isRouteErrorResponse(err)) {
        return {
            code: String(err.status),
            title: 'That request failed.',
            body: err.statusText || 'The server turned this one down.',
            primary: 'home',
        }
    }
    if (isStaleChunk(err)) {
        return {
            code: 'STALE',
            title: 'chessgo updated.',
            body: 'This tab is running an old version. Reload to pick up the new one.',
            primary: 'reload',
        }
    }
    return {
        code: 'ERROR',
        title: 'Something broke.',
        body: 'The page hit an error and stopped. Your games are unaffected.',
        primary: 'home',
    }
}

/** Message + stack, for the dev-only detail panel and the copy button. */
function detailText(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}\n\n${err.stack ?? ''}`.trim()
    if (isRouteErrorResponse(err)) {
        const data = typeof err.data === 'string' ? err.data : JSON.stringify(err.data, null, 2)
        return `${err.status} ${err.statusText}\n\n${data ?? ''}`.trim()
    }
    try {
        return JSON.stringify(err, null, 2)
    } catch {
        return String(err)
    }
}

// Shaped like a router ErrorResponse (isRouteErrorResponse duck-types on these
// four fields) so the explicit `*` route and a real router 404 render identically.
const NOT_FOUND = { status: 404, statusText: 'Not Found', internal: false, data: null }

/**
 * The router's `errorElement`: a quiet full-page state for thrown render errors
 * and unmatched URLs. Mounted inside the Layout outlet (so nav/footer survive)
 * and again on the root route as the last resort if the Layout itself throws —
 * which is why it carries its own wordmark home link.
 */
export default function RouteError() {
    // `undefined` when nothing was thrown (rendered as a plain element) — treat
    // that as a 404 rather than blanking the page.
    return <ErrorScreen error={useRouteError() ?? NOT_FOUND} />
}

/** The catch-all `*` route — a 404 with the app shell still around it. */
export function NotFound() {
    return <ErrorScreen error={NOT_FOUND} />
}

function ErrorScreen({ error }: { error: unknown }) {
    const { pathname } = useLocation()
    const [copied, setCopied] = useState(false)
    const shape = shapeOf(error)
    const dev = isDevOrigin()

    const copy = () => {
        void navigator.clipboard.writeText(detailText(error)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
        })
    }

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                px: 3,
                py: { xs: 8, md: 12 },
                minHeight: '60vh',
                animation: 'rise 320ms ease both',
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 560 }}>
                <Box
                    component={Link}
                    to="/"
                    aria-label="chessgo home"
                    sx={{
                        display: 'inline-flex',
                        color: 'var(--muted)',
                        mb: 4,
                        transition: 'color .15s ease',
                        '&:hover': { color: 'var(--accent)' },
                    }}
                >
                    <Logo size={26} />
                </Box>

                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        letterSpacing: '0.22em',
                        color: 'var(--accent)',
                        mb: 1.5,
                    }}
                >
                    {shape.code}
                </Typography>

                <Typography
                    component="h1"
                    sx={{
                        fontFamily: 'var(--font-display)',
                        fontWeight: 600,
                        fontSize: { xs: 34, md: 44 },
                        lineHeight: 1.08,
                        letterSpacing: '-0.02em',
                        m: 0,
                    }}
                >
                    {shape.title}
                </Typography>

                <Typography
                    sx={{
                        mt: 2,
                        fontSize: 16,
                        lineHeight: 1.6,
                        color: 'var(--text-dim)',
                        maxWidth: 440,
                    }}
                >
                    {shape.body}
                </Typography>

                {shape.code === '404' && (
                    <Typography
                        sx={{
                            mt: 1.5,
                            fontFamily: 'var(--font-mono)',
                            fontSize: 13,
                            color: 'var(--muted)',
                            wordBreak: 'break-all',
                        }}
                    >
                        {pathname}
                    </Typography>
                )}

                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 4 }}>
                    {shape.primary === 'reload' ? (
                        <>
                            <PrimaryButton onClick={() => window.location.reload()}>
                                Reload
                            </PrimaryButton>
                            <GhostButton component={Link} to="/">
                                Home
                            </GhostButton>
                        </>
                    ) : (
                        <>
                            <PrimaryButton component={Link} to="/">
                                Back to lobby
                            </PrimaryButton>
                            <GhostButton onClick={() => window.location.reload()}>
                                Reload
                            </GhostButton>
                        </>
                    )}
                </Box>

                {dev && (
                    <Box sx={{ mt: 6 }}>
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 1.5,
                                mb: 1.5,
                            }}
                        >
                            <Typography
                                sx={{
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11,
                                    letterSpacing: '0.18em',
                                    color: 'var(--muted)',
                                }}
                            >
                                DEV DETAIL
                            </Typography>
                            <Box sx={{ flex: 1, height: '1px', bgcolor: 'var(--line-soft)' }} />
                            <Box
                                component="button"
                                onClick={copy}
                                sx={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 0.6,
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    p: 0,
                                    font: 'inherit',
                                    fontFamily: 'var(--font-mono)',
                                    fontSize: 11,
                                    letterSpacing: '0.1em',
                                    color: copied ? 'var(--live)' : 'var(--muted)',
                                    '&:hover': { color: 'var(--accent)' },
                                }}
                            >
                                {copied ? <Check size={12} /> : <Copy size={12} />}
                                {copied ? 'COPIED' : 'COPY'}
                            </Box>
                        </Box>
                        <Box
                            component="pre"
                            sx={{
                                m: 0,
                                p: 2,
                                maxHeight: 340,
                                overflow: 'auto',
                                bgcolor: 'var(--surface)',
                                border: '1px solid var(--line-soft)',
                                borderRadius: 'var(--radius)',
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                lineHeight: 1.65,
                                color: 'var(--text-dim)',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                            }}
                        >
                            {detailText(error)}
                        </Box>
                    </Box>
                )}
            </Box>
        </Box>
    )
}

// Two button skins matching the site: a brass fill and a hairline ghost. Both
// accept `component={Link} to=…` so an action can be a navigation or a click.
type ActionProps = ButtonProps & { component?: ElementType; to?: string }

function PrimaryButton(props: ActionProps) {
    return (
        <Button
            {...props}
            sx={{
                background: 'var(--accent-fill)',
                color: 'var(--on-accent)',
                fontWeight: 700,
                '&:hover': { background: 'var(--accent-fill-hover)' },
            }}
        />
    )
}

function GhostButton(props: ActionProps) {
    return (
        <Button
            {...props}
            variant="outlined"
            color="inherit"
            sx={{
                borderColor: 'var(--line)',
                color: 'var(--text-dim)',
                '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
            }}
        />
    )
}
