/**
 * Low-latency raw PCM audio utilities for Gemini Live API
 * Input: 16kHz, 16-bit, mono, little-endian PCM ("audio/pcm;rate=16000")
 * Output: 24kHz, 16-bit, mono, little-endian PCM
 */

export function encodeFloat32ToBase64Pcm16(
  inputSamples: Float32Array,
  inputSampleRate: number,
  targetSampleRate = 16000
): string {
  let samples = inputSamples;

  if (inputSampleRate !== targetSampleRate && inputSampleRate > 0) {
    const ratio = inputSampleRate / targetSampleRate;
    const newLength = Math.max(1, Math.floor(inputSamples.length / ratio));
    const resampled = new Float32Array(newLength);

    if (ratio > 1) {
      // True anti-aliasing area integration for downsampling (prevents high-frequency aliasing
      // that distorts consonants like 's', 'th', 'sh', 't', 'k', leading to misrecognized words)
      for (let i = 0; i < newLength; i++) {
        const start = i * ratio;
        const end = (i + 1) * ratio;
        const startIdx = Math.floor(start);
        const endIdx = Math.min(Math.ceil(end), inputSamples.length);
        let sum = 0;
        let totalWeight = 0;

        for (let j = startIdx; j < endIdx; j++) {
          const segStart = Math.max(start, j);
          const segEnd = Math.min(end, j + 1);
          const weight = segEnd - segStart;
          if (weight > 0) {
            sum += inputSamples[j] * weight;
            totalWeight += weight;
          }
        }
        resampled[i] = totalWeight > 0 ? sum / totalWeight : 0;
      }
    } else {
      // Linear interpolation for upsampling
      for (let i = 0; i < newLength; i++) {
        const idx = i * ratio;
        const indexFloor = Math.floor(idx);
        const indexCeil = Math.min(indexFloor + 1, inputSamples.length - 1);
        const frac = idx - indexFloor;
        resampled[i] =
          inputSamples[indexFloor] * (1 - frac) + inputSamples[indexCeil] * frac;
      }
    }
    samples = resampled;
  }

  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Gentle 1.3x consonant boost with smooth clamping so soft syllables are clearly audible to the model
    const boosted = samples[i] * 1.3;
    const s = Math.max(-1, Math.min(1, boosted));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }

  const bytes = new Uint8Array(int16.buffer);
  const CHUNK_SIZE = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }

  return window.btoa(binary);
}

export function decodeBase64Pcm16ToFloat32(base64: string): Float32Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const int16 = new Int16Array(bytes.buffer, 0, Math.floor(len / 2));
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768.0;
  }
  return float32;
}

export function calculateRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  const step = Math.max(1, Math.floor(samples.length / 256));
  let count = 0;
  for (let i = 0; i < samples.length; i += step) {
    const s = samples[i];
    sumSquares += s * s;
    count++;
  }
  const rms = Math.sqrt(sumSquares / count);
  return Math.min(1, rms * 4.2);
}
