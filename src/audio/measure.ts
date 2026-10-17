import { cfft, cifft } from 'fourier-transform'

export const ROUNDS = 3 // 目标设备发几声
export const PREROLL_MS = 150 // 录音开始后多久发第一声（这一声是热身）
/**
 * 相邻两声的间隔。只要保证两个峰不粘在一起（见 PEAK_MIN_SEP_MS）就够，
 * 跟设备的延迟没关系：回声的先后顺序就是发声的先后顺序，按顺序对应即可。
 */
export const PULSE_GAP_MS = 40
/** 最后一声之后还录多久：用来收最后一声的回声，也是能测到的最大整圈延迟 */
export const TAIL_MS = 800
const NCC_MIN = 0.3 // 匹配度下限，低于它视为没找到
const SILENCE = 0.003 // 约 -50 dBFS，低于它视为没有信号
/** 挑峰合并窗口：同一声的直达和紧跟着的反射并成一个峰（必须小于发声间隔） */
const PEAK_MIN_SEP_MS = 20
/**
 * 回声之间必须隔一个发声间隔，偏出这个容差的就不是回声（挡偏离的反射）。
 * 容差取 4 毫秒：实测蓝牙耳机那台峰位每次会抖 1.3～2.7 毫秒，原来的 2 毫秒跟抖动同量级，
 * 抖一下就整组作废；而实测反射晚到 11～17 毫秒，放大到 4 毫秒仍挡得住。
 */
const COMB_TOLERANCE_MS = 4
/** 明显弱于最强峰的候选当反射丢掉（实测直达 0.5~0.96、反射只有 0.26~0.33） */
const ECHO_STRENGTH_RATIO = 0.5

/** 一轮的结果：成功带 delay，失败带 error；ncc/index/db 尽量都给出来 */
interface RoundResult {
  delay?: number
  ncc?: number
  index?: number
  db?: number
  error?: string
}

/** 带轮次编号的结果，给界面用 */
export interface Round extends RoundResult {
  n: number
}

/** 要播放的一段声音：样本 + 在录音时间轴上的位置 */
export interface Sound {
  samples: Float32Array
  at: number
}

/** 12 毫秒的 2–6 kHz 扫频（Hann 窗），正式测试音 */
export function makePulse(sampleRate: number): Float32Array {
  const dur = 0.012
  const len = Math.floor(sampleRate * dur)
  const out = new Float32Array(len)
  let phase = 0
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate
    phase += (2 * Math.PI * (2000 + 4000 * (t / dur))) / sampleRate
    out[i] = Math.sin(phase) * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)))
  }
  return out
}

/**
 * 20 毫秒的 1 kHz 短音：只用来把音频链路（尤其蓝牙）唤醒。
 * 频段和正式测试音完全不重叠，所以它不会在相关结果里产生峰、也不会被算进回声数量。
 */
export function makeWarmup(sampleRate: number): Float32Array {
  const dur = 0.02
  const len = Math.floor(sampleRate * dur)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const window = 1 - Math.cos((2 * Math.PI * i) / (len - 1)) // Hann
    out[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * 0.4 * window
  }
  return out
}

const nextPow2 = (n: number): number => {
  let p = 1
  while (p < n) p <<= 1
  return p
}

/** 某一位置上的匹配度：那一段录音与参考有多像（1 = 完全一样，0 = 无关） */
function nccAt(rec: Float32Array, ref: Float32Array, i: number): number {
  let dot = 0
  let energy = 0
  let refEnergy = 0
  for (let j = 0; j < ref.length; j++) {
    const v = rec[i + j]
    dot += v * ref[j]
    energy += v * v
    refEnergy += ref[j] * ref[j]
  }
  if (!(energy > 0)) return -2
  return dot / Math.sqrt(energy * refEnergy)
}

/**
 * 整段互相关：结果里第 k 个数就是「回声出现在第 k 个采样处」的相似度。
 * 做法：录音段与参考各做一次正变换，逐点相乘（参考取共轭），再反变换。
 */
function correlate(rec: Float32Array, ref: Float32Array): Float64Array {
  const len = rec.length - ref.length + 1
  const N = nextPow2(rec.length + ref.length)
  const xre = new Float64Array(N)
  const xim = new Float64Array(N)
  const yre = new Float64Array(N)
  const yim = new Float64Array(N)
  for (let i = 0; i < rec.length; i++) xre[i] = rec[i]
  for (let i = 0; i < ref.length; i++) yre[i] = ref[i]

  cfft(xre, xim)
  cfft(yre, yim)
  const cre = new Float64Array(N)
  const cim = new Float64Array(N)
  for (let i = 0; i < N; i++) {
    cre[i] = xre[i] * yre[i] + xim[i] * yim[i] // X · conj(Y)
    cim[i] = xim[i] * yre[i] - xre[i] * yim[i]
  }
  cifft(cre, cim)

  // 更后面的属于绕回部分，不是真实位置
  return cre.subarray(0, len)
}

