/**
 * Main-thread playback check: loads a candidate into a detached <video> or
 * <audio> element (never attached to the page) and waits until the browser
 * can decode its first frames (a picture for video, a positive duration for
 * audio; browser recordings report an infinite one). Object URLs are revoked
 * afterwards.
 */
export function checkPlayback(blob: Blob, mime: string, timeoutMs = 20_000): Promise<'playable' | 'not-playable' | 'unsupported'> {
  const audio = mime.startsWith('audio/');
  const video = document.createElement(audio ? 'audio' : 'video');
  const support = video.canPlayType(mime);
  if (support === '') return Promise.resolve('unsupported');
  const url = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: 'playable' | 'not-playable'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done('not-playable'), timeoutMs);
    video.muted = true;
    video.preload = 'auto';
    const decoded = (): boolean => (audio ? video.duration > 0 : (video as HTMLVideoElement).videoWidth > 0 && Number.isFinite(video.duration));
    video.addEventListener('loadeddata', () => done(decoded() ? 'playable' : 'not-playable'), { once: true });
    video.addEventListener('error', () => done('not-playable'), { once: true });
    video.src = url;
  });
}
