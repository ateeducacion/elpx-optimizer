/**
 * Main-thread playback check: loads a candidate video into a detached
 * <video> element (never attached to the page) and waits until the browser
 * can decode its first frames. Object URLs are revoked afterwards.
 */
export function checkPlayback(blob: Blob, mime: string, timeoutMs = 20_000): Promise<'playable' | 'not-playable' | 'unsupported'> {
  const video = document.createElement('video');
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
    video.addEventListener('loadeddata', () => done(video.videoWidth > 0 && Number.isFinite(video.duration) ? 'playable' : 'not-playable'), { once: true });
    video.addEventListener('error', () => done('not-playable'), { once: true });
    video.src = url;
  });
}
