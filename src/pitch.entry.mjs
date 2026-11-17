// Cambio de tono sin cambiar la duración (SoundTouch, LGPL-2.1). Procesa la canción completa fuera de tiempo real.
import { SoundTouch, SimpleFilter, WebAudioBufferSource } from 'soundtouchjs';

/**
 * channels: [Float32Array] o [L, R]; sampleRate; semitones: entero (+/-).
 * Devuelve { left, right, frames } (siempre estéreo).
 */
export async function shift(channels, sampleRate, semitones, onProgress) {
  const length = channels[0].length;
  const buffer = {
    numberOfChannels: channels.length, length, sampleRate,
    getChannelData: (i) => channels[Math.min(i, channels.length - 1)],
  };
  const st = new SoundTouch(sampleRate);
  st.pitchSemitones = semitones;
  st.tempo = 1;
  const filter = new SimpleFilter(new WebAudioBufferSource(buffer), st);
  const CH = 16384, tmp = new Float32Array(CH * 2);
  const left = new Float32Array(length + CH), right = new Float32Array(length + CH);
  let out = 0, n, guard = 0;
  while ((n = filter.extract(tmp, CH)) > 0 && out + n <= left.length && guard++ < 100000) {
    for (let i = 0; i < n; i++) { left[out + i] = tmp[2 * i]; right[out + i] = tmp[2 * i + 1]; }
    out += n;
    if (onProgress && guard % 8 === 0) { onProgress(Math.min(1, out / length)); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (onProgress) onProgress(1);
  return { left: left.subarray(0, out), right: right.subarray(0, out), frames: out };
}
