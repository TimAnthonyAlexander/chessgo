import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { GraduationCap, TrendingUp } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import {
    ApiError,
    getTutorReport,
    type TutorCategoryReport,
    type TutorPayload,
    type TutorReportSummary,
} from '../api/client'
import CategoryTabs from '../components/tutor/CategoryTabs'
import CategorySection from '../components/tutor/CategorySection'
import PeerBanner from '../components/tutor/PeerBanner'
import ReadingKey from '../components/tutor/ReadingKey'
import ReportHero, { hasHero, heroFinding } from '../components/tutor/ReportHero'
import ThemeProfileSection from '../components/tutor/ThemeProfileSection'
import { TUTOR_SECTIONS, type TutorSection } from '../components/tutor/sections'
import TutorReportSkeleton from '../components/tutor/TutorReportSkeleton'
import { cap, fmtDate, fmtGames } from '../components/tutor/format'

/** `/tutor/:id` — one built report: the hero (when there is one), a rail
 * carrying the frame every figure is read against, and the active category's
 * breakdown. Echoes Profile.tsx's sidebar/main split. */
export default function TutorReport() {
    const { id = '' } = useParams<{ id: string }>()
    const [report, setReport] = useState<TutorReportSummary | null>(null)
    const [payload, setPayload] = useState<TutorPayload | null>(null)
    const [active, setActive] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        setActive(null)
        getTutorReport(id)
            .then((r) => {
                if (cancelled) return
                setReport(r.report)
                setPayload(r.payload)
                const first = Object.keys(r.payload.categories)[0] ?? null
                setActive(first)
                setLoading(false)
            })
            .catch((e) => {
                if (cancelled) return
                setError(
                    e instanceof ApiError && e.status === 404
                        ? 'Report not found.'
                        : (e as Error).message,
                )
                setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [id])

    const activeCategory = useMemo(
        () => (payload && active ? (payload.categories[active] ?? null) : null),
        [payload, active],
    )

    return (
        <Box
            sx={{
                flex: 1,
                display: 'flex',
                justifyContent: 'center',
                px: { xs: 1.5, md: 3 },
                py: { xs: 2, md: 3.5 },
            }}
        >
            <Box sx={{ width: '100%', maxWidth: 1120 }}>
                {loading ? (
                    <TutorReportSkeleton />
                ) : error || !report || !payload ? (
                    <Centered>{error ?? 'Report unavailable.'}</Centered>
                ) : report.status !== 'ready' ? (
                    <Centered>
                        {report.status === 'failed'
                            ? (report.error ?? 'This report failed to build.')
                            : report.status === 'insufficient'
                              ? "There weren't enough games in this range to build a report."
                              : 'This report is still building.'}
                    </Centered>
                ) : (
                    <ReadyReport
                        id={id}
                        report={report}
                        payload={payload}
                        active={active}
                        onSelect={setActive}
                        activeCategory={activeCategory}
                    />
                )}
            </Box>
        </Box>
    )
}

// The report's possible sections, in reading order, live in
// components/tutor/sections.ts — each section stamps its own id onto its
// heading via SectionHead. Not every one is on the page for a given category
// (a category with no ranked findings never renders "What stands out"; a
// report with no puzzle history never renders "Tactical themes"), so the nav
// keeps only the ids that are actually in the document after a render.

function ReadyReport({
    id,
    report,
    payload,
    active,
    onSelect,
    activeCategory,
}: {
    id: string
    report: TutorReportSummary
    payload: TutorPayload
    active: string | null
    onSelect: (c: string) => void
    activeCategory: TutorCategoryReport | null
}) {
    // A report with nothing rankable in it renders no hero at all rather than a
    // large empty statement — see ReportHero's note. When the hero collapses,
    // only the eyebrow is left and the content starts most of a screen higher.
    const hero = hasHero(payload)

    // The one finding ReportHero already stated at full weight. CategorySection
    // drops it from its own list so the same figure is not restated three rows
    // later — see `heroFinding`, which returns exactly what the hero rendered.
    const heroKey = useMemo(() => (hero ? heroFinding(payload) : null), [hero, payload])

    // Which sections actually rendered. The ids come from sections.ts and are
    // stamped on by each section's own SectionHead, so this only has to ask
    // the document which of them exist — it never matches on heading text, and
    // rewording a heading cannot silently drop it out of the nav.
    const [anchors, setAnchors] = useState<TutorSection[]>([])
    const [activeSection, setActiveSection] = useState<string | null>(null)

    useLayoutEffect(() => {
        const found = TUTOR_SECTIONS.filter((s) => document.getElementById(s.id) !== null)
        setAnchors((prev) =>
            prev.length === found.length && prev.every((a, i) => a.id === found[i].id)
                ? prev
                : found,
        )
        setActiveSection((prev) =>
            prev && found.some((a) => a.id === prev) ? prev : (found[0]?.id ?? null),
        )
    }, [activeCategory, payload])

    // Scrollspy: the section you are reading is the last one whose heading has
    // passed the top quarter of the viewport.
    //
    // Derived from positions on every scroll rather than from an
    // IntersectionObserver watching a thin band. The observer version only
    // learned anything when a heading physically crossed its band, so any jump
    // — a nav click, a restored scroll position, an anchor load — left the rail
    // highlighting whatever was active before the jump. Reading the positions
    // is stateless and cannot go stale, and rAF keeps it off the scroll thread.
    useEffect(() => {
        if (anchors.length < 2) return
        let frame = 0
        const sync = () => {
            frame = 0
            const line = window.innerHeight * 0.25
            let current = anchors[0].id
            for (const a of anchors) {
                const el = document.getElementById(a.id)
                if (el && el.getBoundingClientRect().top <= line) current = a.id
            }
            // The last sections are short enough that their headings may never
            // reach the line before the page runs out of scroll — without this
            // they could never light up at all.
            const doc = document.documentElement
            if (window.scrollY + window.innerHeight >= doc.scrollHeight - 2) {
                current = anchors[anchors.length - 1].id
            }
            setActiveSection(current)
        }
        const onScroll = () => {
            if (frame === 0) frame = window.requestAnimationFrame(sync)
        }
        sync()
        window.addEventListener('scroll', onScroll, { passive: true })
        window.addEventListener('resize', onScroll)
        return () => {
            if (frame !== 0) window.cancelAnimationFrame(frame)
            window.removeEventListener('scroll', onScroll)
            window.removeEventListener('resize', onScroll)
        }
    }, [anchors])

    const jumpToSection = (sectionId: string) => {
        const el = document.getElementById(sectionId)
        if (!el) return
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
        setActiveSection(sectionId)
    }

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 3, md: 4 } }}>
            <Box>
                <Link to="/tutor" style={{ textDecoration: 'none', display: 'inline-flex' }}>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            mb: hero ? 1.5 : 0,
                            color: 'var(--accent)',
                        }}
                    >
                        <GraduationCap size={15} />
                        <Typography
                            sx={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 12,
                                letterSpacing: '0.2em',
                                textTransform: 'uppercase',
                            }}
                        >
                            Tutor · {report.rangeLabel}
                        </Typography>
                    </Box>
                </Link>
                {hero && <ReportHero payload={payload} />}
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                        xs: '1fr',
                        lg: 'minmax(0, 260px) minmax(0, 1fr)',
                    },
                    columnGap: 5,
                    rowGap: 4,
                    alignItems: 'start',
                }}
            >
                {/* The rail. On mobile it splits in three around the content —
                    picking a category comes first, a compact "which category am
                    I reading" strip pins above the content itself, and the key
                    + provenance come after — `display: contents` hands all three
                    straight to the page grid so `order` can place them. On `lg`
                    this same box becomes the sticky column instead: pinned under
                    the (non-sticky) header once scrolled past its own position,
                    and capped to the viewport with internal scroll so a long
                    rail never runs past the fold. */}
                <Box
                    sx={{
                        display: { xs: 'contents', lg: 'flex' },
                        flexDirection: 'column',
                        gap: 4,
                        position: { lg: 'sticky' },
                        top: { lg: 16 },
                        maxHeight: { lg: 'calc(100vh - 32px)' },
                        overflowY: { lg: 'auto' },
                    }}
                >
                    <Box sx={{ order: { xs: 1, lg: 0 } }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <CategoryTabs payload={payload} active={active} onSelect={onSelect} />
                            {activeCategory && <PeerBanner category={activeCategory} />}
                            <SectionNav
                                anchors={anchors}
                                active={activeSection}
                                onJump={jumpToSection}
                            />
                        </Box>
                    </Box>
                    <MobileCategoryStrip payload={payload} active={active} onSelect={onSelect} />
                    <Box sx={{ order: { xs: 4, lg: 0 } }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {/* The key explains the peer meter. With no peer
                                band there are no meters, so it would be
                                explaining something that isn't on the page. */}
                            {activeCategory && activeCategory.peer.tier !== 'none' && (
                                <ReadingKey />
                            )}
                            <ReportMeta report={report} />
                        </Box>
                    </Box>
                </Box>

                <Box sx={{ minWidth: 0, order: { xs: 3, lg: 0 } }}>
                    {activeCategory ? (
                        <CategorySection
                            category={activeCategory}
                            reportId={id}
                            heroKey={heroKey}
                        />
                    ) : (
                        <Centered>
                            No category had enough games to report on. Play a few more and build
                            another report.
                        </Centered>
                    )}
                </Box>
            </Box>

            {payload.themeProfile && (
                <Box sx={{ pt: 1 }}>
                    <ThemeProfileSection profile={payload.themeProfile} />
                </Box>
            )}
        </Box>
    )
}

