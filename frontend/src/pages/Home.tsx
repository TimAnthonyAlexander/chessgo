import { type ReactNode, useEffect, useState } from 'react'
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, Snackbar, Typography } from '@mui/material'
import {
  ChevronRight,
  Cpu,
  Crown,
  Rabbit,
  Swords,
  Target,
  Telescope,
  Timer,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { gameSocket, type LiveGameState } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'
import { useAuth } from '../lib/auth'
import { getStats, type LobbyStats } from '../api/client'

// Quick-pairing presets, grouped by time-control category.
interface Preset {
  time: string
  cat: keyof typeof CAT
}
const PRESETS: Preset[] = [
  { time: '1+0', cat: 'Bullet' },
  { time: '2+1', cat: 'Bullet' },
  { time: '3+0', cat: 'Blitz' },
  { time: '3+2', cat: 'Blitz' },
  { time: '5+0', cat: 'Blitz' },
  { time: '5+3', cat: 'Blitz' },
  { time: '10+0', cat: 'Rapid' },
  { time: '10+5', cat: 'Rapid' },
  { time: '15+10', cat: 'Rapid' },
  { time: '30+0', cat: 'Classical' },
  { time: '30+20', cat: 'Classical' },
]

// Per-category icon + accent colour for the pairing cells.
const CAT = {
  Bullet: { Icon: Rabbit, color: '#e0844a' },
  Blitz: { Icon: Zap, color: '#d8a657' },
  Rapid: { Icon: Timer, color: '#6f9e54' },
  Classical: { Icon: Crown, color: '#5e84c0' },
} as const

export default function Home() {
  const navigate = useNavigate()
  const s = useGameSocket()
  const live = s.game
  const { user } = useAuth()
  const [search, setSearch] = useState<string | null>(null)
  const [snack, setSnack] = useState<string | null>(null)

  // When the hub matches us, jump into the live game.
  useEffect(() => {
    if (s.status === 'matched' && s.game) {
      setSearch(null)
      navigate(`/game/${s.game.id}`)
    }
  }, [s.status, s.game?.id, navigate])

  const queue = (label: string, pool: string) => {
    void gameSocket.queue(pool)
    setSearch(label)
  }

  // Either source: our optimistic label, or a queue we landed in (e.g. "New game"
  // from a finished live game, which queues before routing here).
  const searching = search ?? (s.status === 'queued' ? s.pool : null)

  // Live lobby counts (poll while open; failures keep the last value).
  const [stats, setStats] = useState<LobbyStats | null>(null)
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      getStats()
        .then((r) => { if (!cancelled) setStats(r) })
        .catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, 10_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  return (
    <Box sx={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
      {/* Atmosphere: a warm glow up top + an oversized faint knight off to the side */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background: 'radial-gradient(ellipse 70% 50% at 50% -8%, rgba(216,166,87,0.10), transparent 62%)',
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          right: { xs: '-14vw', md: '2vw' },
          top: '6vh',
          pointerEvents: 'none',
          fontSize: 'min(58vh, 560px)',
          lineHeight: 1,
          color: 'var(--text)',
          opacity: 0.018,
        }}
      >
        ♞
      </Box>

      <Box
        sx={{
          position: 'relative',
          maxWidth: 1200,
          mx: 'auto',
          px: { xs: 2, md: 3 },
          py: { xs: 3, md: 5 },
        }}
      >
        {live && !live.ended && <ResumeBanner game={live} />}

        {/* Hero */}
        <Box
          sx={{
            display: 'flex',
            flexDirection: { xs: 'column', md: 'row' },
            alignItems: { md: 'flex-end' },
            justifyContent: 'space-between',
            gap: { xs: 2.5, md: 3 },
            mb: { xs: 3.5, md: 4.5 },
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography
              sx={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                mb: 1.25,
              }}
            >
              {user ? `Welcome back, ${user.name}` : 'Online chess'}
            </Typography>
            <Typography
              sx={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: { xs: 34, md: 46 },
                lineHeight: 1.04,
                letterSpacing: '-0.02em',
              }}
            >
              Find your next game.
            </Typography>
            <Typography sx={{ mt: 1.5, fontSize: { xs: 14.5, md: 15.5 }, color: 'var(--text-dim)', maxWidth: 540 }}>
              Pick a time control to get matched instantly — or take on the engine, solve tactics, and review your games.
            </Typography>
          </Box>

          {/* Live counters */}
          <Box sx={{ display: 'flex', gap: 1.25, flexShrink: 0 }}>
            <StatPill icon={<Users size={15} />} value={stats?.playersOnline} label="players online" pulse />
            <StatPill icon={<Swords size={15} />} value={stats?.activeGames} label="games in play" />
          </Box>
        </Box>

        {/* Main: quick pairing + ways to play */}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.55fr) minmax(300px, 1fr)' },
            gap: { xs: 2.5, lg: 3 },
            alignItems: 'start',
          }}
        >
          {/* Quick pairing */}
          <Panel>
            <PanelHead title="Quick pairing" sub="Get matched with a player of similar strength" />
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)' },
                gap: 1.25,
              }}
            >
              {PRESETS.map((p) => (
                <TimeCell key={p.time + p.cat} preset={p} onClick={() => queue(`${p.cat} · ${p.time}`, p.time)} />
              ))}
              <CustomCell onClick={() => setSnack('Custom time controls are coming soon — pick a preset to play now.')} />
            </Box>
          </Panel>

          {/* Ways to play + friend */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            <ModeCard
              icon={<Cpu size={20} />}
              title="Play the Computer"
              sub="Eleven levels, from gentle to merciless"
              highlight
              onClick={() => navigate('/bot')}
            />
            <ModeCard
              icon={<Target size={20} />}
              title="Puzzles"
              sub="Sharpen your tactics, rated"
              onClick={() => navigate('/puzzles')}
            />
            <ModeCard
              icon={<Telescope size={20} />}
              title="Analysis board"
              sub="Explore lines with the engine"
              onClick={() => navigate('/analysis')}
            />
            <ModeCard
              icon={<UserPlus size={20} />}
              title="Challenge a friend"
              sub="Private games"
              soon
              onClick={() => setSnack('Friend challenges are coming soon.')}
            />
          </Box>
        </Box>
      </Box>

      {/* "Searching" dialog */}
      <Dialog
        open={searching !== null}
        onClose={() => setSearch(null)}
        slotProps={{ paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: '16px', minWidth: 360 } } }}
      >
        <DialogContent sx={{ textAlign: 'center', pt: 4, pb: 2 }}>
          <Typography
            sx={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, letterSpacing: '0.14em', color: 'var(--accent)', textTransform: 'uppercase' }}
          >
            {searching}
          </Typography>
          <CircularProgress sx={{ color: 'var(--accent)', my: 3 }} />
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 19 }}>
            Finding an opponent…
          </Typography>
          <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5, mt: 1, maxWidth: 280, mx: 'auto' }}>
            {s.error ?? 'Hang tight while we match you with another player. Prefer not to wait? Play the computer instead.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'center', pb: 3, gap: 1 }}>
          <Button color="inherit" onClick={() => { gameSocket.cancelQueue(); setSearch(null) }} sx={{ color: 'var(--text-dim)' }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => navigate('/bot')}>
            Play the computer instead
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar
        open={snack !== null}
        autoHideDuration={3000}
        onClose={() => setSnack(null)}
        message={snack}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  )
}

