import { ipcMain, screen } from 'electron';
import { IPC } from '@shared/ipc';
import {
  PromptRequestSchema,
  ProviderIdSchema,
  type PromptRequest,
  type TargetRegion,
} from '@shared/schemas';
import { getProvider } from '@main/providers/registry';
import { getApiKey } from '@main/security/keychain';
import { getSettings, getModelFor } from '@main/storage/settings-store';
import { runOcr, type OcrBox } from '@main/capture/ocr';
import { snapRegionsToOcr, countSnapped } from '@main/capture/snap-to-ocr';
import { getUiaElements, type UiaElement } from '@main/capture/uia';
import { snapRegionsToUia, countUiaSnapped } from '@main/capture/snap-to-uia';

// One in-flight request at a time. The Stop button triggers `cancel`, which
// aborts whichever request is currently running.
let currentAbort: AbortController | null = null;

/**
 * Heuristic: does the user's prompt look like a "where is X" / "show me X"
 * style LOCATE query that the visual overlay is the primary answer for?
 * Used to decide whether to fire the auto-retry when the model returns a
 * prose-only answer with empty `targetRegions`. Permissive on purpose —
 * a false positive just costs one extra round-trip; a false negative
 * means the user gets prose with no overlay (worse UX).
 */
function looksLikeLocateQuery(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return (
    /\bwhere\s+(is|are|'s|can\s+i\s+find)\b/.test(p) ||
    /\bshow\s+me\b/.test(p) ||
    /\bcan\s+you\s+show\b/.test(p) ||
    /\bpoint\s+(it|that|them|me|to)\b/.test(p) ||
    /\bhighlight\b/.test(p) ||
    /\blocate\b/.test(p) ||
    /\bfind\s+(the|where)\b/.test(p)
  );
}

export function registerProviderIpc(): void {
  ipcMain.handle(IPC.provider.prompt, async (event, rawReq: unknown) => {
    const req: PromptRequest = PromptRequestSchema.parse(rawReq);
    const sender = event.sender;

    const settings = getSettings();
    const { activeProviderId, webSearchEnabled, overlayEnabled } = settings;
    const provider = getProvider(activeProviderId);
    const modelId = getModelFor(activeProviderId);

    // For BYO-key providers we fetch the user's API key from the OS
    // keychain. For Optix Cloud the renderer attaches a fresh Firebase
    // ID token to the request (Auth state lives in the renderer; the
    // SDK auto-refreshes the token, so we always pass through whatever
    // the renderer just minted).
    const credential =
      activeProviderId === 'optixCloud'
        ? req.authToken
        : await getApiKey(activeProviderId);
    if (!credential) {
      throw new Error(
        activeProviderId === 'optixCloud'
          ? 'Not signed in to Optix Cloud. Click Sign in in Settings.'
          : `No API key configured for ${activeProviderId}. Open Settings to add one.`,
      );
    }

    // Cancel any prior in-flight request.
    currentAbort?.abort();
    const controller = new AbortController();
    currentAbort = controller;

    const t0 = performance.now();
    let ttftMs: number | undefined;
    let firstChunkAt: number | undefined;
    let lastChunkAt: number | undefined;
    let chunkCount = 0;
    let charCount = 0;
    let usedWebSearch = false;
    // Aggregated token usage across the whole prompt() call. Providers
    // call `onUsage` once per API round-trip; for tool-loop providers
    // (Anthropic web_search, OpenAI tool loop, Gemini DDG fallback)
    // that fires multiple times — we sum here and report the total.
    let totalUsage:
      | {
          inputTokens: number;
          outputTokens: number;
          cacheCreationInputTokens: number;
          cacheReadInputTokens: number;
        }
      | undefined;
    // Map keyed by URL so the model can re-cite the same page without us
    // showing duplicate favicon chips.
    const sourcesByUrl = new Map<string, { url: string; title: string }>();

    // Coalesce per-token deltas into ~one-frame batches so the renderer
    // re-renders ~60Hz instead of once per token (100-250 renders/response
    // on Kimi). The wire format stays `{ delta: string }` — we just send
    // the concatenated buffer.
    let chunkBuffer = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flushChunks = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (chunkBuffer.length === 0) return;
      const delta = chunkBuffer;
      chunkBuffer = '';
      if (!sender.isDestroyed()) sender.send(IPC.provider.chunk, { delta });
    };
    const scheduleFlush = (): void => {
      if (flushTimer !== null) return;
      flushTimer = setTimeout(flushChunks, 16);
    };

    // ---- Throttled streaming-extraction cadence --------------------------
    // Any extraction work that needs to scan the FULL accumulated response
    // (e.g. answer/steps/warnings regex extraction for live preview) must
    // hook into `runStreamingExtraction` rather than firing per onChunk.
    // Per-chunk full-buffer regex is O(N²) in response length — Kimi runs
    // emit 100-250 chunks, so a 5KB response would re-scan ~625KB of text.
    //
    // Trade-off: throttling to every-5-chunks-or-100ms means the live
    // preview lags behind the streamed text by up to 100ms. The renderer
    // is already buffer-coalescing at ~16ms for the visible delta, so this
    // is consistent with the perceived streaming cadence and the user
    // shouldn't notice the extraction lag. A FINAL pass runs unconditionally
    // on stream completion so the post-stream `response` object is
    // authoritative regardless of throttle cadence.
    const EXTRACTION_CHUNK_INTERVAL = 5;
    const EXTRACTION_TIME_INTERVAL_MS = 100;
    let chunksSinceExtraction = 0;
    let lastExtractionAt = 0;
    // Hook point — left as a no-op today. When a future feature adds live
    // structured extraction (intent/steps/answer preview), call the heavy
    // regex from inside this function. The throttle in `maybeRunExtraction`
    // guarantees it runs at most every 5 chunks or 100ms.
    const runStreamingExtraction = (): void => {
      // intentional no-op — placeholder for throttled per-chunk extraction.
    };
    const maybeRunExtraction = (): void => {
      const now = performance.now();
      if (
        chunksSinceExtraction >= EXTRACTION_CHUNK_INTERVAL ||
        now - lastExtractionAt >= EXTRACTION_TIME_INTERVAL_MS
      ) {
        chunksSinceExtraction = 0;
        lastExtractionAt = now;
        runStreamingExtraction();
      }
    };

    // Kick off OCR + UIA in parallel with the LLM call. Both are only useful
    // if the overlay is enabled and there's an actual screenshot — otherwise
    // the regions array will be empty and there's nothing to refine. The
    // three (LLM, OCR, UIA) race; we await the snap sources after the LLM
    // returns. UIA is preferred (OS-precise bounds, exposes tooltip text on
    // icon-only buttons); OCR is the fallback for regions UIA doesn't snap.
    const ocrStart = performance.now();
    let ocrPromise: Promise<OcrBox[]> | null = null;
    let uiaPromise: Promise<UiaElement[]> | null = null;
    if (overlayEnabled && req.imageBytes) {
      ocrPromise = runOcr(req.imageBytes).then((boxes) => {
        console.log(
          `[optix-timing] ocr boxes=${boxes.length} ms=${Math.round(
            performance.now() - ocrStart,
          )}`,
        );
        return boxes;
      });
      // Attach a no-op catch so a rejection before we await doesn't surface
      // as an unhandled rejection. The real handling happens at the await.
      ocrPromise.catch(() => {});

      // getUiaElements() never throws — it resolves to [] on any failure
      // (non-Windows, timeout, parse error). Still attach a defensive catch
      // in case that contract changes.
      uiaPromise = getUiaElements();
      uiaPromise.catch(() => {});
    }

    try {
      let response = await provider.prompt(
        {
          mode: req.mode,
          prompt: req.prompt,
          modelId,
          imageBytes: req.imageBytes,
          imageMimeType: req.imageMimeType,
          imageAttachments: req.imageAttachments ?? [],
          priorTurns: req.priorTurns ?? [],
          signal: controller.signal,
          webSearchEnabled,
          overlayEnabled,
          onChunk: (delta) => {
            const now = performance.now();
            if (ttftMs === undefined) {
              ttftMs = Math.round(now - t0);
              firstChunkAt = now;
              lastExtractionAt = now;
            }
            lastChunkAt = now;
            chunkCount += 1;
            chunksSinceExtraction += 1;
            charCount += delta.length;
            chunkBuffer += delta;
            scheduleFlush();
            // Throttled — at most every 5 chunks or 100ms, never per-token.
            maybeRunExtraction();
          },
          onSearch: (query) => {
            usedWebSearch = true;
            // Fire a dedicated event so the renderer can flip a "Searching
            // the web" badge above the streaming text. Keeping it out of the
            // chunk buffer avoids interleaving with the answer prose.
            if (!sender.isDestroyed()) {
              sender.send(IPC.provider.searchStart, { query });
            }
          },
          onSource: ({ url, title }) => {
            if (!url) return;
            // Last-write-wins on title — if a later citation has a richer
            // title, prefer it.
            sourcesByUrl.set(url, { url, title: title || new URL(url).hostname });
          },
          onUsage: (usage) => {
            // Initialise on first emit, accumulate thereafter. Each
            // field is OR'd with 0 so a missing metric doesn't NaN
            // the total.
            if (!totalUsage) {
              totalUsage = {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationInputTokens: 0,
                cacheReadInputTokens: 0,
              };
            }
            totalUsage.inputTokens += usage.inputTokens ?? 0;
            totalUsage.outputTokens += usage.outputTokens ?? 0;
            totalUsage.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
            totalUsage.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
          },
        },
        credential,
      );
      flushChunks();
      // Final extraction pass — run unconditionally at stream end so any
      // throttled-skipped tail is captured.
      runStreamingExtraction();
      const t1 = performance.now();
      const streamDurationMs =
        firstChunkAt !== undefined && lastChunkAt !== undefined
          ? Math.round(lastChunkAt - firstChunkAt)
          : undefined;
      const timings = {
        apiMs: Math.round(t1 - t0),
        totalMs: Math.round(t1 - t0),
        ttftMs,
        streamChunks: chunkCount || undefined,
        streamDurationMs,
        streamCharCount: charCount || undefined,
      };
      const rate =
        streamDurationMs && streamDurationMs > 0
          ? Math.round((charCount / streamDurationMs) * 1000)
          : 0;
      console.log(
        `[optix-timing] provider=${activeProviderId} model=${modelId} mode=${req.mode} ` +
          `api=${timings.apiMs}ms ttft=${ttftMs ?? 'n/a'}ms chunks=${chunkCount} ` +
          `stream=${streamDurationMs ?? 0}ms chars=${charCount} rate=${rate}char/s`,
      );

      // LOCATE auto-retry: when the user asked to visually locate something
      // and the model returned a prose-only answer with empty `targetRegions`,
      // immediately fire a second pass that demands the regions explicitly.
      // Models (especially Anthropic) sometimes hedge on coordinates and
      // produce a confident text answer with no overlay despite the strong
      // system-prompt rules — this catches that compliance gap so users
      // always get a visual anchor for "where is X" questions. Skips when
      // privacy is paused (no screenshot to anchor to anyway).
      const isLocateQuery = looksLikeLocateQuery(req.prompt);
      const noRegionsAtAll =
        response.targetRegions.length === 0 &&
        !response.steps.some((s) => s.targetRegion);
      const canRetry =
        req.mode === 'guide' &&
        overlayEnabled &&
        isLocateQuery &&
        noRegionsAtAll &&
        !!req.imageBytes;
      if (canRetry) {
        console.log('[optix-locate-retry] firing — empty regions for LOCATE prompt');
        try {
          const retryPrompt =
            'Your previous response correctly described where the element is, ' +
            'but `targetRegions` is empty. The user cannot see any overlay ' +
            'without that field — and they specifically asked you to show them ' +
            'visually. Re-emit your response with the same intent/answer/' +
            'confidence, but this time populate `targetRegions` with at least ' +
            'one bounding box around the element. Approximate coordinates are ' +
            'FINE — within ~30 pixels is plenty. Do not skip this field.';
          const retried = await provider.prompt(
            {
              mode: req.mode,
              prompt: retryPrompt,
              modelId,
              imageBytes: req.imageBytes,
              imageMimeType: req.imageMimeType,
              imageAttachments: [],
              priorTurns: [
                ...(req.priorTurns ?? []),
                { prompt: req.prompt, assistantText: response.answer },
              ],
              signal: controller.signal,
              webSearchEnabled: false,
              overlayEnabled,
              // No onChunk — first response already streamed to the
              // renderer; the retry just silently swaps in the regions.
            },
            credential,
          );
          const retriedHasRegions =
            retried.targetRegions.length > 0 ||
            retried.steps.some((s) => s.targetRegion);
          if (retriedHasRegions) {
            console.log('[optix-locate-retry] success — retry produced regions');
            response = retried;
          } else {
            console.warn('[optix-locate-retry] retry also empty — giving up');
          }
        } catch (err) {
          console.warn(
            '[optix-locate-retry] retry failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Snap regions: UIA first (OS-precise, handles icon-only buttons via
      // tooltip text), OCR for whatever UIA didn't touch. Each is best-effort
      // — on any failure we fall back to the model's bbox so the user still
      // gets *some* highlight.
      let refined = response;
      if (ocrPromise || uiaPromise) {
        const topRegions: TargetRegion[] = response.targetRegions ?? [];
        const stepRegions: TargetRegion[] = (response.steps ?? [])
          .map((s) => s.targetRegion)
          .filter((r): r is TargetRegion => !!r);
        const totalCount = topRegions.length + stepRegions.length;
        if (totalCount > 0) {
          // Image dimensions are required to map UIA's screen coords into
          // screenshot space. If the renderer didn't send them, skip both
          // snaps gracefully — this is the conservative thing to do; bad
          // scaling would move regions to the wrong place rather than
          // doing nothing.
          const haveImageDims =
            typeof req.imageWidth === 'number' &&
            typeof req.imageHeight === 'number' &&
            req.imageWidth > 0 &&
            req.imageHeight > 0;

          let workingTop = topRegions;
          let workingSteps = stepRegions;
          let uiaSnappedCount = 0;
          let ocrSnappedCount = 0;

          // --- UIA pass --------------------------------------------------
          // Build a "snapped by UIA?" mask so the OCR pass can skip those.
          let uiaMaskTop: boolean[] = topRegions.map(() => false);
          let uiaMaskSteps: boolean[] = stepRegions.map(() => false);

          if (uiaPromise && haveImageDims) {
            try {
              const uiaElements = await uiaPromise;
              if (uiaElements.length > 0) {
                const displayBounds = screen.getPrimaryDisplay().bounds;
                const snappedTop = snapRegionsToUia(
                  topRegions,
                  uiaElements,
                  displayBounds,
                  req.imageWidth as number,
                  req.imageHeight as number,
                );
                const snappedSteps = snapRegionsToUia(
                  stepRegions,
                  uiaElements,
                  displayBounds,
                  req.imageWidth as number,
                  req.imageHeight as number,
                );
                uiaMaskTop = topRegions.map((orig, i) => {
                  const next = snappedTop[i];
                  if (!next) return false;
                  return (
                    orig.x !== next.x ||
                    orig.y !== next.y ||
                    orig.width !== next.width ||
                    orig.height !== next.height
                  );
                });
                uiaMaskSteps = stepRegions.map((orig, i) => {
                  const next = snappedSteps[i];
                  if (!next) return false;
                  return (
                    orig.x !== next.x ||
                    orig.y !== next.y ||
                    orig.width !== next.width ||
                    orig.height !== next.height
                  );
                });
                uiaSnappedCount =
                  countUiaSnapped(topRegions, snappedTop) +
                  countUiaSnapped(stepRegions, snappedSteps);
                workingTop = snappedTop;
                workingSteps = snappedSteps;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[optix-snap] UIA failed, falling through: ${msg}`);
            }
          }

          // --- OCR pass --------------------------------------------------
          // Only run OCR snap on regions UIA didn't already snap. We snap
          // the full arrays then selectively merge so the snap function's
          // index alignment with the originals stays simple.
          if (ocrPromise) {
            try {
              const ocrBoxes = await ocrPromise;
              if (ocrBoxes.length > 0) {
                const ocrSnappedTop = snapRegionsToOcr(workingTop, ocrBoxes);
                const ocrSnappedSteps = snapRegionsToOcr(
                  workingSteps,
                  ocrBoxes,
                );
                const mergedTop = workingTop.map((cur, i) => {
                  if (uiaMaskTop[i]) return cur; // UIA wins — leave it.
                  return ocrSnappedTop[i] ?? cur;
                });
                const mergedSteps = workingSteps.map((cur, i) => {
                  if (uiaMaskSteps[i]) return cur;
                  return ocrSnappedSteps[i] ?? cur;
                });
                ocrSnappedCount =
                  countSnapped(workingTop, mergedTop) +
                  countSnapped(workingSteps, mergedSteps);
                workingTop = mergedTop;
                workingSteps = mergedSteps;
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[optix-snap] OCR failed, using prior bounds: ${msg}`);
            }
          }

          console.log(
            `[optix-snap] uia=${uiaSnappedCount}/${totalCount} ` +
              `ocr=${ocrSnappedCount}/${totalCount} total=${totalCount}`,
          );

          // Stitch snapped per-step regions back onto the steps array in
          // the same order we extracted them.
          let stepIdx = 0;
          const newSteps = (response.steps ?? []).map((s) => {
            if (!s.targetRegion) return s;
            const next = workingSteps[stepIdx++];
            return next ? { ...s, targetRegion: next } : s;
          });
          refined = {
            ...response,
            steps: newSteps,
            targetRegions: workingTop,
          };
        }
      }

      // (Round 7: dropped legacy in-memory `record(...)` call. The
      // session-history ring buffer it wrote to was Phase-1 dead code
      // displaced by the persistent chat-history store; renderer never
      // consumed it.)
      const sources = Array.from(sourcesByUrl.values()).slice(0, 8);
      // Trim totalUsage to undefined keys removed so the wire payload
      // doesn't carry zeroes when the provider never reported usage
      // (older providers, or runs that errored before the usage block
      // was returned).
      const usage = totalUsage
        ? {
            inputTokens: totalUsage.inputTokens || undefined,
            outputTokens: totalUsage.outputTokens || undefined,
            cacheCreationInputTokens:
              totalUsage.cacheCreationInputTokens || undefined,
            cacheReadInputTokens:
              totalUsage.cacheReadInputTokens || undefined,
          }
        : undefined;
      return { response: refined, timings, usedWebSearch, sources, usage };
    } catch (err) {
      flushChunks();
      const tErr = performance.now();
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[optix-timing] provider=${activeProviderId} model=${modelId} mode=${req.mode} FAILED after=${Math.round(tErr - t0)}ms err=${message}`,
      );
      // (Round 7: dropped legacy in-memory `record(error)` call — see
      // success-path comment above.)
      // Don't re-throw the raw provider/SDK error — it can carry stack
      // traces, internal URLs, or HTTP body fragments that leak into
      // the renderer. Surface a stable, sanitized Error with a generic
      // message plus a structured `code` for future UX branching.
      // TODO(renderer): App.tsx currently displays `err.message`
      //   verbatim — once the renderer reads `err.code` instead, swap
      //   the generic copy for code-specific user messaging.
      let code: 'aborted' | 'auth' | 'billing' | 'rate_limited' | 'failed' =
        'failed';
      const lower = message.toLowerCase();
      if (controller.signal.aborted || lower.includes('abort')) {
        code = 'aborted';
      } else if (
        lower.includes('401') ||
        lower.includes('unauthor') ||
        lower.includes('invalid api key') ||
        lower.includes('not signed in')
      ) {
        code = 'auth';
      } else if (
        lower.includes('quota') ||
        lower.includes('billing') ||
        lower.includes('insufficient')
      ) {
        code = 'billing';
      } else if (
        lower.includes('429') ||
        lower.includes('rate limit') ||
        lower.includes('too many requests')
      ) {
        code = 'rate_limited';
      }
      const sanitized = new Error('provider request failed') as Error & {
        code: typeof code;
      };
      sanitized.code = code;
      throw sanitized;
    } finally {
      if (currentAbort === controller) currentAbort = null;
    }
  });

  ipcMain.handle(IPC.provider.cancel, async () => {
    currentAbort?.abort();
    currentAbort = null;
  });

  ipcMain.handle(IPC.provider.testKey, async (_event, rawId: unknown) => {
    const providerId = ProviderIdSchema.parse(rawId);
    // Optix Cloud has no stored key — the sign-in UI in Settings is the
    // canonical source of truth for "is this connection working." Phase B
    // (magic-link flow) will add a dedicated relay-ping button there.
    if (providerId === 'optixCloud') {
      return {
        ok: false as const,
        error: 'Optix Cloud uses sign-in instead of an API key — use the Sign in button.',
      };
    }
    const provider = getProvider(providerId);
    const apiKey = await getApiKey(providerId);
    if (!apiKey) return { ok: false as const, error: 'No API key stored for this provider.' };
    try {
      await provider.testKey(apiKey);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
