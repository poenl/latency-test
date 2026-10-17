import { useEffect, useRef, useState } from 'react'

/** 系统是否要求减少动效：模块级读一次；命中时数字不做滚动动画，直接给终值 */
const prefersReduced =
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

/**
 * 数字滚动：从**上一次显示的值**滚到新目标，两个方向都行——所以校准完归零时能看见数字往回落。
 * 系统设置成减少动效时直接返回目标值，不进 state，effect 里也就没有同步 setState。
 */
export function useRoll(target: number) {
  const [value, setValue] = useState(0)
  const from = useRef(0)

  useEffect(() => {
    if (prefersReduced) return
    const ms = 900
    const origin = from.current
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms)
      setValue(origin + (target - origin) * (1 - (1 - p) ** 3))
      if (p < 1) raf = requestAnimationFrame(tick)
      else from.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])

  return prefersReduced ? target : value
}
