import { useCallback, useEffect, useState } from 'react'
import { Box, Button, Typography } from '@mui/material'
import { Bot, Crown, Zap } from 'lucide-react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  getProfile,
  getProfileGames,
  type Profile as ProfileData,
  type ProfileGame,
  type RatingCategory,
} from '../api/client'
import { useAuth } from '../lib/auth'

const CATEGORIES: { key: RatingCategory; label: string }[] = [
  { key: 'bullet', label: 'Bullet' },
  { key: 'blitz', label: 'Blitz' },
  { key: 'rapid', label: 'Rapid' },
  { key: 'classical', label: 'Classical' },
]

type Outcome = 'win' | 'loss' | 'draw'

// The game result from the profiled player's own perspective + their rating
// swing (only meaningful on rated games, where before/after are populated).
function perspective(g: ProfileGame, userId: string): {
  outcome: Outcome
  color: 'White' | 'Black'
  opponent: string
  opponentBot: boolean
  delta: number | null
} {
  const isWhite = g.white_user_id === userId
  const color = isWhite ? 'White' : 'Black'
  const opponent = isWhite ? g.black_name : g.white_name
  const opponentBot = isWhite ? g.black_is_bot : g.white_is_bot

  let outcome: Outcome = 'draw'
  if (g.result === '1-0') outcome = isWhite ? 'win' : 'loss'
  else if (g.result === '0-1') outcome = isWhite ? 'loss' : 'win'

  const before = isWhite ? g.white_rating_before : g.black_rating_before
  const after = isWhite ? g.white_rating_after : g.black_rating_after
  const delta = before != null && after != null ? after - before : null

  return { outcome, color, opponent, opponentBot, delta }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function Profile() {
  const { name = '' } = useParams<{ name: string }>()
  const { user } = useAuth()
  const navigate = useNavigate()

  const [data, setData] = useState<ProfileData | null>(null)
  const [games, setGames] = useState<ProfileGame[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    getProfile(name)
      .then((p) => {
        if (cancelled) return
        setData(p)
        setGames(p.games)
        setHasMore(p.hasMore)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof ApiError && e.status === 404 ? 'Player not found' : (e as Error).message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [name])

  const loadMore = useCallback(() => {
    if (!data || loadingMore) return
    setLoadingMore(true)
    getProfileGames(data.name, games.length)
      .then((page) => {
        setGames((prev) => [...prev, ...page.games])
        setHasMore(page.hasMore)
      })
      .catch(() => {
        /* leave the list as-is on a transient error */
      })
      .finally(() => setLoadingMore(false))
  }, [data, games.length, loadingMore])

  if (loading) {
    return <Centered>Loading profile…</Centered>
  }
  if (error || !data) {
    return <Centered tone="error">{error ?? 'Profile unavailable'}</Centered>
  }

  const isSelf = user?.id === data.id
  const { wins, losses, draws, total } = data.record
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0

  return (
    <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', px: { xs: 1.5, md: 3 }, py: { xs: 2, md: 4 } }}>
      <Box sx={{ width: '100%', maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {/* Identity */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 1.5 }}>
          <Typography sx={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 30, letterSpacing: '-0.01em' }}>
            {data.name}
          </Typography>
          {data.role === 'admin' && (
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'var(--accent)' }}>
              <Crown size={15} />
              <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
                Admin
              </Typography>
            </Box>
          )}
          {isSelf && (
            <Typography sx={{ fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>this is you</Typography>
          )}
          <Box sx={{ flex: 1 }} />
          <Typography sx={{ fontSize: 12.5, color: 'var(--muted)' }}>
            Member since {fmtDate(data.created_at)}
          </Typography>
        </Box>

        {/* Record */}
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
          <RecordPill label="Games" value={total} />
          <RecordPill label="Wins" value={wins} color="#5b9e5b" />
          <RecordPill label="Losses" value={losses} color="#ca4a4a" />
          <RecordPill label="Draws" value={draws} color="var(--text-dim)" />
          <RecordPill label="Win rate" value={`${winRate}%`} color="var(--accent)" />
        </Box>

        {/* Ratings */}
        <Box>
          <SectionLabel>Ratings</SectionLabel>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(3, 1fr)', md: 'repeat(5, 1fr)' },
              gap: 1.25,
            }}
          >
            {CATEGORIES.map((c) => {
              const t = data.ratings[c.key]
              return (
                <RatingCard
                  key={c.key}
                  label={c.label}
                  rating={t.rating}
                  provisional={t.provisional}
                  sub={`${t.games} ${t.games === 1 ? 'game' : 'games'}`}
                />
              )
            })}
            <RatingCard
              label="Puzzles"
              icon={<Zap size={13} />}
              rating={data.puzzle.rating}
              provisional={data.puzzle.provisional}
              sub={`${data.puzzle.solved}/${data.puzzle.games} solved`}
              accent
            />
          </Box>
        </Box>

        {/* Game history */}
        <Box>
          <SectionLabel>Recent games</SectionLabel>
          {games.length === 0 ? (
            <Box
              sx={{
                p: 3,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13.5,
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                bgcolor: 'var(--surface)',
              }}
            >
              No games played yet.
            </Box>
          ) : (
            <Box
              sx={{
                border: '1px solid var(--line-soft)',
                borderRadius: '12px',
                overflow: 'hidden',
                bgcolor: 'var(--surface)',
              }}
            >
              {games.map((g, i) => (
                <GameRow
                  key={g.id}
                  game={g}
                  userId={data.id}
                  first={i === 0}
                  onClick={() => navigate(`/analysis/${g.id}`)}
                />
              ))}
            </Box>
          )}

          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 1.5 }}>
              <Button
                onClick={loadMore}
                disabled={loadingMore}
                variant="outlined"
                color="inherit"
                sx={{
                  textTransform: 'none',
                  borderColor: 'var(--line)',
                  color: 'var(--text-dim)',
                  '&:hover': { borderColor: 'var(--accent)', color: 'var(--accent)' },
                }}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  )
}

