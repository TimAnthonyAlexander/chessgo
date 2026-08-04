import { Box } from '@mui/material'
import SkeletonBar from '../home/SkeletonBar'
import { Panel } from '../home/Panel'

/** Loading placeholder shaped like the real report: headline band, then the
 * sidebar/main split, so the layout doesn't jump when data arrives. Mirrors
 * ProfileSkeleton's idiom. */
export default function TutorReportSkeleton() {
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            <Box sx={{ pb: { xs: 2, md: 2.5 }, borderBottom: '1px solid var(--line-soft)' }}>
                <SkeletonBar w={140} h={12} />
                <SkeletonBar w="70%" h={30} sx={{ mt: 1.5 }} />
                <SkeletonBar w={220} h={13} sx={{ mt: 1.5 }} />
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 300px) minmax(0, 1fr)' },
                    gap: 2.5,
                    alignItems: 'start',
                }}
            >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {Array.from({ length: 3 }).map((_, i) => (
                        <SkeletonBar key={i} h={40} sx={{ borderRadius: '10px' }} />
                    ))}
                </Box>
                <Panel>
                    <SkeletonBar w={100} h={14} sx={{ mb: 2 }} />
                    {Array.from({ length: 5 }).map((_, i) => (
                        <SkeletonBar key={i} h={34} sx={{ mb: 1.25, borderRadius: '8px' }} />
                    ))}
                </Panel>
            </Box>
        </Box>
    )
}
