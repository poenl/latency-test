import { useState } from 'react'

/** 主题存这个键；没存过就是深色 */
const KEY = 'latency-theme'

type Theme = 'dark' | 'light'

/** 读存过的主题：启动时（main.tsx）和 useTheme 初始化都用它；隐私模式下读不到就按默认深色 */
export function readStoredTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * 写 DOM 与 localStorage。必须在 setState **之前**同步做：
 * React 的 effect 是子组件先跑，画布那层在 effect 里读 CSS 变量，
 * 若等父组件的 effect 再写 data-theme，画布就会读到切换前的那套颜色。
 */
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    // 隐私模式下 localStorage 可能不可写：不影响本次会话的切换
  }
}

/**
 * 主题切换。初始值直接读 `document.documentElement` 上由 index.html 内联脚本写好的
 * data-theme（首帧前就定好了，所以这里不会闪）。
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  )

  return {
    theme,
    toggle: () => {
      const next: Theme = theme === 'light' ? 'dark' : 'light'
      apply(next)
      setTheme(next)
    }
  }
}