/** 挑峰：每段区间内取最大值，峰与峰至少隔 minSep（把直达和紧跟着的反射并成一个） */
function pickPeaks(c: Float64Array, minSep: number): number[] {
  const out: number[] = []
  let bestK = -1
  let bestV = -Infinity
  for (let k = 0; k < c.length; k++) {
    if (c[k] > bestV) {
      bestV = c[k]
      bestK = k
    }
    if (bestK >= 0 && k - bestK >= minSep) {
      out.push(bestK)
      bestK = -1
      bestV = -Infinity
    }
  }
  if (bestK >= 0) out.push(bestK)
  return out
}

/** 从候选峰里挑出真回声：真回声之间正好隔一个发声间隔，取能串起最多候选峰的那一串 */
function pickEchoComb(
  candidates: { index: number; ncc: number }[],
  interval: number,
  tolerance: number
): { index: number; ncc: number }[] {
  let best: { members: { index: number; ncc: number }[]; score: number } | null = null
  for (const anchor of candidates) {
    const members = candidates.filter((h) => {
      const gap = h.index - anchor.index
      return Math.abs(gap - Math.round(gap / interval) * interval) <= tolerance
    })
    const score = members.reduce((s, h) => s + h.ncc, 0)
    if (
      !best ||
      members.length > best.members.length ||
      (members.length === best.members.length && score > best.score)
    ) {
      best = { members, score }
    }
  }
  return (best?.members ?? []).slice().sort((a, b) => a.index - b.index)
}

/**
 * 分析一条「里面放了好几声」的录音。
 * 回声的先后顺序就是发声的先后顺序，所以第 i 个回声配第 i 声；
 * 数量必须和发声数一样，少一个或多一个（反射）都整组作废。
 */
export function analyzeTrain(
  rec: Float32Array,
  ref: Float32Array,
  emitAts: number[],
  sampleRate: number
): { rows: Round[]; error?: string } {
  if (!rec || rec.length < ref.length + 16)
    return { rows: [], error: '没听到回声，把音量调大一点再试' }

  let peak = 0
  for (let i = 0; i < rec.length; i++) {
    const a = Math.abs(rec[i])
    if (a > peak) peak = a
  }
  const db = 20 * Math.log10(peak + 1e-12)
  if (peak < SILENCE) {
    // 细节只进控制台，供排查用，不上界面
    console.log('[延迟] 信号过弱：峰值', db.toFixed(1), 'dBFS')
    const error = '声音太小，把音量调大一点再试'
    return { rows: emitAts.map((_, i) => ({ n: i + 1, error, db })), error }
  }

  const minSep = Math.round((PEAK_MIN_SEP_MS / 1000) * sampleRate)
  const candidates = pickPeaks(correlate(rec, ref), minSep)
    .map((index) => ({ index, ncc: nccAt(rec, ref, index) }))
    .filter((h) => h.ncc >= NCC_MIN)
  const strongest = candidates.reduce((s, h) => Math.max(s, h.ncc), 0)
  const strong = candidates.filter((h) => h.ncc >= strongest * ECHO_STRENGTH_RATIO)
  const interval = Math.round((PULSE_GAP_MS / 1000) * sampleRate)
  const echoes = pickEchoComb(strong, interval, Math.round((COMB_TOLERANCE_MS / 1000) * sampleRate))

  // 认出的回声必须和发声数一一对应：少一个或多一个（反射）都整组作废
  if (echoes.length !== emitAts.length) {
    console.log(
      '[延迟] 回声数量对不上：认出',
      echoes.length,
      '发',
      emitAts.length,
      '声；候选 ncc',
      candidates.map((h) => `${h.index}@${h.ncc.toFixed(2)}`).join(' ')
    )
    return { rows: [], error: '这次没收到全部回声，请再测一次' }
  }

  const rows: Round[] = echoes.map((h, i) => {
    const n = i + 1
    const delay = ((h.index - emitAts[i]) / sampleRate) * 1000
    const metrics = { ncc: h.ncc, index: h.index, db }
    if (!Number.isFinite(delay) || delay < 0 || delay > TAIL_MS) {
      return { n, error: `延迟超出范围（${delay.toFixed(0)} ms）`, ...metrics }
    }
    return { n, delay, ...metrics }
  })
  if (rows.some((r) => r.delay == null)) return { rows, error: '回声位置不对，再试一次' }

  return { rows }
}
