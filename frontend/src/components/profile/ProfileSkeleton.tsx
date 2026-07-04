import { Box } from '@mui/material'
import SkeletonBar from '../home/SkeletonBar'
import { Panel } from '../home/Panel'

/** Loading placeholder shaped like the real profile dashboard (hero band +
 * two-column body), so the layout doesn't jump when data arrives. */
export default function ProfileSkeleton() {
    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
            {/* Hero */}
            <Box
                sx={{
                    bgcolor: 'var(--surface)',
                    border: '1px solid var(--line-soft)',
                    borderRadius: '16px',
                    p: { xs: 2.5, md: 3 },
                    display: 'flex',
                    flexDirection: { xs: 'column', md: 'row' },
                    alignItems: { md: 'center' },
                    justifyContent: 'space-between',
                    gap: 2.5,
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Box
                        sx={{
                            width: 62,
                            height: 62,
                            borderRadius: '16px',
                            bgcolor: 'var(--surface-2)',
                            flexShrink: 0,
                        }}
                    />
                    <Box>
                        <SkeletonBar w={160} h={22} />
                        <SkeletonBar w={120} h={11} sx={{ mt: 1 }} />
                    </Box>
                </Box>
                <SkeletonBar w={220} h={72} sx={{ borderRadius: '14px' }} />
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
                    <Panel>
                        <SkeletonBar w={80} h={14} />
                        <SkeletonBar w="60%" h={28} sx={{ mt: 1.5 }} />
                        <SkeletonBar h={10} sx={{ mt: 1.5, borderRadius: '999px' }} />
                    </Panel>
                    <Panel>
                        <SkeletonBar w={80} h={14} sx={{ mb: 2 }} />
                        {Array.from({ length: 4 }).map((_, i) => (
                            <SkeletonBar key={i} h={28} sx={{ mb: 1, borderRadius: '10px' }} />
                        ))}
                    </Panel>
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