const OUTCOME_STYLE: Record<Outcome, { label: string; color: string }> = {
  win: { label: 'W', color: '#5b9e5b' },
  loss: { label: 'L', color: '#ca4a4a' },
  draw: { label: 'D', color: 'var(--text-dim)' },
}

function GameRow({
  game,
  userId,
  first,
  onClick,
}: {
  game: ProfileGame
  userId: string
  first: boolean
  onClick: () => void
}) {
  const { outcome, color, opponent, opponentBot, delta } = perspective(game, userId)
  const o = OUTCOME_STYLE[outcome]

  return (
    <Box
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: { xs: 1.5, md: 2 },
        py: 1.25,
        cursor: 'pointer',
        borderTop: first ? 'none' : '1px solid var(--line-soft)',
        transition: 'background .12s ease',
        '&:hover': { bgcolor: 'var(--line)' },
        outline: 'none',
        '&:focus-visible': { bgcolor: 'var(--line)' },
      }}
    >
      {/* Outcome chip */}
      <Box
        sx={{
          width: 26,
          height: 26,
          flexShrink: 0,
          borderRadius: '7px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 13,
          color: o.color,
          border: `1px solid ${o.color}`,
        }}
      >
        {o.label}
      </Box>

      {/* Opponent + meta */}
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            vs {opponent || 'Anonymous'}
          </Typography>
          {opponentBot && <Bot size={13} color="var(--muted)" />}
        </Box>
        <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', textTransform: 'capitalize' }}>
          {game.category || 'casual'} · {game.pool || '—'} · as {color}
          {!game.rated && ' · casual'}
        </Typography>
      </Box>

      {/* Rating delta */}
      {delta != null && game.rated && (
        <Typography
          sx={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            fontWeight: 600,
            color: delta > 0 ? '#5b9e5b' : delta < 0 ? '#ca4a4a' : 'var(--muted)',
          }}
        >
          {delta > 0 ? '+' : ''}
          {delta}
        </Typography>
      )}

      {/* Date */}
      <Typography sx={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'nowrap', minWidth: 64, textAlign: 'right' }}>
        {fmtDate(game.created_at)}
      </Typography>
    </Box>
  )
}

function RatingCard({
  label,
  rating,
  provisional,
  sub,
  icon,
  accent,
}: {
  label: string
  rating: number
  provisional: boolean
  sub: string
  icon?: React.ReactNode
  accent?: boolean
}) {
  return (
    <Box
      sx={{
        p: 1.5,
        borderRadius: '11px',
        border: '1px solid var(--line-soft)',
        bgcolor: accent ? 'var(--accent-soft)' : 'var(--surface)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: accent ? 'var(--accent)' : 'var(--muted)' }}>
        {icon}
        <Typography sx={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          {label}
        </Typography>
      </Box>
      <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, mt: 0.5, lineHeight: 1 }}>
        {rating}
        {provisional && <Box component="span" sx={{ color: 'var(--muted)', fontSize: 16 }}>?</Box>}
      </Typography>
      <Typography sx={{ fontSize: 11, color: 'var(--muted)', mt: 0.5 }}>{sub}</Typography>
    </Box>
  )
}

function RecordPill({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column' }}>
      <Typography sx={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 700, color: color ?? 'var(--text)', lineHeight: 1 }}>
        {value}
      </Typography>
      <Typography sx={{ fontSize: 10.5, color: 'var(--muted)', letterSpacing: '0.1em', textTransform: 'uppercase', mt: 0.4 }}>
        {label}
      </Typography>
    </Box>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--muted)', mb: 1.25 }}
    >
      {children}
    </Typography>
  )
}

function Centered({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 4 }}>
      <Typography sx={{ fontSize: 14, color: tone === 'error' ? '#ca4a4a' : 'var(--text-dim)' }}>{children}</Typography>
    </Box>
  )
}
