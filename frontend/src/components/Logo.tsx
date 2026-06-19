/**
 * chessgo brand mark — a custom geometric knight silhouette.
 *
 * Single source of truth for the logo path; the favicon (public/favicon.svg)
 * mirrors this same shape. The knight inherits `color` (default currentColor)
 * so the navbar can paint it with the brass accent, and it stays crisp at any
 * size (favicon → hero).
 */

/** The knight silhouette, drawn facing left on a 64×64 grid. */
export const KNIGHT_PATH =
  'M42 5.5 L47.5 15 L49 24 L50.5 34 L51 50 L53.5 50 L53.5 57.5 L15 57.5 ' +
  'L15 50 L25.5 50 L27 41 L18.5 38 L10.5 35 L8.5 28.5 L15 26.5 L21 24 ' +
  'L24 18.5 L28 13.5 L35 8.5 Z'

type LogoProps = {
  size?: number
  /** Fill of the knight; defaults to the inherited text color. */
  color?: string
  /** Optional eye color (defaults to a faint cut-out against the fill). */
  eye?: string
  title?: string
}

export default function Logo({ size = 22, color = 'currentColor', eye, title = 'chessgo' }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <path d={KNIGHT_PATH} fill={color} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {/* Eye — a small notch that gives the knight life at any size. */}
      <circle cx={30.5} cy={21} r={2.1} fill={eye ?? 'var(--bg, #131419)'} />
    </svg>
  )
}
