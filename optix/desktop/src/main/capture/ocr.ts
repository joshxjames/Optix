import { createWorker, type Worker } from 'tesseract.js';

export type OcrBox = {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
};

// Worker creation pulls down ~10MB of language data and warms up the WASM
// runtime — typically 2-3s on a cold call. We share one worker for the
// process lifetime; subsequent recognise() calls reuse the warm worker.
let workerPromise: Promise<Worker> | null = null;

async function getWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const t0 = performance.now();
    // tesseract.js v5 exposes a single-arg form that loads, initializes, and
    // sets the language in one shot.
    const worker = await createWorker('eng');
    console.log(
      `[optix-timing] ocr worker init took ${Math.round(performance.now() - t0)}ms (cold)`,
    );
    return worker;
  })().catch((err) => {
    // Reset so a future call can retry rather than perpetually returning the
    // failed promise.
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

/**
 * Run OCR over a screenshot and return per-word bounding boxes filtered
 * to high-confidence detections. Coordinates are screen-pixel coordinates
 * matching the input image.
 *
 * Throws if OCR fails — the caller is expected to handle and fall back.
 */
export async function runOcr(imageBytes: Uint8Array): Promise<OcrBox[]> {
  const worker = await getWorker();
  const { data } = await worker.recognize(Buffer.from(imageBytes));

  const out: OcrBox[] = [];
  // tesseract.js 5 returns hierarchical data; words live on `data.words`. The
  // type definitions occasionally drift, so we read defensively.
  type TWord = {
    text?: string;
    confidence?: number;
    bbox?: { x0: number; y0: number; x1: number; y1: number };
  };
  const words: TWord[] = (data as unknown as { words?: TWord[] }).words ?? [];
  for (const w of words) {
    if (!w || typeof w.text !== 'string') continue;
    const text = w.text.trim();
    if (text.length === 0) continue;
    if (typeof w.confidence === 'number' && w.confidence < 60) continue;
    const b = w.bbox;
    if (!b) continue;
    const x = Math.max(0, Math.round(b.x0));
    const y = Math.max(0, Math.round(b.y0));
    const width = Math.max(1, Math.round(b.x1 - b.x0));
    const height = Math.max(1, Math.round(b.y1 - b.y0));
    out.push({ text, bbox: { x, y, width, height } });
  }
  return out;
}

/** Tear down the cached worker. Call only on app shutdown. */
export async function disposeOcrWorker(): Promise<void> {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch {
    // ignore — best-effort cleanup
  } finally {
    workerPromise = null;
  }
}
