// 音频上下文与设备：只负责"拿到上下文 / 拿到设备 / 拿到麦克风流"
let audioContext: AudioContext | null = null

export function getContext(): AudioContext {
  if (!audioContext) audioContext = new AudioContext({ latencyHint: 'interactive' })
  return audioContext
}

/** 浏览器要求先有用户交互才允许处理音频，所以这里要等 resume 完成 */
export async function ensureRunningContext(): Promise<AudioContext> {
  const ctx = getContext()
  if (ctx.state !== 'running') await ctx.resume()
  return ctx
}

/** 先要一次权限，之后才能拿到设备名字 */
export async function requestMicPermission(): Promise<void> {
  const tmp = await navigator.mediaDevices.getUserMedia({ audio: true })
  tmp.getTracks().forEach((t) => t.stop())
}

/**
 * 麦克风权限的当前情况：granted 已经拿到 / blocked 被浏览器拦下 / unknown 不确知（还没问过，或这台浏览器查不了）。
 * 调用方只在「不确知」时才去要一次权限。
 */
export type MicPermission = 'granted' | 'blocked' | 'unknown'

/** 查当前的麦克风权限。只是查询，不弹窗。 */
export async function queryMicPermission(): Promise<MicPermission> {
  // 有的浏览器没有 permissions.query（Safari 对麦克风这一项也没实测到）：只能靠“要一次看结果”
  if (typeof navigator.permissions?.query !== 'function') return 'unknown'
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    if (status.state === 'granted') return 'granted'
    return status.state === 'denied' ? 'blocked' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 监听麦克风权限变化（在地址栏里撤掉或恢复）。
 * 查询不可用的浏览器拿不到变化事件，这时返回一个空的取消函数。
 */
export async function watchMicPermission(onChange: () => void): Promise<() => void> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' })
    status.addEventListener('change', onChange)
    return () => status.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}

/** 是不是「浏览器不允许用麦克风」这一类失败（用户拒绝 / 权限被撤） */
export function isPermissionDenied(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'NotAllowedError'
}

// 浏览器用这两个 deviceId 表示「系统默认」与「通信用默认」，它们不是真实设备
const PSEUDO_DEVICE_IDS = new Set(['default', 'communications'])

/** 选择器里的一项：显示名在这里就定好 */
export interface DeviceOption {
  /** 浏览器给的真实设备 id（伪条目与真实条目合并后取真实那个，“默认 - X”那行也是真 id） */
  deviceId: string
  label: string
}

/**
 * 取设备名：伪条目（deviceId 是 default / communications）的 label 形如「默认 - 设备名」，
 * 只取「 - 」后面的部分；真实条目的 label 原样使用。
 */
function deviceName(d: MediaDeviceInfo): string {
  const label = d.label || ''
  if (!PSEUDO_DEVICE_IDS.has(d.deviceId)) return label || '未命名设备'
  const sep = label.indexOf(' - ')
  const name = sep >= 0 ? label.slice(sep + 3) : label
  return name.trim() || '未命名设备'
}

/**
 * 输出与输入的列表逻辑完全一样：同一台设备浏览器会给好几条
 * （default / communications / 真实条目），这里按设备名合成一行，系统默认那台排第一。
 */
async function listDevices(kind: MediaDeviceKind): Promise<DeviceOption[]> {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === kind)

  // 同名合并成一行：id 只认真实条目；label 记浏览器给的原文（默认那行本来就是「默认 - X」，不重新拼）。
  // 键要剥成裸名，伪条目里的「默认 - X」才和真实条目对得上。
  const byName = new Map<string, { deviceId: string; isDefault: boolean; label: string }>()
  for (const d of devices) {
    const name = deviceName(d)
    const prev = byName.get(name)
    if (!prev) {
      byName.set(name, {
        deviceId: d.deviceId,
        isDefault: d.deviceId === 'default',
        label: d.label
      })
      continue
    }
    // 真实条目的 id 优先：伪条目的 id 不能用来指定设备
    if (PSEUDO_DEVICE_IDS.has(prev.deviceId) && !PSEUDO_DEVICE_IDS.has(d.deviceId)) {
      prev.deviceId = d.deviceId
    }
    if (d.deviceId === 'default') {
      prev.isDefault = true
      prev.label = d.label
    }
  }

  return [...byName.entries()]
    .sort((a, b) => Number(b[1].isDefault) - Number(a[1].isDefault)) // 默认那台排最前
    .map(([, info]) => ({ deviceId: info.deviceId, label: info.label }))
}

export const listOutputs = () => listDevices('audiooutput')
export const listInputs = () => listDevices('audioinput')

/** 打开麦克风；传了 deviceId 就固定用那一支，否则跟随系统默认 */
export async function openMic(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      // 回声消除必须关：否则它会把我们要测的那一声从录音里消掉
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1
    }
  })
}
