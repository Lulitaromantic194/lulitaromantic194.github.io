/**
 * Procedural Web Audio SFX for Viva Maya.
 *
 * Every sound is synthesized at runtime from oscillators, noise buffers, filters
 * and gain envelopes — the PWA ships ZERO audio assets and stays fully offline.
 * All calls are fire-and-forget and swallow errors: if the AudioContext is
 * unavailable the game simply runs silent, never throwing.
 */

const MUTE_KEY = 'viva-maya:muted'

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

function writeMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    // storage blocked (private mode / no DOM) — mute just won't persist
  }
}

interface ToneOpts {
  type: OscillatorType
  freq: number
  /** Exponential glide target reached at start+dur. */
  endFreq?: number
  peak: number
  dur: number
  attack?: number
  delay?: number
}

class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private started = false
  private _muted = false

  get muted(): boolean {
    return this._muted
  }

  /**
   * Attach the one-time autoplay-unlock listener and restore the persisted mute
   * flag. iOS/Chrome refuse to start audio without a user gesture, so we resume
   * (and lazily create) the context on the first real pointerdown — once, in the
   * capture phase so it runs before any game handler. Idempotent.
   */
  init(): void {
    if (this.started) return
    this.started = true
    this._muted = readMuted()
    const unlock = () => {
      const ctx = this.ensureContext()
      if (ctx && ctx.state === 'suspended') void ctx.resume()
      window.removeEventListener('pointerdown', unlock, true)
    }
    try {
      window.addEventListener('pointerdown', unlock, true)
    } catch {
      // no DOM (tests / SSR) — audio stays disabled, game runs fine
    }
  }

  toggleMuted(): boolean {
    this._muted = !this._muted
    writeMuted(this._muted)
    return this._muted
  }

  // ------------------------------------------------------------ audio graph

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      const ctx = new Ctor()
      const master = ctx.createGain()
      master.gain.value = 0.5
      // Gentle limiter so stacked cascade voices never clip harshly.
      const comp = ctx.createDynamicsCompressor()
      master.connect(comp)
      comp.connect(ctx.destination)
      this.ctx = ctx
      this.master = master
    } catch {
      this.ctx = null
      this.master = null
    }
    return this.ctx
  }

  /** Run a voice builder against a live, unmuted context. Never throws. */
  private voice(build: (ctx: AudioContext, t: number, out: AudioNode) => void): void {
    if (this._muted) return
    const ctx = this.ensureContext()
    if (!ctx || !this.master) return
    if (ctx.state === 'suspended') void ctx.resume()
    try {
      build(ctx, ctx.currentTime, this.master)
    } catch {
      // an effect must never break the game loop
    }
  }

  private getNoise(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      const len = Math.floor(ctx.sampleRate * 0.8)
      const buf = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buf
    }
    return this.noiseBuffer
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource()
    src.buffer = this.getNoise(ctx)
    return src
  }

  /** Enveloped oscillator with an optional exponential pitch glide. */
  private tone(ctx: AudioContext, out: AudioNode, t: number, o: ToneOpts): void {
    const start = t + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(o.freq, start)
    if (o.endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), start + o.dur)
    const g = ctx.createGain()
    const attack = o.attack ?? 0.006
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(o.peak, start + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, start + o.dur)
    osc.connect(g).connect(out)
    osc.start(start)
    osc.stop(start + o.dur + 0.02)
  }

  // ---------------------------------------------------------------- effects

  /** Soft UI click. */
  uiTap(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'triangle', freq: 620, endFreq: 430, peak: 0.32, dur: 0.07 })
    })
  }

  /** Filtered noise sweeping up — the swap "whoosh". */
  swapWhoosh(): void {
    this.voice((ctx, t, out) => {
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 0.9
      bp.frequency.setValueAtTime(420, t)
      bp.frequency.exponentialRampToValueAtTime(2600, t + 0.17)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.28, t + 0.04)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.22)
    })
  }

  /** Low damped thud plus a tiny click — the invalid snap-back. */
  invalidThud(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'sine', freq: 155, endFreq: 68, peak: 0.5, dur: 0.19, attack: 0.008 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 480
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.22, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.08)
    })
  }

  /**
   * Signature clear blip — a bright coin-like "ding" that rises one semitone per
   * cascade step (rate = 2^((cascade-1)/12)).
   */
  pop(cascade: number): void {
    this.voice((ctx, t, out) => {
      const rate = Math.pow(2, (Math.max(1, cascade) - 1) / 12)
      const base = 880 * rate
      // quick upward chirp with fast decay = coin flip
      this.tone(ctx, out, t, { type: 'triangle', freq: base, endFreq: base * 1.5, peak: 0.34, dur: 0.18 })
      // octave-up sine sparkle = casino "ding"
      this.tone(ctx, out, t, { type: 'sine', freq: base * 2, peak: 0.16, dur: 0.12 })
    })
  }

  /** Rising zipper/ratchet: a rapid tick train with an upward pitch ramp. */
  reelSweep(): void {
    this.voice((ctx, t, out) => {
      const ticks = 14
      for (let i = 0; i < ticks; i++) {
        this.tone(ctx, out, t, {
          type: 'square',
          freq: 300 + i * 92,
          peak: 0.11,
          dur: 0.014,
          attack: 0.002,
          delay: i * 0.02,
        })
      }
    })
  }

  /** Noise burst plus a 90->40Hz sine drop — the dice-bomb detonation (~350ms). */
  bombBoom(): void {
    this.voice((ctx, t, out) => {
      this.tone(ctx, out, t, { type: 'sine', freq: 90, endFreq: 40, peak: 0.6, dur: 0.3, attack: 0.01 })
      const src = this.noiseSource(ctx)
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.setValueAtTime(1800, t)
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.3)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.5, t)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32)
      src.connect(lp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.34)
    })
  }

  /** Dramatic two-tone siren wail with a bell on top — the jackpot strike (~900ms). */
  jackpotStrike(): void {
    this.voice((ctx, t, out) => {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      const lo = 520
      const hi = 1040
      osc.frequency.setValueAtTime(lo, t)
      osc.frequency.linearRampToValueAtTime(hi, t + 0.22)
      osc.frequency.linearRampToValueAtTime(lo, t + 0.44)
      osc.frequency.linearRampToValueAtTime(hi, t + 0.66)
      osc.frequency.linearRampToValueAtTime(lo, t + 0.88)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = 900
      bp.Q.value = 1.3
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.26, t + 0.05)
      g.gain.setValueAtTime(0.26, t + 0.8)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9)
      osc.connect(bp).connect(g).connect(out)
      osc.start(t)
      osc.stop(t + 0.92)
      // shimmering bell over the wail
      this.tone(ctx, out, t, { type: 'sine', freq: 1568, peak: 0.16, dur: 0.5, attack: 0.02 })
    })
  }

  /** i-th of three ascending bell dings, played per win star. */
  starDing(i: number): void {
    this.voice((ctx, t, out) => {
      const freqs = [1046.5, 1318.5, 1568.0] // C6 E6 G6
      const f = freqs[Math.max(0, Math.min(freqs.length - 1, i))]
      this.tone(ctx, out, t, { type: 'sine', freq: f, peak: 0.34, dur: 0.42, attack: 0.005 })
      this.tone(ctx, out, t, { type: 'sine', freq: f * 2.01, peak: 0.11, dur: 0.28, attack: 0.005 })
    })
  }

  /** Short rising major arpeggio with a shimmer tail — the win fanfare (~1.2s). */
  winFanfare(): void {
    this.voice((ctx, t, out) => {
      const notes = [523.25, 659.25, 783.99, 1046.5] // C5 E5 G5 C6
      notes.forEach((f, i) => {
        const delay = i * 0.12
        this.tone(ctx, out, t, { type: 'triangle', freq: f, peak: 0.3, dur: 0.5, attack: 0.02, delay })
        this.tone(ctx, out, t, { type: 'sine', freq: f * 2, peak: 0.1, dur: 0.3, attack: 0.02, delay })
      })
      // sustained sparkle chord to close it out
      const tail = notes.length * 0.12
      for (const f of [1046.5, 1318.5, 1568.0]) {
        this.tone(ctx, out, t, { type: 'sine', freq: f, peak: 0.11, dur: 0.7, attack: 0.05, delay: tail })
      }
    })
  }

  /** Two-note descending "wah-wah" — the lose sting (~700ms). */
  loseWah(): void {
    this.voice((ctx, t, out) => {
      const notes = [
        { f: 311.13, at: t }, // Eb4
        { f: 261.63, at: t + 0.34 }, // C4
      ]
      for (const { f, at } of notes) {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.setValueAtTime(f, at)
        osc.frequency.linearRampToValueAtTime(f * 0.94, at + 0.3) // droop
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.setValueAtTime(1200, at)
        lp.frequency.exponentialRampToValueAtTime(480, at + 0.3) // "wah" close
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, at)
        g.gain.exponentialRampToValueAtTime(0.3, at + 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.33)
        osc.connect(lp).connect(g).connect(out)
        osc.start(at)
        osc.stop(at + 0.35)
      }
    })
  }

  /** Soft swirling filtered noise — the board reshuffle. */
  reshuffleSwirl(): void {
    this.voice((ctx, t, out) => {
      const src = this.noiseSource(ctx)
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.Q.value = 3
      bp.frequency.setValueAtTime(600, t)
      bp.frequency.linearRampToValueAtTime(1500, t + 0.2)
      bp.frequency.linearRampToValueAtTime(560, t + 0.42)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.24, t + 0.08)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.44)
      src.connect(bp).connect(g).connect(out)
      src.start(t)
      src.stop(t + 0.46)
    })
  }
}

/** Shared singleton — import and call from any scene. */
export const sfx = new Sfx()

// Attach the autoplay-unlock listener as soon as the module loads.
if (typeof window !== 'undefined') sfx.init()