/** The rail's jump list — "In this report" plus one link per section actually
 * present on the page. Hidden entirely below two entries: jumping to the only
 * section on the page is not navigation. */
function SectionNav({
    anchors,
    active,
    onJump,
}: {
    anchors: TutorSection[]
    active: string | null
    onJump: (id: string) => void
}) {
    if (anchors.length < 2) return null

    return (
        <Box component="nav" aria-label="Sections in this report">
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 1,
                }}
            >
                In this report
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                {anchors.map((a) => {
                    const isActive = a.id === active
                    return (
                        <Box
                            key={a.id}
                            component="a"
                            href={`#${a.id}`}
                            aria-current={isActive ? 'true' : undefined}
                            onClick={(e) => {
                                e.preventDefault()
                                onJump(a.id)
                            }}
                            sx={{
                                display: 'block',
                                px: 1.25,
                                py: 0.6,
                                borderRadius: '8px',
                                fontSize: 13,
                                fontWeight: 600,
                                textDecoration: 'none',
                                color: isActive ? 'var(--accent)' : 'var(--text-dim)',
                                bgcolor: isActive ? 'var(--accent-soft)' : 'transparent',
                                '&:hover': { color: 'var(--accent)' },
                                '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                            }}
                        >
                            {a.label}
                        </Box>
                    )
                })}
            </Box>
        </Box>
    )
}

