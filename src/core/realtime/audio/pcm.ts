import { base64ToUint8Array, uint8ArrayToBase64 } from '../../../utils/base64'

export function int16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] / 32768
  return out
}

export function float32ToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    out[i] = Math.min(32767, Math.round(sample * 32768))
  }
  return out
}

export function int16ToBase64(input: Int16Array): string {
  const bytes = new Uint8Array(input.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < input.length; i += 1) view.setInt16(i * 2, input[i], true)
  return uint8ArrayToBase64(bytes)
}

export function base64ToInt16(b64: string): Int16Array {
  const bytes = base64ToUint8Array(b64)
  const out = new Int16Array(bytes.length / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i += 1) out[i] = view.getInt16(i * 2, true)
  return out
}

export function resampleLinear(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array {
  if (input.length === 0) return new Float32Array(0)
  if (inputRate === outputRate) return input
  const ratio = outputRate / inputRate
  const outLength = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}
