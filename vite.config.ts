import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // 资源路径按「当前页面所在的那一层」算：项目站点（/latency-test/）和自定义域名都能用
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    // worklet 必须保持成独立文件，不能被内联成 data: URL
    assetsInlineLimit: (filePath) => !filePath.includes('capture-processor')
  }
})