/** Below `lg` the rail is never sticky, so nothing above the fold says which
 * time control screen two onward belongs to. This is that reminder, pinned to
 * the top of the viewport once scrolled past its own position (right above
 * the category breakdown) — a plain label when there's only one category to
 * read, tappable pills when there's more than one to switch between. */
function MobileCategoryStrip({
    payload,
    active,
    onSelect,
}: {
    payload: TutorPayload
    active: string | null
    onSelect: (c: string) => void
}) {
    const categories = Object.values(payload.categories)
    if (categories.length === 0 || !active) return null
    const multi = categories.length > 1

    return (
        <Box
            sx={{
                display: { xs: 'block', lg: 'none' },
                order: { xs: 2 },
                position: 'sticky',
                top: 0,
                zIndex: 5,
                bgcolor: 'var(--bg)',
                borderBottom: '1px solid var(--line-soft)',
                py: 1,
            }}
        >
            {multi ? (
                <Box sx={{ display: 'flex', gap: 0.75, overflowX: 'auto' }}>
                    {categories.map((c) => {
                        const isActive = c.category === active
                        return (
                            <Box
                                key={c.category}
                                component="button"
                                type="button"
                                aria-pressed={isActive}
                                onClick={() => onSelect(c.category)}
                                sx={{
                                    flexShrink: 0,
                                    fontFamily: 'var(--font-ui)',
                                    fontSize: 12.5,
                                    fontWeight: 600,
                                    px: 1.25,
                                    py: 0.5,
                                    borderRadius: '999px',
                                    border: '1px solid',
                                    borderColor: isActive ? 'var(--accent)' : 'var(--line)',
                                    bgcolor: isActive ? 'var(--accent-soft)' : 'transparent',
                                    color: isActive ? 'var(--accent)' : 'var(--text-dim)',
                                    cursor: 'pointer',
                                    whiteSpace: 'nowrap',
                                    '&:focus-visible': { outline: '1px solid var(--accent-line)' },
                                }}
                            >
                                {cap(c.category)}
                            </Box>
                        )
                    })}
                </Box>
            ) : (
                <Typography
                    sx={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        fontWeight: 600,
                        letterSpacing: '0.14em',
                        textTransform: 'uppercase',
                        color: 'var(--text-dim)',
                    }}
                >
                    {cap(active)}
                </Typography>
            )}
        </Box>
    )
}

/** Where the report came from — moved out of the hero, where it was competing
 * with the headline, into the rail where it belongs as provenance. */
function ReportMeta({ report }: { report: TutorReportSummary }) {
    return (
        <Box>
            <Typography
                sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    mb: 0.75,
                }}
            >
                This report
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <MetaLine>
                    {fmtDate(report.rangeFrom)} – {fmtDate(report.rangeTo)}
                </MetaLine>
                <MetaLine>
                    {fmtGames(report.gamesUsed)} of {report.gamesConsidered}
                    {report.capHit ? ' (capped)' : ''}
                </MetaLine>
                {report.builtAt && <MetaLine>Built {fmtDate(report.builtAt)}</MetaLine>}
            </Box>
            <Box
                component={Link}
                to="/tutor/trend"
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.75,
                    mt: 1.25,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: 'var(--text-dim)',
                    textDecoration: 'none',
                    '&:hover': { color: 'var(--accent)' },
                }}
            >
                <TrendingUp size={14} />
                Compare with earlier reports
            </Box>
        </Box>
    )
}

function MetaLine({ children }: { children: React.ReactNode }) {
    return (
        <Typography
            sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
            }}
        >
            {children}
        </Typography>
    )
}

function Centered({ children }: { children: React.ReactNode }) {
    return (
        <Box
            sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 6 }}
        >
            <Typography
                sx={{
                    fontSize: 14,
                    color: 'var(--text-dim)',
                    textAlign: 'center',
                    maxWidth: '40ch',
                }}
            >
                {children}
            </Typography>
        </Box>
    )
}
