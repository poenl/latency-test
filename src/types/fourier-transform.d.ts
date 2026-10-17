// fourier-transform 没有自带类型声明，这里按它的源码接口补一份最小的
declare module 'fourier-transform' {
  /** 原地正变换（复数） */
  export function cfft(re: Float64Array, im: Float64Array): void
  /** 原地反变换（复数，含 1/N 归一化） */
  export function cifft(re: Float64Array, im: Float64Array): void
  /** 实数输入的幅度谱，长度 N/2 */
  export default function rfft(input: ArrayLike<number>, output?: Float64Array): Float64Array
}
