import { Box } from '@mui/material'
import SkeletonBar from '../home/SkeletonBar'

/** Loading placeholder shaped like the overview: eyebrow, hero figure, then a
 * stack of category blocks — a header line plus a handful of meter-shaped
 * rows each — so the layout doesn't jump when the report arrives. Two blocks
 * is a reasonable guess for the common case (most players have one or two
 * qualifying time controls); the real page renders however many categories
 * qualified, and the fetch is fast enough that a mismatch is never visible
 * for more than a frame. */
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

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Array.from({ length: 2 }).map((_, block) => (
                    <Box key={block}>
                        <Box
                            sx={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'baseline',
                            }}
                        >
                            <SkeletonBar w={100} h={18} />
                            <SkeletonBar w={60} h={12} />
                        </Box>
                        <SkeletonBar w={200} h={11} sx={{ mt: 0.75, mb: 2 }} />
                        {Array.from({ length: 5 }).map((_, row) => (
                            <Box
                                key={row}
                                sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1 }}
                            >
                                <SkeletonBar w="30%" h={13} />
                                <SkeletonBar h={9} sx={{ flex: 1, borderRadius: 'var(--radius)' }} />
                                <SkeletonBar w={40} h={13} />
                            </Box>
                        ))}
                    </Box>
                ))}
            </Box>
        </Box>
    )
}
