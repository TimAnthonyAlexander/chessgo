import { Box } from '@mui/material'
import SkeletonBar from '../home/SkeletonBar'

/** Loading placeholder shaped like the real report: eyebrow, hero figure, then
 * the rail/main split with meter-shaped rows, so the layout doesn't jump when
 * data arrives. Mirrors ProfileSkeleton's idiom. */
export default function TutorReportSkeleton() {
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: { xs: 3, md: 4 } }}>
            <Box>
                <SkeletonBar w={140} h={12} />
                <SkeletonBar w="60%" h={30} sx={{ mt: 1.5 }} />
                <Box sx={{ display: 'flex', gap: 3, mt: 2, alignItems: 'flex-end' }}>
                    <SkeletonBar w={90} h={34} />
                    <SkeletonBar w={70} h={26} />
                    <SkeletonBar w={180} h={8} sx={{ mb: 0.5 }} />
                </Box>
            </Box>

            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 260px) minmax(0, 1fr)' },
                    columnGap: 5,
                    rowGap: 4,
                    alignItems: 'start',
                }}
            >
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {Array.from({ length: 3 }).map((_, i) => (
                        <SkeletonBar key={i} h={34} sx={{ borderRadius: '10px' }} />
                    ))}
                    <SkeletonBar w="70%" h={12} sx={{ mt: 2 }} />
                </Box>
                <Box>
                    <SkeletonBar w={120} h={12} sx={{ mb: 2 }} />
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Box key={i} sx={{ mb: 2 }}>
                            <SkeletonBar w="45%" h={13} />
                            <SkeletonBar h={7} sx={{ mt: 1, borderRadius: '2px' }} />
                            <SkeletonBar w="30%" h={10} sx={{ mt: 0.75 }} />
                        </Box>
                    ))}
                </Box>
            </Box>
        </Box>
    )
}