function ResumeBanner({ game }: { game: LiveGameState }) {
  const navigate = useNavigate()
  const go = () => navigate(`/game/${game.id}`)
  return (
    <Box
      onClick={go}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.75,
        mb: { xs: 3, md: 3.5 },
        borderRadius: '14px',
        cursor: 'pointer',
        bgcolor: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)',
        transition: 'background 0.15s ease',
        '&:hover': { bgcolor: 'rgba(216,166,87,0.18)' },
      }}
    >
      <Box
        sx={{
          width: 38,
          height: 38,
          flexShrink: 0,
          borderRadius: '10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(216,166,87,0.18)',
          color: 'var(--accent)',
        }}
      >
        <Swords size={19} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography sx={{ fontWeight: 700, fontSize: 14.5, fontFamily: 'var(--font-display)' }}>
          You have a game in progress
        </Typography>
        <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
          vs {game.opponent.name} · {game.pool}
          {game.opponentOnline ? '' : ' · opponent disconnected'}
        </Typography>
      </Box>
      <Box
        component="button"
        onClick={(e) => { e.stopPropagation(); go() }}
        sx={{
          ml: 'auto',
          flexShrink: 0,
          height: 38,
          px: 2,
          cursor: 'pointer',
          fontFamily: 'var(--font-display)',
          fontSize: 14,
          fontWeight: 600,
          color: '#15171c',
          background: 'linear-gradient(180deg, #e3b56a, #d8a657)',
          border: '1px solid var(--accent)',
          borderRadius: '10px',
          '&:hover': { background: 'linear-gradient(180deg, #e7bd76, #dcab5d)' },
          '&:active': { transform: 'translateY(1px)' },
        }}
      >
        Resume
      </Box>
    </Box>
  )
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
        borderRadius: '16px',
        p: { xs: 2, md: 2.5 },
        boxShadow: '0 18px 50px -28px rgba(0,0,0,0.8)',
      }}
    >
      {children}
    </Box>
  )
}

function PanelHead({ title, sub }: { title: string; sub: string }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography sx={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>
        {title}
      </Typography>
      <Typography sx={{ fontSize: 13, color: 'var(--muted)', mt: 0.25 }}>{sub}</Typography>
    </Box>
  )
}

