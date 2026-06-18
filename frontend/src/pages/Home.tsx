import { type ReactNode, useEffect, useState } from 'react'
import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  Snackbar,
  Typography,
} from '@mui/material'
import { Crown, Cpu, Swords, Trophy, UserPlus, Users, Zap } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { gameSocket, type LiveGameState } from '../lib/socket'
import { useGameSocket } from '../lib/useGameSocket'

// Quick-pairing presets (presentational for now — online play comes next).
interface Preset {
  time: string
  cat: string
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

const EVENTS = [
  { icon: <Trophy size={17} />, title: 'Daily Arena' },
  { icon: <Zap size={17} />, title: 'Hourly Bullet' },
  { icon: <Crown size={17} />, title: 'Weekend Blitz' },
]

export default function Home() {
  const navigate = useNavigate()
  const s = useGameSocket()
  const live = s.game
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

  return (
    <Box sx={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
      {/* Oversized faint knight watermark behind the grid */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <Box component="span" sx={{ fontSize: 'min(72vh, 740px)', lineHeight: 1, color: 'var(--text)', opacity: 0.02 }}>
          ♞
        </Box>
      </Box>

      {live && !live.ended && <ResumeBanner game={live} />}

      <Box
        sx={{
          position: 'relative',
          maxWidth: 1180,
          mx: 'auto',
          px: { xs: 2, md: 3 },
          py: { xs: 3, md: 5 },
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 300px', lg: '220px 1fr 300px' },
          gap: { xs: 3, md: 3.5 },
          alignItems: 'start',
        }}
      >
        {/* Left rail — events (placeholder) */}
        <Box sx={{ display: { xs: 'none', lg: 'block' } }}>
          <RailLabel>Tournaments</RailLabel>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {EVENTS.map((e) => (
              <Box
                key={e.title}
                onClick={() => setSnack('Tournaments are coming soon.')}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  p: 1.25,
                  borderRadius: 1.5,
                  cursor: 'pointer',
                  bgcolor: 'var(--surface)',
                  transition: 'background 0.12s ease',
                  '&:hover': { bgcolor: 'var(--surface-2)' },
                }}
              >
                <Box sx={{ color: 'var(--accent)', display: 'flex' }}>{e.icon}</Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.2 }}>{e.title}</Typography>
                  <Typography sx={{ fontSize: 11.5, color: 'var(--muted)' }}>Coming soon</Typography>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>

        {/* Center — tabs + quick pairing grid */}
        <Box sx={{ minWidth: 0 }}>
          <Box sx={{ display: 'flex', gap: 3, alignItems: 'center', borderBottom: '1px solid var(--line-soft)', mb: 2.25 }}>
            <Tab active>Quick pairing</Tab>
            <Tab onClick={() => setSnack('The lobby opens with online play — coming soon.')}>Lobby</Tab>
            <Tab onClick={() => setSnack('Correspondence games are coming soon.')}>Correspondence</Tab>
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.25 }}>
            {PRESETS.map((p) => (
              <Cell key={p.time + p.cat} onClick={() => queue(`${p.cat} · ${p.time}`, p.time)}>
                <Typography sx={{ fontSize: { xs: 26, md: 32 }, fontWeight: 300, lineHeight: 1, letterSpacing: '-0.01em' }}>
                  {p.time}
                </Typography>
                <Typography sx={{ mt: 0.75, fontSize: 13, color: 'var(--text-dim)' }}>{p.cat}</Typography>
              </Cell>
            ))}
            <Cell onClick={() => setSnack('Custom games are coming soon.')}>
              <Typography sx={{ fontSize: { xs: 18, md: 20 }, fontWeight: 500, color: 'var(--text-dim)' }}>Custom</Typography>
            </Cell>
          </Box>
        </Box>

        {/* Right rail — actions + counters */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          <Action icon={<Swords size={18} />} label="Create a game" onClick={() => setSnack('Custom game creation is coming soon — pick a time control above to play now.')} />
          <Action icon={<UserPlus size={18} />} label="Challenge a friend" onClick={() => setSnack('Friend challenges are coming soon.')} />
          <Action icon={<Cpu size={18} />} label="Play the computer" highlight onClick={() => navigate('/bot')} />

          <Box sx={{ mt: 2, px: 0.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
            <Counter icon={<Users size={15} />} value="1,204" label="players online" />
            <Counter icon={<Swords size={15} />} value="312" label="games in play" />
          </Box>
        </Box>
      </Box>

      {/* Optimistic "searching" dialog */}
      <Dialog
        open={search !== null}
        onClose={() => setSearch(null)}
        slotProps={{ paper: { sx: { bgcolor: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 3, minWidth: 340 } } }}
      >
        <DialogContent sx={{ textAlign: 'center', pt: 4, pb: 2 }}>
          <Typography
            sx={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, letterSpacing: '0.14em', color: 'var(--accent)', textTransform: 'uppercase' }}
          >
            {search}
          </Typography>
          <CircularProgress sx={{ color: 'var(--accent)', my: 3 }} />
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19 }}>
            Finding an opponent…
          </Typography>
          <Typography sx={{ color: 'var(--text-dim)', fontSize: 13.5, mt: 1, maxWidth: 280, mx: 'auto' }}>
            {s.error ?? 'Waiting for another player to join this pool. Open a second tab to test, or take on the engine.'}
          </Typography>
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'center', pb: 3, gap: 1 }}>
          <Button color="inherit" onClick={() => { gameSocket.cancelQueue(); setSearch(null) }} sx={{ color: 'var(--text-dim)' }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={() => navigate('/bot')}>
            Play a bot instead
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
    <Box sx={{ maxWidth: 1180, mx: 'auto', px: { xs: 2, md: 3 }, pt: { xs: 2.5, md: 3 } }}>
      <Box
        onClick={go}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          p: 1.5,
          borderRadius: 2,
          cursor: 'pointer',
          bgcolor: 'var(--accent-soft)',
          border: '1px solid var(--accent-line)',
          transition: 'background 0.12s ease',
          '&:hover': { bgcolor: 'rgba(216,166,87,0.18)' },
        }}
      >
        <Swords size={18} color="var(--accent)" />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>You have a game in progress</Typography>
          <Typography sx={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            vs {game.opponent.name} · {game.pool}
            {game.opponentOnline ? '' : ' · opponent disconnected'}
          </Typography>
        </Box>
        <Button
          variant="contained"
          size="small"
          sx={{ ml: 'auto', flexShrink: 0 }}
          onClick={(e) => {
            e.stopPropagation()
            go()
          }}
        >
          Resume
        </Button>
      </Box>
    </Box>
  )
}

