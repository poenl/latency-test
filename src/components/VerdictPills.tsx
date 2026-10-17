import { OK_LIMIT, WARN_LIMIT } from '@/lib/scale'

/** 三档结结论：50 以内、50~150、150 以上 */
const GAME = ['没问题', '会慢半拍', '明显对不上']
/** 三档的圆点色（看视频只用第一档与第三档的颜色） */
const TONE = ['bg-ok', 'bg-warn', 'bg-err']

/** 按同两个阈值给结论 */
function verdicts(net: number) {
  const tier = net <= OK_LIMIT ? 0 : net <= WARN_LIMIT ? 1 : 2
  return [
    {
      name: '看视频',
      value: tier < 2 ? '没问题' : '能看出来对不上',
      tone: tier < 2 ? TONE[0] : TONE[2]
    },
    { name: '打游戏', value: GAME[tier], tone: TONE[tier] }
  ]
}

/**
 * 判定胶囊：白 10% 底、圆角 6、内高光的徽章配方。
 * 归零（净延迟为 0）或没有读数时不出现——那是对基准设备自身的判定，容易被当成"已经测完了"。
 */
export default function VerdictPills({ net }: { net: number | null }) {
  if (net == null || net <= 0.005) return null

  return (
    <>
      {verdicts(net).map((v) => (
        <span
          key={v.name}
          className="fade-up bg-pill blur-control text-soft inline-flex items-center gap-2 rounded-md px-3.5 py-1 text-[13.5px] font-semibold tracking-[-0.14px] shadow-(--sh-raise)"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${v.tone}`} aria-hidden="true" />
          <span className="text-soft">{v.name}</span>
          <span>{v.value}</span>
        </span>
      ))}
    </>
  )
}
