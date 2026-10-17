import { useEffect, useState } from 'react'
import { OK_LIMIT, WARN_LIMIT } from '@/lib/scale'

/**
 * 竖直刻度尺：0 在下面、满量程在上面，两端标了量程。
 * 50 和 150 两格画成更长的语义色刻度；点亮的部分按读数所在区间换色；
 * 当前那一格最亮（白）；测量中改成随机闪烁，表示在采样。
 * 两根尺子镜像：左尺刻度左对齐、右尺右对齐，长刻度都朝数字伸。
 */
export default function Scale({
  step,
  fullScale,
  ratio,
  zone,
  measuring,
  unlit,
  side
}: {
  step: number
  fullScale: number
  /** 读数 / 满量程，已夹到 0~1 */
  ratio: number
  zone: string
  measuring: boolean
  /** 还没出结果：刻度全灭 */
  unlit: boolean
  side: 'left' | 'right'
}) {
  const count = fullScale / step + 1
  const lit = ratio * (count - 1)
  const current = Math.round(lit)
  /** 测量中随机亮的格子：每 120 毫秒重掷一次，格数按自己的量程算 */
  const [flicker, setFlicker] = useState<number[]>([])

  useEffect(() => {
    if (!measuring) return
    const id = setInterval(() => {
      setFlicker(Array.from({ length: 7 }, () => Math.floor(Math.random() * count)))
    }, 120)
    return () => clearInterval(id)
  }, [measuring, count])

  return (
    <div
      className={`flex h-[15em] items-stretch gap-[0.6em] text-[clamp(8px,1.2vw,10px)] ${
        side === 'right' ? 'flex-row-reverse' : ''
      }`}
    >
      {/* 量程刻标：左尺数字右对齐、右尺左对齐，两边各自贴着刻度那侧 */}
      <div
        className={`text-faint flex flex-col justify-between font-mono leading-none ${
          side === 'left' ? 'text-right' : 'text-left'
        }`}
        aria-hidden="true"
      >
        <span>{fullScale}</span>
        <span>0</span>
      </div>

      <div
        className={`flex flex-col justify-between ${side === 'right' ? 'items-end' : ''}`}
        aria-hidden="true"
      >
        {Array.from({ length: count }, (_, i) => {
          const value = i * step
          const on = i <= lit
          const isThreshold = value === OK_LIMIT || value === WARN_LIMIT
          const width = isThreshold ? 'w-[2.4em]' : value % 25 === 0 ? 'w-[1.6em]' : 'w-[0.8em]'
          let color = 'bg-raise'
          if (isThreshold) {
            // 阈值刻度：没点亮也留着，当参考线
            color = value === OK_LIMIT ? (on ? 'bg-ok' : 'bg-ok/35') : on ? 'bg-warn' : 'bg-warn/35'
          } else if (measuring) {
            color = flicker.includes(i) ? 'bg-tick-hot' : 'bg-raise'
          } else if (unlit) {
            color = 'bg-raise'
          } else if (i === current) {
            color = 'bg-ink'
          } else if (on) {
            color = zone
          }
          return <span key={i} className={`block h-px rounded-full ${width} ${color}`} />
        })}
      </div>
    </div>
  )
}
