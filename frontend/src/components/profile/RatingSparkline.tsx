import { Box } from '@mui/material'

/** A tiny rating-trend line: normalized polyline + soft area fill + an endpoint
 * dot. Colour is inherited via `currentColor` so callers pass any CSS colour
 * (accent var or a category hex) through `color`. Renders nothing for <2 points. */
export default function RatingSparkline({
    series,
    color = 'var(--accent)',
    width = 128,
    height = 40,
}: {
    series: number[]
    color?: string
    width?: number
    height?: number
}) {
    if (series.length < 2) return null

    const min = Math.min(...series)
    const max = Math.max(...series)
    const span = max - min || 1
    const pad = 3
    const stepX = (width - pad * 2) / (series.length - 1)

    const pts = series.map((v, i) => {
        const x = pad + i * stepX
        const y = pad + (height - pad * 2) * (1 - (v - min) / span)
        return [x, y] as const
    })
    const line = pts.map(([x, y]) => `${x},${y}`).join(' ')
    const [lastX, lastY] = pts[pts.length - 1]
    const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`

    return (
        <Box
            component="svg"
            viewBox={`0 0 ${width} ${height}`}
            sx={{ width, height, display: 'block', color, overflow: 'visible' }}
            aria-hidden
        >
            <polygon points={area} fill="currentColor" fillOpacity={0.12} />
            <polyline
                points={line}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx={lastX} cy={lastY} r={2.75} fill="currentColor" />
        </Box>
    )
}
