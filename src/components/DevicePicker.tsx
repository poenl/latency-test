import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DeviceOption } from '@/audio/devices'

/** 面板离触发按钮 8px，离视口边至少留 12px，最高不超过视口高的 62% */
const PANEL_GAP = 8
const PANEL_EDGE = 12
const PANEL_MAX_RATIO = 0.62

const Caret = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
)

const Tick = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M20 6L9 17l-5-5" />
  </svg>
)

/** 面板里的一行设备：选中看右侧紫勾，鼠标悬停整行高亮 */
function DeviceRow({
  label,
  selected,
  onClick
}: {
  label: string
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="active:bg-raise hover:bg-raise-2 flex h-9 w-full items-center gap-2 rounded-[9px] px-3 text-left text-[13px] transition-all"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected && (
        <span className="text-brand flex-none">
          <Tick />
        </span>
      )}
    </button>
  )
}

/** 输出/输入设备选择器：展开时按上下各剩多少，决定面板向上弹还是向下弹 */
export default function DevicePicker({
  outputs,
  inputs,
  outputId,
  inputId,
  calibrated,
  disabled,
  blocked,
  onPickOutput,
  onPickInput,
  onRetryPermission
}: {
  outputs: DeviceOption[]
  inputs: DeviceOption[]
  outputId: string
  inputId: string
  /** 已校准：基准那台不再可选，输入也不用再选 */
  calibrated: boolean
  /** 测量中：不能展开，展开的也收起 */
  disabled: boolean
  /** 麦克风权限被拦下：这个按钮只负责再授权，不展开列表（那时列表也读不到） */
  blocked: boolean
  onPickOutput: (deviceId: string) => void
  onPickInput: (deviceId: string) => void
  onRetryPermission: () => void
}) {
  const [open, setOpen] = useState(false)
  /** 展开时量出来的位置与高度上限：up = 向上弹 */
  const [drop, setDrop] = useState({ up: false, max: 0 })
  /** 触发按钮所在的外层：判断点击是否落在外面，也用来量它的位置 */
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** 展开的面板：用来量内容想要多高 */
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 触发按钮显示的当前输出设备：没选中时不再拿列表第一台打掩护，直接交代
  const current = outputs.find((d) => d.deviceId === outputId)

  // 点到面板外面或按 Esc 就收起（点主按钮也算"外面"，不需要额外处理）
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const el = rootRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    // 用捕获阶段：即使别处 stopPropagation 也收得到
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 展开时按上方/下方各剩多少，决定面板向上弹还是向下弹，并把高度压到放得下的范围。
  // 用 useLayoutEffect：量完再绘制，不会先看到一次错位。
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = rootRef.current
      const panel = panelRef.current
      if (!anchor || !panel) return
      const r = anchor.getBoundingClientRect()
      // scrollHeight 是内容想要的高度，不受 maxHeight 限制；+2 补回面板上下 1px 边框
      // （border-box 把边框算进高度里，不补就有 1px 假溢出，滚动条会被挤出来）
      const need = panel.scrollHeight + 2
      const below = window.innerHeight - r.bottom - PANEL_GAP - PANEL_EDGE
      const above = r.top - PANEL_GAP - PANEL_EDGE
      // 下方放不下、而且上方更宽裕，就向上弹
      const up = need > below && above > below
      const room = up ? above : below
      setDrop({ up, max: Math.max(0, Math.min(need, window.innerHeight * PANEL_MAX_RATIO, room)) })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  return (
    // order-1 是它在工具条里的位置：窄屏时设备行在按钮行下面
    <div ref={rootRef} className="relative order-1 min-w-0 flex-1">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (blocked ? onRetryPermission() : setOpen((v) => !v))}
        className="bg-control hover:bg-control-hover active:bg-raise flex h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-[13px] font-medium shadow-(--sh-raise) transition-all disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="text-muted flex-none">设备</span>
        {/* 没选中的要交代：列表空和「有设备但没选」分开说（原来的「读取中…」兜底已删）
            权限被拦下时列表读不到，这里直接交代问题本身 */}
        <span className="min-w-0 flex-1 truncate">
          {blocked
            ? '麦克风权限未开'
            : (current?.label ?? (outputs.length ? '未选设备' : '无可用设备'))}
        </span>
        <Caret />
      </button>

      {open && !disabled && !blocked && (
        <div
          ref={panelRef}
          // 位置与上限每次展开都量过：向上弹就贴着按钮上边，否则贴着下边
          style={{
            top: drop.up ? undefined : `calc(100% + ${PANEL_GAP}px)`,
            bottom: drop.up ? `calc(100% + ${PANEL_GAP}px)` : undefined,
            maxHeight: drop.max
          }}
          className="border-line bg-panel absolute inset-x-0 z-20 overflow-auto rounded-xl border p-1 shadow-(--sh-pop)"
        >
          <div className="text-dim px-3 pt-2 pb-1 text-[11px] tracking-[0.52px]">
            输出 · 要测的设备
          </div>
          {/* 一台可选的都没有：交代而不是留空白面板 */}
          {outputs.length ? (
            outputs.map((d) => (
              <DeviceRow
                key={d.deviceId || 'output-default'}
                label={d.label}
                selected={d.deviceId === outputId}
                onClick={() => {
                  onPickOutput(d.deviceId)
                  // 还差麦克风没选就留着面板，别让人再点一次
                  if (inputId) setOpen(false)
                }}
              />
            ))
          ) : (
            <p className="text-dim px-3 py-2 text-[13px]">没有可选择的输出设备</p>
          )}

          {/* 已校准后输入不用再选：整组收起来（含「已锁定」徽章与提示） */}
          {!calibrated && (
            <>
              <div className="border-line text-dim mt-1 flex items-center gap-2 border-t px-3 pt-2.5 pb-1 text-[11px] tracking-[0.52px]">
                输入 · 麦克风
              </div>
              {inputs.length ? (
                inputs.map((d) => (
                  <DeviceRow
                    key={d.deviceId || 'input-default'}
                    label={d.label}
                    selected={d.deviceId === inputId}
                    onClick={() => {
                      onPickInput(d.deviceId)
                      // 还差输出没选就留着面板
                      if (outputId) setOpen(false)
                    }}
                  />
                ))
              ) : (
                <p className="text-dim px-3 py-2 text-[13px]">没有可选择的输入设备</p>
              )}
              <p className="text-dim px-3 pt-1 pb-2 text-[11px] leading-4">
                测量期间只用这一支麦克风；换它会作废基准，需要重新校准。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
