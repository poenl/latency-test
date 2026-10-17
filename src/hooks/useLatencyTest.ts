import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ensureRunningContext,
  getContext,
  isPermissionDenied,
  listInputs,
  listOutputs,
  openMic,
  queryMicPermission,
  requestMicPermission,
  watchMicPermission
} from '@/audio/devices'
import type { DeviceOption } from '@/audio/devices'
import {
  PREROLL_MS,
  PULSE_GAP_MS,
  ROUNDS,
  TAIL_MS,
  analyzeTrain,
  makePulse,
  makeWarmup
} from '@/audio/measure'
import type { Round, Sound } from '@/audio/measure'
// 以资源形式拿到 worklet 的地址（vite 会把它单独产出一个文件，不内联）
import workletUrl from '@/audio/capture-processor.js?url'

/** 校准允许的极差：超过就当这次校准不稳（内置设备同一轮差不到 2ms，无线设备会到 ±20ms） */
const CALIBRATION_SPREAD_MS = 10
/** 校准时发几声 */
const CALIBRATION_PULSES = 3
/** 复核时发几声 */
const CHECK_PULSES = 1
/** 复核与基准允许差多少毫秒：切输出设备本身就会让链路状态变一点（实测 1.7 毫秒），
 * 所以要放过这个量级；但系统换设备 IO 缓冲的最小幅度是 5.33 毫秒，必须能抓住。 */
const CHECK_TOLERANCE_MS = 3.5
/** 录音总长：热身一声 + 正式那几声，最后一声之后再留 TAIL_MS 收回声 */
const recordMsFor = (pulses: number) => Math.round(PREROLL_MS + pulses * PULSE_GAP_MS + TAIL_MS)

/**
 * 校准记录：基准值 + 校准时用的是哪台输出设备。
 * 复核必须回到同一台设备上做，否则两个数不在同一条链路上（系统会改设备 IO 缓冲，整圈延迟会整体平移）。
 * 只存在内存里：刷新页面就作废，因为那条链路状态会变。
 */
export interface Calibration {
  delay: number
  outputId: string
  outputLabel: string
}

/** 当前在跑哪一段 */
export type Phase = 'idle' | 'calibrate' | 'target' | 'check'

/** 结果汇总：没测到有效数据时中位数是 null；spread 是最大减最小，用来看这次稳不稳 */
interface Summary {
  median: number | null
  spread: number
}

/** 把每轮结果汇总成中位数与极差 */
function summarize(rows: Round[]): Summary {
  const values = rows
    .filter((r) => !r.error && r.delay != null)
    .map((r) => r.delay as number)
    .sort((a, b) => a - b)
  const n = values.length
  if (!n) return { median: null, spread: 0 }
  const median = n % 2 ? values[(n - 1) / 2] : (values[n / 2 - 1] + values[n / 2]) / 2
  return { median, spread: values[n - 1] - values[0] }
}

/** 一次录音的结果；aborted 表示这次是被中止的（不当作失败报错） */
interface SegmentResult {
  rows: Round[]
  error?: string
  aborted?: boolean
}

/** 打开麦克风时才发现权限被撤：界面已由权限态统一交代，上层不再叠一条「出错：」 */
class PermissionDeniedError extends Error {}

/**
 * 可选的输出：校准那台（基准）不再给选——测试要选的是别的设备。
 * 选择推演与界面渲染共用这一份推导，避免两边各过滤一次。
 */
function selectableOutputsOf(outs: DeviceOption[], cal: Calibration | null) {
  return cal ? outs.filter((d) => d.deviceId !== cal.outputId) : outs
}

// worklet 只要注册成功一次就够
let workletReady = false

/**
 * 测量流程的全部状态与动作。
 * 音频资源（上下文、工作节点、麦克风流）放在 ref 里：它们不参与渲染，也不能被重建。
 * 输入设备一旦开流就固定下来（整场测量只用它），换它等于换了链路，基准要作废。
 */
