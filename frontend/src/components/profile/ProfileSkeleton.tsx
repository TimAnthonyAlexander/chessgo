import { Box } from '@mui/material'
import SkeletonBar from '../home/SkeletonBar'
import { Panel } from '../home/Panel'

/** Loading placeholder shaped like the real profile dashboard (hero band +
 * two-column body), so the layout doesn't jump when data arrives. Mirrors the
 * real layout's chrome: the hero and sidebar sections are plain (a hairline,
 * no card), only the games column gets a bordered placeholder, since that's
 * the one real card on the page. */
export default function ProfileSkeleton() {
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {/* Hero: identity-only (avatar + name + joined date), hairline below. */}
            <Box
                sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    pb: { xs: 2, md: 2.5 },
                    borderBottom: '1px solid var(--line-soft)',
                }}
            >
                <Box
                    sx={{
                        width: 58,
                        height: 58,
                        borderRadius: '14px',
                        bgcolor: 'var(--surface-2)',
                        flexShrink: 0,
                    }}
                />
                <Box>
                    <SkeletonBar w={160} h={22} />
                    <SkeletonBar w={120} h={11} sx={{ mt: 1 }} />
                </Box>
            </Box>

            {/* Two columns */}
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 300px) minmax(0, 1fr)' },
                    gap: 2.5,
                    alignItems: 'start',
                }}
            >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                    <Box>
                        <SkeletonBar w={80} h={14} />
                        <SkeletonBar w="60%" h={28} sx={{ mt: 1.5 }} />
                        <SkeletonBar h={8} sx={{ mt: 1.5, borderRadius: '999px' }} />
                    </Box>
                    <Box sx={{ pt: 2.5, borderTop: '1px solid var(--line-soft)' }}>
                        <SkeletonBar w={80} h={14} sx={{ mb: 2 }} />
                        {Array.from({ length: 4 }).map((_, i) => (
                            <SkeletonBar key={i} h={28} sx={{ mb: 1, borderRadius: '10px' }} />
                        ))}
                    </Box>
                </Box>
                <Panel>
                    <SkeletonBar w={80} h={14} sx={{ mb: 2 }} />
                    {Array.from({ length: 6 }).map((_, i) => (
                        <SkeletonBar key={i} h={40} sx={{ mb: 1, borderRadius: '10px' }} />
                    ))}
                </Panel>
            </Box>
        </Box>
    )
}
