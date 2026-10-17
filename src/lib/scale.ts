/** 阈值：50 毫秒以内都没问题、150 以内打游戏会慢半拍，再高就明显对不上 */
export const OK_LIMIT = 50
export const WARN_LIMIT = 150

/**
 * 挑刻度的满量程与步长。
 * 满量程按读数往上取到 50 的整数倍（最小 150），这样无线设备几百毫秒的读数也不会把尺子顶爆；
 * 步长从 {5,10,25,50} 里挑最小的那个，要求整除满量程且格数不超过 35——量程两端因此落在格子上；
 * 50 与 150 能被这四个数全整除，所以两条阈值也自动落在格子上，不用单独判。
 */
export function pickScale(net: number | null) {
  const full = Math.max(WARN_LIMIT, Math.ceil((net ?? 0) / 50) * 50)
  const step = [5, 10, 25, 50].find((s) => full % s === 0 && full / s <= 35) ?? 50
  return { full, step }
}

/** 读数落在哪一档：决定刻度点亮用什么颜色 */
export function zoneOf(net: number) {
  if (net <= OK_LIMIT) return 'bg-ok'
  if (net <= WARN_LIMIT) return 'bg-warn'
  return 'bg-err'
}
