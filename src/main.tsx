import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { readStoredTheme } from './hooks/useTheme'
import './index.css'

// 启动前定主题：默认深色（不写属性就是深色），只有存过 light 才设浅色。
// 这一段原本在 index.html 的内联脚本里；搬来这里后，浅色用户首帧有闪一下深色的可能。
if (readStoredTheme() === 'light') document.documentElement.dataset.theme = 'light'

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