function Cell({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'var(--surface)',
        borderRadius: 2,
        py: { xs: 3, md: 4 },
        cursor: 'pointer',
        transition: 'background 0.12s ease',
        '&:hover': { bgcolor: 'var(--surface-2)' },
      }}
    >
      {children}
    </Box>
  )
}

function Action({
  icon,
  label,
  onClick,
  highlight,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  highlight?: boolean
}) {
  return (
    <Box
      onClick={onClick}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1.25,
        borderRadius: 2,
        cursor: 'pointer',
        bgcolor: 'var(--surface)',
        border: highlight ? '1px solid var(--accent-line)' : '1px solid transparent',
        transition: 'background 0.12s ease',
        '&:hover': { bgcolor: 'var(--surface-2)' },
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 38,
          height: 38,
          borderRadius: 1.5,
          flexShrink: 0,
          bgcolor: highlight ? 'var(--accent-soft)' : 'var(--surface-2)',
          color: 'var(--accent)',
        }}
      >
        {icon}
      </Box>
      <Typography sx={{ fontWeight: 600, fontSize: 14.5 }}>{label}</Typography>
    </Box>
  )
}

function Counter({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'var(--muted)' }}>
      <Box sx={{ display: 'flex', color: 'var(--muted)' }}>{icon}</Box>
      <Typography sx={{ fontSize: 13.5 }}>
        <Box component="span" sx={{ color: 'var(--text)', fontWeight: 600 }}>
          {value}
        </Box>{' '}
        {label}
      </Typography>
    </Box>
  )
}

function Tab({ children, active, onClick }: { children: ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        pb: 1.25,
        cursor: 'pointer',
        fontSize: 14.5,
        fontWeight: 600,
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        mb: '-1px',
        transition: 'color 0.12s ease',
        '&:hover': { color: active ? 'var(--accent)' : 'var(--text)' },
      }}
    >
      {children}
    </Box>
  )
}

function RailLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'var(--muted)',
        mb: 1.25,
      }}
    >
      {children}
    </Typography>
  )
}