export function useLatencyTest() {
  const [outputs, setOutputs] = useState<DeviceOption[]>([])
  const [inputs, setInputs] = useState<DeviceOption[]>([])
  const [outputId, setOutputId] = useState('')
  const [inputId, setInputIdState] = useState('')
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  /** 净延迟：目标设备减掉基准，也就是"这台设备比基准多出来多少" */
  const [netMedian, setNetMedian] = useState<number | null>(null)
  /** 校准记录；为 null = 还没校准，界面上只给"开始校准" */
  const [calibration, setCalibration] = useState<Calibration | null>(null)
  /** 麦克风权限被浏览器拦下：列表读不到、什么也做不了，界面此刻只交代权限这一件事 */
  const [micBlocked, setMicBlocked] = useState(false)

  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const sinkIdRef = useRef('')
  /** 当前这条麦克风流对应哪支输入设备 */
  const streamInputRef = useRef<string | null>(null)
  /** 输入设备的当前值；ensureMic 要用它，但不能靠 state */
  const inputIdRef = useRef('')
  /** 输出设备的当前值；devicechange 的监听拥一次，闭包里的 state 是旧的，从这里读最新的 */
  const outputIdRef = useRef('')
  /** 校准记录的镜像；同上 */
  const calibrationRef = useRef<Calibration | null>(null)
  /** 正在等结果的这一次录音的收尾函数；中止时直接调它 */
  const finishRef = useRef<((r: SegmentResult) => void) | null>(null)

  // 把这两份 state 同步进 ref，供装一次的 devicechange 回调用
  useEffect(() => {
    outputIdRef.current = outputId
  }, [outputId])
  useEffect(() => {
    calibrationRef.current = calibration
  }, [calibration])

  /**
   * 进权限态：麦克风被浏览器拦住，列表也读不到——清掉列表、记下这个状态。
   * 选中值与基准不动：权限恢复后还是同一套设备，不该为了一次授权让人重新校准。
   */
  const enterPermissionState = useCallback(() => {
    setMicBlocked(true)
    setOutputs([])
    setInputs([])
    setError('')
  }, [])

  /** 中止当前测量：停止按钮、麦克风断开、权限被撤都走这里 */
  const abort = useCallback(() => {
    finishRef.current?.({ rows: [], aborted: true })
  }, [])

  /**
   * 设备选择推演的唯一归属：列表变了之后，选中值此刻该是什么，只在这里算。
   * 规则：没选过而可选列表只剩一台 → 自动选中；选中的被拔掉 → 换另一台可选的；
   * 选中的还在、只是退出了可选列表（校准那台）→ 退回没选过，再看「只剩一台」那条。
   * 入口（首屏 / 插拔 / 重新校准 / 校准完成）只触发，不实现规则；用户手动选不走这里（意志优先）。
   * cal 传参是为了校准刚完成那次：那时基准刚换，ref 里的还是旧值。
   */
  function syncSelection(outs: DeviceOption[], ins: DeviceOption[], cal = calibrationRef.current) {
    // 校准完基准那台就退出了：测试列表跟校准列表适用同一套规则，只剩一台就自动选中
    const selectable = selectableOutputsOf(outs, cal)

    // 选中的输出从完整表里整个没了（拔了）：换另一台可选的
    const prevOut = outputIdRef.current
    if (prevOut && !outs.some((d) => d.deviceId === prevOut)) {
      const next = selectable[0]?.deviceId ?? ''
      outputIdRef.current = next
      setOutputId(next)
      // 基准那台整个没了：两条链路对不上，基准作废（拿完整表判，基准本来就不在可选列表里）
      if (cal && !outs.some((d) => d.deviceId === cal.outputId)) {
        setCalibration(null)
        setNetMedian(null)
        setError('基准设备断开了，请重新校准')
      }
    }

    // 选中的还在，只是不再可选（就是刚校准完那台）：退回没选过
    if (outputIdRef.current && !selectable.some((d) => d.deviceId === outputIdRef.current)) {
      outputIdRef.current = ''
      setOutputId('')
    }

    // 没选过、而可选列表只剩一台：就选中这台（首屏单设备也直接可用）
    if (!outputIdRef.current && selectable.length === 1) {
      outputIdRef.current = selectable[0].deviceId
      setOutputId(selectable[0].deviceId)
    }

    // 输入没有「可选列表」这回事（列表不过滤）。没选过、而只剩一支、且还没校准
    // （已校准时换麦等于换链路，不替人拿主意）→ 自动选中
    if (!inputIdRef.current && ins.length === 1 && !cal) {
      inputIdRef.current = ins[0].deviceId
      setInputIdState(ins[0].deviceId)
    }

    // 之前选的输入不在了（拔掉了）：自动换另一支，并作废基准（换麦等于换链路）
    if (inputIdRef.current && !ins.some((d) => d.deviceId === inputIdRef.current)) {
      const next = ins[0]?.deviceId ?? ''
      inputIdRef.current = next
      setInputIdState(next)
      setCalibration(null)
      setNetMedian(null)
      setError('麦克风断开了，请重新校准')
    }
  }

  // 只碰 ref 与稳定的 setState，依赖为空：身份稳定，供装一次的监听与触发入口复用
  const loadDevices = useCallback(async () => {
    const [outs, ins] = await Promise.all([listOutputs(), listInputs()])
    setOutputs(outs)
    setInputs(ins)
    syncSelection(outs, ins)
  }, [])

  /** 刚打开页面：先确认权限，拿到了才去读设备列表 */
  async function refreshDevices() {
    try {
      const before = await queryMicPermission()
      if (before === 'blocked') {
        enterPermissionState()
        return
      }
      // 还没问过（或这台浏览器查不了）就去要一次
      if (before !== 'granted') await requestMicPermission()
      // 要完再查一次：区分「被浏览器拦下」和「用户把弹窗关掉/没理」
      if ((await queryMicPermission()) === 'blocked') {
        enterPermissionState()
        return
      }
      setMicBlocked(false)
      await loadDevices()
      ctxRef.current = getContext()
    } catch (e) {
      if (isPermissionDenied(e)) {
        enterPermissionState()
        return
      }
      setError('获取设备失败：' + (e as Error).message)
    }
  }

  /** 权限态下设备按钮的动作：再要一次权限，拿到就回到正常流程 */
  function retryPermission() {
    refreshDevices().catch(() => {})
  }

  // 插拔设备、系统切换默认设备时刷新列表：权限不在手就不读（插拔不该弹授权窗）
  useEffect(() => {
    const onDeviceChange = () => {
      queryMicPermission().then((state) => {
        // unknown = 这台浏览器查不了权限，只能照旧直接读
        if (state === 'granted' || state === 'unknown') loadDevices().catch(() => {})
      })
    }
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange)
  }, [loadDevices])

  // 权限在运行中被撤掉（或在地址栏里又允许了）：跟着更新权限态，正在跑的那一次作废
  useEffect(() => {
    let undo: (() => void) | null = null
    let alive = true
    const onPermissionChange = () => {
      queryMicPermission().then((state) => {
        if (!alive) return
        if (state === 'blocked') {
          abort()
          enterPermissionState()
        } else if (state === 'granted') {
          // 在地址栏把权限改回来：权限态解除，同时把列表读回来（否则会停在「无可用设备」）
          setMicBlocked(false)
          loadDevices().catch(() => {})
        }
      })
    }
    watchMicPermission(onPermissionChange).then((fn) => {
      // 挂监听期间组件就卸载了：立刻摘掉
      if (alive) undo = fn
      else fn()
    })
    return () => {
      alive = false
      undo?.()
    }
  }, [abort, enterPermissionState, loadDevices])

  async function ensureWorklet(audio: AudioContext) {
    if (workletReady) return
    // AudioWorklet 必须是真实文件地址（data: 形式不可靠）
    await audio.audioWorklet.addModule(workletUrl)
    workletReady = true
  }

  /** 停掉麦克风流与它的采集节点 */
  function teardownMic() {
    sourceRef.current?.disconnect()
    sourceRef.current = null
    streamRef.current?.getTracks().forEach((t) => {
      t.removeEventListener('ended', onMicEnded)
      t.stop()
    })
    streamRef.current = null
    streamInputRef.current = null
  }

  /** 麦克风被拔掉或被别的程序抢走：中止当前测量并提示 */
  function onMicEnded() {
    teardownMic()
    finishRef.current?.({ rows: [], aborted: true })
    // 先分辨是权限被撤还是麦真断了：权限被撤时不报「麦克风断开」，那会指错方向
    queryMicPermission().then((state) => {
      if (state === 'blocked') {
        enterPermissionState()
        return
      }
      setError('麦克风断开了，重新插好再试')
    })
  }

  /** 打开麦克风；指定的输入设备变了就重开流（整场测量只用一支麦克风） */
  async function ensureMic(audio: AudioContext, wanted: string) {
    if (streamRef.current && streamInputRef.current === wanted) return // 同一支就复用

    if (streamRef.current) teardownMic()

    let stream: MediaStream
    try {
      stream = await openMic(wanted || undefined)
    } catch (e) {
      // 权限被撤时这里会被拒：进权限态，并让上层别再报一条
      if (!isPermissionDenied(e)) throw e
      enterPermissionState()
      throw new PermissionDeniedError()
    }
    streamRef.current = stream
    streamInputRef.current = wanted
    stream.getAudioTracks().forEach((t) => t.addEventListener('ended', onMicEnded))

    await ensureWorklet(audio)

    if (!nodeRef.current) {
      nodeRef.current = new AudioWorkletNode(audio, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
      // 输出通路兼作发声；worklet 只写发声窗口，不会把麦克风回放出来
      const passThrough = audio.createGain()
      passThrough.gain.value = 1
      nodeRef.current.connect(passThrough).connect(audio.destination)
    }
    sourceRef.current = audio.createMediaStreamSource(stream)
    sourceRef.current.connect(nodeRef.current)
  }

  async function applyOutput(audio: AudioContext, sink: string) {
    if (sink === sinkIdRef.current) return // 只在换了设备时设置一次
    // setSinkId 还没进标准 DOM 类型，这里按可选能力处理
    const withSink = audio as AudioContext & { setSinkId?: (id: string) => Promise<void> }
    if (typeof withSink.setSinkId !== 'function') return
    try {
      await withSink.setSinkId(sink)
      sinkIdRef.current = sink
    } catch (e) {
      setError('切换输出设备失败：' + (e as Error).message)
    }
  }

  /** 准备音频链路：上下文、麦克风、录音节点、测试音 */
  async function initAudio() {
    const audio = await ensureRunningContext()
    ctxRef.current = audio
    await ensureMic(audio, inputIdRef.current)

    const node = nodeRef.current
    if (!node) throw new Error('录音节点未就绪')

    const refData = makePulse(audio.sampleRate)
    await new Promise((r) => setTimeout(r, 400)) // 给链路一点稳定时间
    return { audio, node, refData }
  }

  /** 录一段：里面按固定间隔放好几段声音，停止后整段拿回来分析 */
  function recordSegment(
    node: AudioWorkletNode,
    sounds: Sound[],
    refData: Float32Array,
    emitAts: number[],
    recordMs: number,
    sampleRate: number
  ): Promise<SegmentResult> {
    return new Promise((resolve) => {
      let done = false
      const timers: number[] = []
      const finish = (r: SegmentResult) => {
        if (done) return
        done = true
        timers.forEach((t) => clearTimeout(t))
        node.port.onmessage = null
        finishRef.current = null
        resolve(r)
      }
      // 中止（停止按钮 / 麦克风掉了）时立刻收尾，不等超时
      finishRef.current = finish

      // 注意：samples 的 buffer 会被转移（转移后本地 length 变 0），所以先把长度记下来
      const expected = sounds.map((s) => s.samples.length)
      node.port.onmessage = (e: MessageEvent) => {
        const d = e.data as
          { type: 'data'; buffer: Float32Array; sampleRate: number; emitted: number[] } | undefined
        if (!d || d.type !== 'data') return
        const emitted = d.emitted ?? []
        if (emitted.length !== expected.length || emitted.some((n, i) => n !== expected[i])) {
          finish({ rows: [], error: '播放没成功，再试一次' })
          return
        }
        finish(analyzeTrain(d.buffer, refData, emitAts, sampleRate))
      }

      node.port.postMessage(
        { type: 'start', sounds },
        sounds.map((s) => s.samples.buffer)
      )
      timers.push(window.setTimeout(() => node.port.postMessage({ type: 'stop' }), recordMs))
      timers.push(
        window.setTimeout(
          () => finish({ rows: [], error: '没听到回声，把音量调大一点再试' }),
          recordMs + 1500
        )
      )
    })
  }

  /**
   * 跑一段：切到指定输出设备，录一段里面发 pulses 声，返回中位数。
   */
  async function runSegment(
    node: AudioWorkletNode,
    refData: Float32Array,
    sampleRate: number,
    sink: string,
    pulses: number
  ): Promise<{
    median: number | null
    /** 极差：同一段里的多次读数差多少 */
    spread: number
    rows: Round[]
    error?: string
    aborted?: boolean
  }> {
    const audio = ctxRef.current
    if (audio) await applyOutput(audio, sink)

    const at = (ms: number) => Math.round((ms / 1000) * sampleRate)
    // 第一声是热身（另一个频段的短音），之后才是正式的几声
    const emitAts = Array.from({ length: pulses }, (_, i) =>
      at(PREROLL_MS + (i + 1) * PULSE_GAP_MS)
    )
    const sounds: Sound[] = [
      { samples: makeWarmup(sampleRate), at: at(PREROLL_MS) },
      ...emitAts.map((emitAt) => ({ samples: refData.slice(), at: emitAt }))
    ]

    const res = await recordSegment(node, sounds, refData, emitAts, recordMsFor(pulses), sampleRate)
    if (res.aborted) return { median: null, spread: 0, rows: [], aborted: true }
    // 每轮明细（序号 / 延迟 / index）只进控制台，界面上一律不显示
    if (res.rows.length) {
      console.log(
        '[延迟]',
        res.rows
          .map(
            (r) =>
              `${r.n}:${r.error ?? `${r.delay?.toFixed(2)}ms`}${r.index != null ? `@${r.index}` : ''}`
          )
          .join(' · ')
      )
    }
    if (res.error)
      return { median: null, spread: summarize(res.rows).spread, rows: res.rows, error: res.error }
    const { median, spread } = summarize(res.rows)
    return { median, spread, rows: res.rows }
  }

  /** 校准：用当前选中的那台设备发几声，得到基准 */
  async function runCalibration() {
    // 没选过设备（按钮此时是禁用的）也再挡一道
    if (running || !outputId) return
    setRunning(true)
    setNetMedian(null)
    setError('')

    try {
      const { audio, node, refData } = await initAudio()
      setPhase('calibrate')
      const res = await runSegment(node, refData, audio.sampleRate, outputId, CALIBRATION_PULSES)
      if (res.aborted) return
      if (res.median == null) {
        setError(res.error ?? '校准失败，把音量调大一点再试')
        return
      }
      // 三次读数差得太多说明这次校准不稳，宁可让用户重来
      if (res.spread > CALIBRATION_SPREAD_MS) {
        setError('本次校准偏差较大，建议重新校准。')
        return
      }
      const option = outputs.find((d) => d.deviceId === outputId) ?? outputs[0]
      const cal = { delay: res.median, outputId, outputLabel: option?.label ?? '当前设备' }
      setCalibration(cal)
      // 基准这台从此退出可选列表：把选中值重推一遍——只剩一台可测就自动选中，多台就留空等人挑
      syncSelection(outputs, inputs, cal)
    } catch (e) {
      // 权限类的失败已由权限态统一交代，这里不再叠一条
      if (e instanceof PermissionDeniedError) return
      setError('出错：' + (e as Error).message)
    } finally {
      setRunning(false)
      setPhase('idle')
    }
  }

  /** 清掉校准记录并回到第一步：输出、输入都归零，再从设备列表入口走一遍推演 */
  function recalibrate() {
    setCalibration(null)
    setNetMedian(null)
    setError('')
    // 顺序关键：先归零，syncSelection 的「单设备自动选」才看得到没选过
    outputIdRef.current = ''
    setOutputId('')
    inputIdRef.current = ''
    setInputIdState('')
    // 读列表前先确认权限在手；不在手就直接进权限态，不再去读
    queryMicPermission().then((state) => {
      if (state === 'blocked') {
        enterPermissionState()
        return
      }
      loadDevices().catch(() => {})
    })
  }

  /**
   * 换输入设备。整场测量只用一支麦克风，换它等于换了链路，基准跟着作废。
   */
  function setInputId(id: string) {
    if (id === inputIdRef.current) return
    inputIdRef.current = id
    setInputIdState(id)
    setCalibration(null)
    setNetMedian(null)
    setError('')
  }

  /**
   * 测量：目标设备发几声 → 回到基准那台设备做复核。
   * 复核对不上就重测一次；还不行就提示重新校准，不给数字。
   */
  async function runTest() {
    if (running || !calibration) return
    setRunning(true)
    setNetMedian(null)
    setError('')

    try {
      const { audio, node, refData } = await initAudio()
      // 复核必须在校准时那台设备上做，否则两个数不在同一条链路上
      if (!outputs.some((d) => d.deviceId === calibration.outputId)) {
        setError('校准时用的设备不在了，请重新校准')
        return
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        setPhase('target')
        const target = await runSegment(node, refData, audio.sampleRate, outputId, ROUNDS)
        if (target.aborted) return

        setPhase('check')
        const check = await runSegment(
          node,
          refData,
          audio.sampleRate,
          calibration.outputId,
          CHECK_PULSES
        )
        if (check.aborted) return

        if (target.median == null) {
          setError(target.error ?? '测量失败，再试一次')
          return
        }
        if (check.median == null) {
          setError(check.error ?? '复核没测到，请再试一次')
          return
        }
        if (Math.abs(check.median - calibration.delay) > CHECK_TOLERANCE_MS) {
          if (attempt === 0) continue // 中途链路变了，再测一次
          setNetMedian(null)
          setError('链路不稳定，请重新校准')
          return
        }

        setNetMedian(target.median - calibration.delay)
        return
      }
    } catch (e) {
      // 权限类的失败已由权限态统一交代，这里不再叠一条
      if (e instanceof PermissionDeniedError) return
      setError('出错：' + (e as Error).message)
    } finally {
      setRunning(false)
      setPhase('idle')
    }
  }

  /** 界面要渲染的输出列表＝可选的输出列表（与推演同一份推导） */
  const selectableOutputs = selectableOutputsOf(outputs, calibration)

  return {
    outputs,
    selectableOutputs,
    inputs,
    outputId,
    inputId,
    setOutputId,
    setInputId,
    error,
    micBlocked,
    running,
    phase,
    netMedian,
    calibration,
    refreshDevices,
    retryPermission,
    runCalibration,
    runTest,
    recalibrate,
    abort
  }
}
