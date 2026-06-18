// Self-contained sound engine — short, soft "wooden" clicks synthesized with the
// Web Audio API (no external audio files, no licensing concerns). Tuned to feel
// close to Lichess: a crisp knock for moves, a duller thunk for captures, a small
// two-tone for check, etc. The AudioContext is created lazily on the first sound
// (which always follows a user gesture, satisfying autoplay policies).

let ctx: AudioContext | null = null
let master: GainNode | null = null
let enabled = readEnabled()

function readEnabled(): boolean {
  try {
    return localStorage.getItem('chessgo.sound') !== 'off'
  } catch {
    return true
  }
}

export function soundEnabled(): boolean {
  return enabled
}

export function setSoundEnabled(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem('chessgo.sound', on ? 'on' : 'off')
  } catch {
    /* ignore */
  }
}

function audio(): { c: AudioContext; out: GainNode } | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
    master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)
  }
  if (ctx.state === 'suspended') void ctx.resume()
  return { c: ctx, out: master! }
}

function noiseBuffer(c: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  return buf
}

interface Knock {
  freq: number
  dur?: number
  gain?: number
  noise?: number
  cutoff?: number
  type?: OscillatorType
  at?: number
}

// One percussive "knock": a quickly-decaying tone plus a brief filtered-noise
// transient — the combination reads as wood-on-wood.
function knock({ freq, dur = 0.12, gain = 0.16, noise = 0.16, cutoff = 2400, type = 'sine', at = 0 }: Knock): void {
  const a = audio()
  if (!a) return
  const { c, out } = a
  const t = c.currentTime + at

  const osc = c.createOscillator()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur)
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  osc.connect(g).connect(out)
  osc.start(t)
  osc.stop(t + dur + 0.02)

  if (noise > 0) {
    const src = c.createBufferSource()
    src.buffer = noiseBuffer(c, 0.03)
    const nf = c.createBiquadFilter()
    nf.type = 'lowpass'
    nf.frequency.value = cutoff
    const ng = c.createGain()
    ng.gain.setValueAtTime(noise, t)
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035)
    src.connect(nf).connect(ng).connect(out)
    src.start(t)
    src.stop(t + 0.05)
  }
}

function guard(fn: () => void): void {
  if (!enabled) return
  try {
    fn()
  } catch {
    /* never let audio break gameplay */
  }
}

export const sounds = {
  move: () => guard(() => knock({ freq: 300, dur: 0.1, gain: 0.14, noise: 0.13, cutoff: 2600 })),
  capture: () =>
    guard(() => {
      knock({ freq: 170, dur: 0.15, gain: 0.18, noise: 0.26, cutoff: 1500, type: 'triangle' })
      knock({ freq: 90, dur: 0.16, gain: 0.12, noise: 0, at: 0.005 })
    }),
  castle: () =>
    guard(() => {
      knock({ freq: 260, dur: 0.09, gain: 0.13, noise: 0.12 })
      knock({ freq: 240, dur: 0.1, gain: 0.13, noise: 0.12, at: 0.07 })
    }),
  check: () =>
    guard(() => {
      knock({ freq: 620, dur: 0.09, gain: 0.1, noise: 0.05, cutoff: 3200 })
      knock({ freq: 880, dur: 0.12, gain: 0.11, noise: 0, at: 0.08 })
    }),
  promote: () =>
    guard(() => {
      knock({ freq: 440, dur: 0.1, gain: 0.12, noise: 0.08 })
      knock({ freq: 660, dur: 0.14, gain: 0.12, noise: 0, at: 0.09 })
    }),
  end: () =>
    guard(() => {
      knock({ freq: 196, dur: 0.4, gain: 0.14, noise: 0.04, type: 'sine' })
      knock({ freq: 294, dur: 0.5, gain: 0.12, noise: 0, at: 0.04 })
      knock({ freq: 392, dur: 0.55, gain: 0.08, noise: 0, at: 0.08 })
    }),
}

/** Pick the right sound for a SAN string (after the move is on the board). */
export function playForSan(san: string, gameOver: boolean): void {
  if (gameOver) {
    sounds.end()
    return
  }
  if (san.startsWith('O-O')) sounds.castle()
  else if (san.includes('=')) sounds.promote()
  else if (san.includes('x')) sounds.capture()
  else sounds.move()
  if (san.includes('+')) setTimeout(() => sounds.check(), 90)
}

// Unlock audio on the first user gesture ANYWHERE in the app. Browsers create an
// AudioContext in a "suspended" state when it's first touched outside a gesture
// and won't play until resumed from one — so a sound driven purely by an event
// (an opponent/bot move arriving over WebSocket) would never be heard. Creating +
// resuming the context inside this listener primes it for all later sounds. The
// listener removes itself once the context is actually running.
if (typeof window !== 'undefined') {
  const unlock = () => {
    const a = audio() // creates + resumes within the gesture
    if (a && a.c.state === 'running') {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}
