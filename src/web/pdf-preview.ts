/**
 * Pages of a project's PDF drawn into a canvas with pdf.js, loaded only when a PDF is previewed.
 * The document is data: its scripts, forms and XFA are not run (no scripting sandbox is loaded),
 * and pdf.js fetches nothing (the fonts and colour maps it would ask for are skipped).
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export interface PdfPreview {
  readonly pages: number;
  /** Draws a page (1-based) to fit a width in CSS pixels. */
  render(page: number, canvas: HTMLCanvasElement, width: number): Promise<void>;
  destroy(): Promise<void>;
}

/** Opens a PDF for preview. */
export async function openPdf(data: Uint8Array): Promise<PdfPreview> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const task = pdfjs.getDocument({ data, enableXfa: false, useSystemFonts: true, stopAtErrors: false });
  const doc = await task.promise;
  // One drawing at a time on the canvas: a new page cancels the one still being drawn.
  let current: { cancel(): void; promise: Promise<void> } | undefined;
  return {
    pages: doc.numPages,
    async render(page, canvas, width) {
      if (current) {
        current.cancel();
        await current.promise.catch(() => undefined);
      }
      const p = await doc.getPage(page);
      const base = p.getViewport({ scale: 1 });
      const ratio = globalThis.devicePixelRatio || 1;
      const viewport = p.getViewport({ scale: (width / base.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
      current = p.render({ canvas, viewport });
      await current.promise;
    },
    destroy: () => task.destroy(),
  };
}