function TimeCell({ preset, onClick }: { preset: Preset; onClick: () => void }) {
  const { Icon, color } = CAT[preset.cat]
  return (
    <Box
      onClick={onClick}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        py: { xs: 2.5, md: 3 },
        bgcolor: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: '12px',
        cursor: 'pointer',
        overflow: 'hidden',
        transition: 'transform .12s ease, border-color .12s ease, background .12s ease',
        '&:hover': {
          transform: 'translateY(-2px)',
          borderColor: 'var(--accent-line)',
          bgcolor: 'var(--surface)',
        },
        // top accent wash in the category colour, on hover
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(ellipse 80% 60% at 50% 0%, ${color}22, transparent 70%)`,
          opacity: 0,
          transition: 'opacity .15s ease',
        },
        '&:hover::before': { opacity: 1 },
      }}
    >
      <Typography
        sx={{
          position: 'relative',
          fontFamily: 'var(--font-display)',
          fontSize: { xs: 25, md: 30 },
          fontWeight: 500,
          lineHeight: 1,
          letterSpacing: '-0.01em',
        }}
      >
        {preset.time}
      </Typography>
      <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 0.6 }}>
        <Box component="span" sx={{ display: 'flex', color }}>
          <Icon size={13} />
        </Box>
        <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)', fontWeight: 500 }}>{preset.cat}</Typography>
      </Box>
    </Box>
  )
}

function CustomCell({ onClick }: { onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        py: { xs: 2.5, md: 3 },
        border: '1px dashed var(--line)',
        borderRadius: '12px',
        cursor: 'pointer',
        color: 'var(--muted)',
        transition: 'color .12s ease, border-color .12s ease',
        '&:hover': { color: 'var(--accent)', borderColor: 'var(--accent-line)' },
      }}
    >
      <Typography sx={{ fontSize: { xs: 16, md: 17 }, fontWeight: 500 }}>Custom</Typography>
    </Box>
  )
}

function ModeCard({
  icon,
  title,
  sub,
  onClick,
  highlight,
  soon,
}: {
  icon: ReactNode
  title: string
  sub: string
  onClick: () => void
  highlight?: boolean
  soon?: boolean
}) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.5,
        borderRadius: '14px',
        cursor: 'pointer',
        bgcolor: 'var(--surface)',
        border: highlight ? '1px solid var(--accent-line)' : '1px solid var(--line-soft)',
        boxShadow: highlight ? '0 0 26px -10px rgba(216,166,87,0.55)' : 'none',
        transition: 'transform .12s ease, border-color .12s ease, background .12s ease',
        '&:hover': {
          transform: 'translateY(-2px)',
          borderColor: 'var(--accent-line)',
          bgcolor: 'var(--surface-2)',
          '& .mode-chevron': { color: 'var(--accent)', transform: 'translateX(2px)' },
        },
      }}
    >
      <Box
        sx={{
          width: 46,
          height: 46,
          flexShrink: 0,
          borderRadius: '12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: highlight ? 'var(--accent-soft)' : 'var(--surface-2)',
          border: '1px solid',
          borderColor: highlight ? 'var(--accent-line)' : 'var(--line)',
          color: 'var(--accent)',
        }}
      >
        {icon}
      </Box>
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography sx={{ fontWeight: 700, fontSize: 15.5, fontFamily: 'var(--font-display)' }}>{title}</Typography>
          {soon && (
            <Box
              sx={{
                px: 0.75,
                py: '1px',
                borderRadius: '5px',
                fontSize: 9.5,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--muted)',
                bgcolor: 'var(--surface-2)',
                border: '1px solid var(--line)',
              }}
            >
              Soon
            </Box>
          )}
        </Box>
        <Typography sx={{ fontSize: 12.5, color: 'var(--muted)', mt: 0.25 }}>{sub}</Typography>
      </Box>
      <Box
        className="mode-chevron"
        sx={{ display: 'flex', color: 'var(--text-dim)', flexShrink: 0, transition: 'color .12s, transform .12s' }}
      >
        <ChevronRight size={18} />
      </Box>
    </Box>
  )
}

function StatPill({ icon, value, label, pulse }: { icon: ReactNode; value?: number; label: string; pulse?: boolean }) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        borderRadius: '12px',
        bgcolor: 'var(--surface)',
        border: '1px solid var(--line-soft)',
      }}
    >
      <Box sx={{ position: 'relative', display: 'flex', color: 'var(--accent)' }}>
        {icon}
        {pulse && (
          <Box
            sx={{
              position: 'absolute',
              top: -2,
              right: -3,
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: '#7bb661',
              animation: 'hpulse 2s infinite',
              '@keyframes hpulse': {
                '0%': { boxShadow: '0 0 0 0 rgba(123,182,97,0.5)' },
                '70%': { boxShadow: '0 0 0 6px rgba(123,182,97,0)' },
                '100%': { boxShadow: '0 0 0 0 rgba(123,182,97,0)' },
              },
            }}
          />
        )}
      </Box>
      <Box sx={{ lineHeight: 1.1 }}>
        <Typography
          component="div"
          sx={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--text)' }}
        >
          {value != null ? value.toLocaleString() : '—'}
        </Typography>
        <Typography sx={{ fontSize: 11, color: 'var(--muted)' }}>{label}</Typography>
      </Box>
    </Box>
  )
}
