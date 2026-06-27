import { Link } from 'react-router-dom'
import { Box, Typography } from '@mui/material'
import Logo from './Logo'

// A site footer that anchors the bottom of every page. It self-constrains its
// content to the dashboard max-width (mx:'auto'), so it can be dropped straight
// in after <main> in Layout. Dark theme, CSS-variable styling only.

interface FooterLink {
  label: string
  to: string
  external?: boolean
}

interface FooterColumn {
  title: string
  links: FooterLink[]
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'Play',
    links: [
      { label: 'Online', to: '/' },
      { label: 'vs Computer', to: '/bot' },
      { label: 'Puzzles', to: '/puzzles' },
    ],
  },
  {
    title: 'Watch',
    links: [{ label: 'Live games', to: '/watch' }],
  },
  {
    title: 'Tools',
    links: [
      { label: 'Analysis', to: '/analysis' },
      { label: 'Board editor', to: '/editor' },
    ],
  },
  {
    title: 'About',
    // Placeholder GitHub URL — fixed during wiring.
    links: [{ label: 'GitHub', to: 'https://github.com', external: true }],
  },
]

// Shared link styling: muted, brightening to the brass accent on hover.
const linkSx = {
  fontSize: 13,
  color: 'var(--text-dim)',
  transition: 'color .12s ease',
  '&:hover': { color: 'var(--accent)' },
} as const

function FooterAnchor({ link }: { link: FooterLink }) {
  if (link.external) {
    return (
      <Box component="a" href={link.to} target="_blank" rel="noreferrer" sx={linkSx}>
        {link.label}
      </Box>
    )
  }
  return (
    <Box component={Link} to={link.to} sx={linkSx}>
      {link.label}
    </Box>
  )
}

export default function Footer() {
  const year = new Date().getFullYear()

  return (
    <Box
      component="footer"
      sx={{
        borderTop: '1px solid var(--line-soft)',
        bgcolor: 'var(--bg-2)',
        px: { xs: 3, md: 4 },
        py: { xs: 5, md: 6 },
      }}
    >
      <Box sx={{ maxWidth: 1320, mx: 'auto' }}>
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            gap: { xs: 5, md: 8 },
            justifyContent: 'space-between',
          }}
        >
          {/* Brand block */}
          <Box sx={{ maxWidth: 340 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ display: 'flex', color: 'var(--accent)' }}>
                <Logo size={22} />
              </Box>
              <Box
                component="span"
                sx={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 600,
                  fontSize: 20,
                  letterSpacing: '-0.01em',
                  color: 'var(--text)',
                }}
              >
                chessgo
              </Box>
            </Box>
            <Typography sx={{ mt: 1.5, fontSize: 13, lineHeight: 1.6, color: 'var(--muted)' }}>
              Play chess against humans and a homemade engine.
            </Typography>
          </Box>

          {/* Link columns */}
          <Box
            sx={{
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              flexWrap: 'wrap',
              gap: { xs: 4, md: 6 },
            }}
          >
            {COLUMNS.map((col) => (
              <Box key={col.title} sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 96 }}>
                <Typography
                  sx={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: '0.12em',
                    color: 'var(--muted)',
                  }}
                >
                  {col.title}
                </Typography>
                {col.links.map((link) => (
                  <FooterAnchor key={link.label} link={link} />
                ))}
              </Box>
            ))}
          </Box>
        </Box>

        {/* Bottom strip */}
        <Box
          sx={{
            mt: { xs: 4, md: 6 },
            pt: 2.5,
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          <Typography sx={{ fontSize: 12, color: 'var(--muted)' }}>© {year} chessgo</Typography>
        </Box>
      </Box>
    </Box>
  )
}
