import { useEffect, useRef, useState } from 'react'
import DevicePicker from '@/components/DevicePicker'
import Scale from '@/components/Scale'
import { pickScale, zoneOf } from '@/lib/scale'
import VerdictPills from '@/components/VerdictPills'
import WaveField from '@/components/WaveField'
import { useLatencyTest } from '@/hooks/useLatencyTest'
import type { Phase } from '@/hooks/useLatencyTest'
import { useRoll } from '@/hooks/useRoll'
import { useTheme } from '@/hooks/useTheme'

/** 测量中数字上方显示当前在跑哪一段（idle 不会出现，跑起来就一定有具体段） */
const PHASE_LABEL: Partial<Record<Phase, string>> = {
  calibrate: '校准中',
  target: '测量中',
  check: '复核中'
}

/** 五个可点元素统一的过渡：直接用 Tailwind 的默认（transition-all、.15s、cubic-bezier(.4,0,.2,1)），同参考站 */
const EASE = 'transition-all'

/** 太阳：当前是深色，点一下切浅色 */
const Sun = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
)

/** 月亮：当前是浅色，点一下切深色 */
const Moon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
  </svg>
)

export default function App() {
  const test = useLatencyTest()
  const { theme, toggle } = useTheme()
  /** 重新校准之后的提示，显示在页脚那一行 */
  const [note, setNote] = useState('')
  /** 背景声场的圆心跟着数字走 */
  const centerRef = useRef<HTMLDivElement | null>(null)
  /** 开发环境 StrictMode 会把 effect 跑两次，用这个标记避免重复申请麦克风权限 */
  const refreshedRef = useRef(false)

  useEffect(() => {
    if (refreshedRef.current) return
    refreshedRef.current = true
    test.refreshDevices()
    // 依赖里放 test：已有上面的一次性守卫，重复执行是空操作，这样也满足 exhaustive-deps
  }, [test])

  // 校准在不在 = 有没有基准；有基准时数字显示归零的 00.00
  const calibrated = test.calibration != null
  const measuring = test.running
  const measured = test.netMedian != null
  const hasError = test.error !== ''
  const showZero = calibrated && !measured

  const net = useRoll(measured ? (test.netMedian as number) : 0)
  const { full, step } = pickScale(test.netMedian)
  // 净延迟夹到 0：测量噪声会让它出现 −0.2ms 这种值，显示成"比基准快"没有意义
  const shown = Math.max(0, net)
  const ratio = Math.min(1, shown / full)
  const zone = zoneOf(test.netMedian ?? 0)
  /**
   * 顶栏胶囊显示的是「测试设备」：校准完、而且换到了别的设备之后才算。
   * 没校准、或者选中的还是校准那台（基准）时，都还没有测试设备。
   */
  const testLabel =
    calibrated && test.outputId !== test.calibration?.outputId
      ? test.outputs.find((d) => d.deviceId === test.outputId)?.label
      : undefined

  // 状态行：优先级 权限被拦 > 失败 > 基准信息 > 校准引导
  // 权限在最前：它拦着的时候别的操作都做不了，说别的没意义
  const status = test.micBlocked
    ? {
        text: '没有拿到麦克风权限：请在地址栏把麦克风改成「允许」，再点设备按钮重试。',
        tone: 'text-warn'
      }
    : hasError
      ? { text: test.error, tone: calibrated ? 'text-err' : 'text-warn' }
      : calibrated
        ? {
            text: `基准：${test.calibration?.outputLabel} · 以这台设备为基准`,
            tone: 'text-soft'
          }
        : !test.outputId || !test.inputId
          ? { text: '先选好输出设备和麦克风。', tone: 'text-soft' }
          : {
              text: '请选择延迟较小的设备作为基准：电脑内置扬声器、有线音箱或有线耳机。',
              tone: 'text-soft'
            }

  return (
    <div className="bg-page min-h-screen">
      <WaveField
        centerRef={centerRef}
        measuring={measuring}
        settled={measured}
        light={theme === 'light'}
      />
      {/* 底部渐隐：浅色下把画布压回白（深色下 CSS 里是 display:none，等于不存在） */}
      <div className="fade-floor" aria-hidden="true" />

      {/* 顶部：浮动玻璃导航条（56 高、圆角 14、距顶 20） */}
      <header className="relative z-10 px-5 pt-5">
        <div className="border-line bg-page mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 rounded-[14px] border pr-2 pl-5">
          <span className="flex items-center gap-2 text-[13px] font-medium tracking-[0.52px]">
            <span className="bg-brand h-1.75 w-1.75 rounded-full" aria-hidden="true" />
            音频延迟测试
          </span>
          <span className="flex items-center gap-2">
            {/* 主题切换：36×36 方形图标按钮，尺寸同参考站的 ln-navbar-theme-btn */}
            <button
              type="button"
              onClick={toggle}
              title={theme === 'light' ? '切到深色主题' : '切到浅色主题'}
              aria-label={theme === 'light' ? '切到深色主题' : '切到浅色主题'}
              className={`bg-control text-muted hover:bg-control-hover flex h-9 w-9 items-center justify-center rounded-[10px] shadow-(--sh-raise) active:scale-[0.95] ${EASE}`}
            >
              {theme === 'light' ? <Moon /> : <Sun />}
            </button>
            <span className="bg-control flex h-9 items-center gap-2 rounded-[10px] px-3 text-[13px] font-medium shadow-(--sh-raise)">
              <span className="text-muted">测试设备</span>
              {testLabel ? (
                <>
                  {/* 实心紫点：这台就是这次要测的设备 */}
                  <span className="bg-brand h-2 w-2 flex-none rounded-full" aria-hidden="true" />
                  <span className="max-w-[40vw] truncate">{testLabel}</span>
                </>
              ) : (
                <>
                  {/* 空心圈：还没选中测试设备 */}
                  <span
                    className="border-faint h-2 w-2 flex-none rounded-full border"
                    aria-hidden="true"
                  />
                  <span className="text-dim max-w-[40vw] truncate">未选中测试设备</span>
                </>
              )}
            </span>
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-[calc(100dvh-76px)] max-w-7xl flex-col items-center justify-center gap-9 px-5 py-14 md:py-20">
        <div className="flex items-center gap-4 md:gap-10">
          <Scale
            step={step}
            fullScale={full}
            ratio={ratio}
            zone={zone}
            measuring={measuring}
            unlit={!measured}
            side="left"
          />

          <div className="text-center">
            {/* 数字上方是步骤指示；正在跑的时候显示跑到哪一段 */}
            <span className="bg-chip-2 inline-flex items-center rounded-md px-2 py-0.75 text-[12px] font-semibold tracking-[-0.12px] shadow-(--sh-raise-2)">
              {measuring
                ? (PHASE_LABEL[test.phase] ?? '测量中')
                : calibrated
                  ? '第 2 步 · 测试'
                  : '第 1 步 · 校准'}
            </span>
            {/* 宽度锁住（3.6em 够 `123.45`），滚数和位数变化时左右不跳 */}
            <div
              ref={centerRef}
              className={`mx-auto mt-3 w-[3.6em] text-center text-[clamp(56px,19vw,200px)] leading-[0.86] font-medium tracking-[-0.04em] tabular-nums ${
                measuring ? 'breathe' : ''
              } ${measured ? '' : showZero ? 'text-faint-strong' : 'text-faint'}`}
            >
              {measured
                ? `${shown < 10 ? '0' : ''}${shown.toFixed(2)}`
                : showZero
                  ? '00.00'
                  : '--.--'}
            </div>
            <div className="text-soft mt-2 text-[17px] leading-[1.6]">
              {measured ? '毫秒 · 净延迟' : '毫秒'}
            </div>
          </div>

          <Scale
            step={step * 2}
            fullScale={full}
            ratio={ratio}
            zone={zone}
            measuring={measuring}
            unlit={!measured}
            side="right"
          />
        </div>

        {/* 状态行：固定 44 高占位，只换文案不换高度 */}
        <p
          className={`flex min-h-11 w-full max-w-140 items-center justify-center text-center text-[13px] leading-[1.6] ${status.tone}`}
        >
          {status.text}
        </p>

        {/* 判定胶囊：占位常驻（固定 28 高），只在测完且净延迟大于零时淡入 */}
        <div className="flex min-h-7 flex-wrap items-center justify-center gap-2.5">
          <VerdictPills net={test.netMedian} />
        </div>

        {/* 底部工具条：内衬 5px；手机上按钮在上、设备在下 */}
        <div className="border-line bg-panel w-full max-w-140 rounded-2xl border p-1.25 shadow-(--sh-raise-2)">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="order-2 flex gap-2 sm:flex-none">
              <button
                type="button"
                // 测量中永远可按（那个位置是「停止」）；输出、输入都选好才可按
                disabled={test.micBlocked || (!measuring && (!test.outputId || !test.inputId))}
                onClick={() => {
                  // 测量中按下去就是中止（不等超时）
                  if (measuring) {
                    test.abort()
                    return
                  }
                  setNote('')
                  if (calibrated) test.runTest()
                  else test.runCalibration()
                }}
                className={`text-page bg-accent hover:bg-accent-hover h-11 flex-1 rounded-xl px-5 text-[14.5px] font-medium tracking-[-0.145px] shadow-(--sh-accent) active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${EASE}`}
              >
                {measuring ? '停止' : calibrated ? '开始测试' : '开始校准'}
              </button>
              {/* 重新校准：只有已校准才出现，测量中禁用 */}
              {calibrated && (
                <button
                  type="button"
                  disabled={measuring}
                  onClick={() => {
                    test.recalibrate()
                    setNote('已清掉基准，请先重新校准')
                  }}
                  className={`bg-control hover:bg-control-hover blur-control h-11 flex-1 rounded-xl px-4 text-[14.5px] font-medium tracking-[-0.145px] shadow-(--sh-raise) active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none ${EASE}`}
                >
                  重新校准
                </button>
              )}
            </div>

            <DevicePicker
              outputs={test.selectableOutputs}
              inputs={test.inputs}
              outputId={test.outputId}
              inputId={test.inputId}
              calibrated={calibrated}
              disabled={measuring}
              blocked={test.micBlocked}
              onPickOutput={test.setOutputId}
              onRetryPermission={test.retryPermission}
              onPickInput={test.setInputId}
            />
          </div>
        </div>

        <p className="text-foot text-[13px] font-medium">
          {note || '结果只在这次打开页面期间有效'}
        </p>
      </main>
    </div>
  )
}
