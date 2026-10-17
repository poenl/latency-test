import { useEffect, useRef } from 'react'

/**
 * 背景「声场」。在同一个 canvas 2D 上叠四层：
 * 1) 声吶刻度——以数字为中心几圈固定细环（每 90px 一圈，每 3 圈一根略亮）；
 * 2) 胶片颗粒——8 张贴图按 24fps 轮换（测量中 30fps），数字周围挖一个椭圆不放颗粒；
 * 3) 空气粒子点阵——指针 180px 内按 (1-d/180)² 被吸引，离开后弹簧回位；
 * 4) 波前——测量时从数字中心发出，回声圈（延迟 320 毫秒）再把粒子往里拉。
 * 零依赖；DPR ≤ 2；切后台停帧；减少动效时只画静态一帧；粒子和波都用预分配数组，每帧不新建对象。
 */

/** 声吶刻度：环间距、每几圈一根略亮的环 */
const RING_STEP = 90
const RING_STRONG_EVERY = 3

/** 颗粒的混合方式按主题：深色底提亮、浅色底压暗（颜色全走 CSS token --canvas-*） */
const GRAIN_MODE = { dark: 'lighter', light: 'multiply' } as const

export default function WaveField({
  centerRef,
  measuring,
  settled,
  light
}: {
  /** 圆心跟着这个元素走（数字） */
  centerRef: React.RefObject<HTMLDivElement | null>
  /** 测量中：连续发波、颗粒闪得更快 */
  measuring: boolean
  /** 已经出结果：发一轮波并留下回声环 */
  settled: boolean
  /** 浅色主题：换成浅色底的那套调色板 */
  light: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef({ measuring, settled })
  // 渲染期不能写 ref：放到 effect 里同步，rAF 循环下一帧读到最新值
  useEffect(() => {
    stateRef.current = { measuring, settled }
  }, [measuring, settled])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    // 颜色从 token 读（两套同名），颗粒的混合方式按主题
    const style = getComputedStyle(document.documentElement)
    const token = (name: string) => style.getPropertyValue(name).trim()
    const grainMode = GRAIN_MODE[light ? 'light' : 'dark']
    const P = {
      line: token('--canvas-line'),
      lineStrong: token('--canvas-line-strong'),
      dot: token('--canvas-dot'),
      dotHot: token('--canvas-dot-hot'),
      ringHot: token('--canvas-ring-hot'),
      scratch: token('--canvas-scratch')
    }

    // ---- 预制件：8 张噪点贴图（胶片颗粒逐张轮换，不是缓慢平移） ----
    const GRAIN_TILES = 8
    /** 颗粒放大倍数：>1 就是粗颗粒 */
    const GRAIN_SCALE = 1.6
    const grainPatterns: (CanvasPattern | null)[] = Array.from({ length: GRAIN_TILES }, () => {
      const tile = document.createElement('canvas')
      tile.width = 128
      tile.height = 128
      const g = tile.getContext('2d')
      if (g) {
        const img = g.createImageData(128, 128)
        for (let i = 0; i < img.data.length; i += 4) {
          const v = (Math.random() * 255) | 0
          img.data[i] = v
          img.data[i + 1] = v
          img.data[i + 2] = v
          img.data[i + 3] = 255
        }
        g.putImageData(img, 0, 0)
      }
      return ctx.createPattern(tile, 'repeat')
    })

    // ---- 粒子：全部预分配 ----
    const N = 260
    const ax = new Float32Array(N)
    const ay = new Float32Array(N)
    const ph = new Float32Array(N)
    const seed = new Float32Array(N)
    const ox = new Float32Array(N)
    const oy = new Float32Array(N)
    const vx = new Float32Array(N)
    const vy = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      ax[i] = Math.random()
      ay[i] = Math.random()
      ph[i] = Math.random() * Math.PI * 2
      seed[i] = 0.55 + Math.random() * 0.45
    }

    // ---- 波：固定 8 个槽；wd > 0 表示回声还在路上 ----
    const W = 8
    const wr = new Float32Array(W)
    const wk = new Float32Array(W)
    const wd = new Float32Array(W)
    const ws = new Float32Array(W)
    for (let i = 0; i < W; i++) wr[i] = -1
    let slot = 0
    /** kind：0 = 发声波（往外推），1 = 回声（往里拉）；delayMs 是回声的延迟 */
    const emit = (kind: number, delayMs: number) => {
      wr[slot] = 44
      wk[slot] = kind
      wd[slot] = delayMs / 1000
      ws[slot] = kind === 0 ? 1 : 0.62
      slot = (slot + 1) % W
    }

    /** 16 级透明度阶梯：预拼成字符串，避免每帧拼；rgb 是 token 里的 "r, g, b" */
    const ladder = (rgb: string, from: number, span: number) =>
      Array.from({ length: 16 }, (_, i) => `rgba(${rgb},${(from + (i / 15) * span).toFixed(3)})`)
    const dotBase = ladder(P.dot, 0.14, 0.42)
    const dotHot = ladder(P.dotHot, 0.2, 0.5)
    const ringBase = ladder(P.dot, 0, 0.16)
    const ringHot = ladder(P.ringHot, 0, 0.26)

    let raf = 0
    let running = false
    let w = 0
    let h = 0
    let cx = 0
    let cy = 0
    let t = 0
    let acc = 0
    let last = 0
    let lastDone: boolean | null = null
    let grainIndex = 0
    let grainAcc = 0
    /** 划痕：两个槽，每个活两帧 */
    const scratchX = new Float32Array(2)
    const scratchLife = new Int32Array(2)
    let scratchSlot = 0
    const pointer = { x: 0, y: 0, on: false }

    /** 按容器尺寸重算画布与圆心；圆心跟数字走 */
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const box = centerRef.current?.getBoundingClientRect()
      cx = box ? box.left + box.width / 2 : w / 2
      cy = box ? box.top + box.height / 2 : h / 2
    }

    const drawFrame = (dt: number) => {
      const { measuring: nowMeasuring, settled: nowSettled } = stateRef.current
      // 出结果的那一刻发一轮波
      if (nowSettled !== lastDone) {
        lastDone = nowSettled
        acc = 0
        if (nowSettled) {
          emit(0, 0)
          emit(1, 320)
        }
      }
      if (nowMeasuring) {
        acc += dt
        if (acc >= 2.2) {
          acc = 0
          emit(0, 0)
          emit(1, 320)
        }
      }

      const maxR = Math.hypot(w, h)
      for (let i = 0; i < W; i++) {
        if (wr[i] < 0) continue
        if (wd[i] > 0) {
          wd[i] -= dt
          continue
        }
        wr[i] += 320 * dt
        if (wr[i] > maxR) wr[i] = -1
      }

      ctx.clearRect(0, 0, w, h)

      // 1) 声吶刻度：以数字为中心几圈固定细环（静态）；每 RING_STRONG_EVERY 圈一根略亮
      const maxRing = Math.hypot(w, h)
      ctx.lineWidth = 1
      let ringIndex = 0
      for (let r = RING_STEP; r < maxRing; r += RING_STEP) {
        ctx.beginPath()
        ctx.strokeStyle = ringIndex % RING_STRONG_EVERY === 0 ? P.lineStrong : P.line
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        ringIndex++
      }

      // 2) 胶片颗粒：按帧率换贴图；数字周围挖椭圆保证读数干净
      grainAcc += dt
      const grainFps = nowMeasuring ? 30 : 24
      if (grainAcc >= 1 / grainFps) {
        grainAcc = 0
        grainIndex = reduce ? 0 : (grainIndex + 1) % GRAIN_TILES
      }
      const grain = grainPatterns[grainIndex]
      if (grain) {
        ctx.save()
        ctx.globalAlpha = 0.05
        ctx.globalCompositeOperation = grainMode
        ctx.beginPath()
        ctx.rect(0, 0, w, h)
        ctx.ellipse(cx, cy, 360, 150, 0, 0, Math.PI * 2)
        ctx.clip('evenodd')
        ctx.scale(GRAIN_SCALE, GRAIN_SCALE)
        ctx.fillStyle = grain
        ctx.fillRect(0, 0, w / GRAIN_SCALE, h / GRAIN_SCALE)
        ctx.restore()
      }

      // 3) 波前：发声波白、回声紫，越远越淡
      for (let i = 0; i < W; i++) {
        if (wr[i] < 0 || wd[i] > 0) continue
        const level = Math.round(Math.max(0, 1 - wr[i] / maxR) * 15)
        ctx.beginPath()
        ctx.strokeStyle = wk[i] === 0 ? ringBase[level] : ringHot[level]
        ctx.lineWidth = wk[i] === 0 ? 1.4 : 1.8
        ctx.arc(cx, cy, wr[i], 0, Math.PI * 2)
        ctx.stroke()
      }

      // 4) 粒子：指针吸引 + 被波前推/拉 + 弹簧回位
      for (let i = 0; i < N; i++) {
        const bx = ax[i] * w + Math.sin(t * 0.25 + ph[i]) * 14
        const by = ay[i] * h + Math.cos(t * 0.21 + ph[i]) * 12

        if (pointer.on) {
          const dx = pointer.x - (bx + ox[i])
          const dy = pointer.y - (by + oy[i])
          const d = Math.hypot(dx, dy)
          if (d < 180 && d > 0.5) {
            const pull = (1 - d / 180) ** 2 * 420
            vx[i] += (dx / d) * pull * dt
            vy[i] += (dy / d) * pull * dt
          }
        }

        for (let k = 0; k < W; k++) {
          if (wr[k] < 0 || wd[k] > 0) continue
          const dx = bx - cx
          const dy = by - cy
          const d = Math.hypot(dx, dy)
          if (d > 0.5 && Math.abs(d - wr[k]) < 18) {
            const along = Math.max(0, 1 - wr[k] / maxR)
            const push = (wk[k] === 0 ? 2600 : -1700) * ws[k] * along * seed[i]
            vx[i] += (dx / d) * push * dt
            vy[i] += (dy / d) * push * dt
          }
        }

        vx[i] += -ox[i] * 26 * dt
        vy[i] += -oy[i] * 26 * dt
        const damp = 0.86 ** (dt * 60)
        vx[i] *= damp
        vy[i] *= damp
        ox[i] += vx[i] * dt
        oy[i] += vy[i] * dt

        // 位移越大越亮、越偏紫
        const disp = Math.min(1, Math.hypot(ox[i], oy[i]) / 26)
        const level = Math.round(disp * 15)
        ctx.fillStyle = disp > 0.35 ? dotHot[level] : dotBase[level]
        ctx.beginPath()
        ctx.arc(bx + ox[i], by + oy[i], 1.1 + disp * 1.3, 0, Math.PI * 2)
        ctx.fill()
      }

      // 5) 出结果：留一圈淡淡的回声环
      if (nowSettled) {
        ctx.beginPath()
        ctx.strokeStyle = ringHot[7]
        ctx.lineWidth = 1.6
        ctx.arc(cx, cy, Math.min(w, h) * 0.34, 0, Math.PI * 2)
        ctx.stroke()
      }

      // 6) 划痕：每秒约 0.7 次，每次只活两帧，极淡
      if (!reduce) {
        if (Math.random() < dt * 0.7) {
          scratchX[scratchSlot] = Math.random() * w
          scratchLife[scratchSlot] = 2
          scratchSlot = (scratchSlot + 1) % 2
        }
        ctx.strokeStyle = P.scratch
        ctx.lineWidth = 1
        for (let i = 0; i < 2; i++) {
          if (scratchLife[i] <= 0) continue
          scratchLife[i] -= 1
          ctx.beginPath()
          ctx.moveTo(scratchX[i], 0)
          ctx.lineTo(scratchX[i], h)
          ctx.stroke()
        }
      }
    }

    const frame = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000))
      last = now
      t += dt
      drawFrame(dt)
      if (running) raf = requestAnimationFrame(frame)
    }
    const start = () => {
      if (running || reduce) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      running = false
      cancelAnimationFrame(raf)
    }
    const onVisibility = () => (document.hidden ? stop() : start())
    const onMove = (e: PointerEvent) => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      pointer.on = true
    }
    const onPointerEnd = () => {
      pointer.on = false
    }

    resize()
    drawFrame(0)
    if (!reduce) start()

    const ro = new ResizeObserver(() => {
      resize()
      if (reduce) drawFrame(0)
    })
    ro.observe(document.documentElement)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointerleave', onPointerEnd)

    return () => {
      stop()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointerleave', onPointerEnd)
    }
  }, [centerRef, light])

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
      aria-hidden="true"
    />
  )
}
