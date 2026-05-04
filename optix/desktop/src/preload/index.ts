import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { CaptureResult, OptixApi, OverlayRenderPayload } from '../shared/api';

// The whitelisted surface exposed to both renderers. Renderer code NEVER
// touches ipcRenderer directly; everything funnels through this bridge. If we
// need to add a new capability, we add a channel here and a matching handler
// on the main side — there's no "escape hatch".

// --- Screen capture ---
// We use navigator.mediaDevices.getDisplayMedia (routed through Chromium's
// modern capture pipeline — WGC on Windows 10 2004+). WGC honours the
// WDA_EXCLUDEFROMCAPTURE flag we set on the widget via `setContentProtection`,
// so the widget is truly invisible in its own captures without any hide/show
// flicker.
//
// We hold one MediaStream + <video> across the session so per-capture cost is
// just canvas.drawImage (~30ms) after the one-time ~2s stream setup.

let heldStream: MediaStream | null = null;
let heldVideo: HTMLVideoElement | null = null;

async function openStream(): Promise<HTMLVideoElement> {
  if (heldVideo && heldStream && heldStream.active) {
    return heldVideo;
  }
  releaseStream();

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { ideal: 1600 },
      height: { ideal: 1600 },
    },
    audio: false,
  });

  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.srcObject = stream;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error('Video element failed to load capture stream.'));
  });
  await video.play();

  heldStream = stream;
  heldVideo = video;
  return video;
}

function releaseStream(): void {
  heldStream?.getTracks().forEach((t) => t.stop());
  heldStream = null;
  heldVideo = null;
}

async function prewarm(): Promise<void> {
  try {
    await openStream();
  } catch {
    // Swallow — privacy mode or capture denial. Next actual capture will
    // surface the real error to the user.
  }
}

async function captureScreen(): Promise<CaptureResult> {
  const t0 = performance.now();
  const video = await openStream();
  const tStream = performance.now();

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2d context unavailable.');
  ctx.drawImage(video, 0, 0);
  const tFrame = performance.now();

  // toBlob → arrayBuffer is dramatically faster than toDataURL because we
  // skip the browser-side base64 step entirely. Main encodes to base64 once
  // (cheaply, in Node) when building each provider's request.
  const mimeType = 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null.'))),
      mimeType,
      0.85,
    );
  });
  const arrayBuffer = await blob.arrayBuffer();
  const imageBytes = new Uint8Array(arrayBuffer);
  const tEncode = performance.now();

  return {
    imageBytes,
    imageMimeType: mimeType,
    width: canvas.width,
    height: canvas.height,
    timings: {
      grabMs: Math.round(tStream - t0),
      resizeMs: Math.round(tFrame - tStream),
      encodeMs: Math.round(tEncode - tFrame),
      totalMs: Math.round(tEncode - t0),
    },
  };
}

const api: OptixApi = {
  capture: {
    screen: captureScreen,
    prewarm,
    reset: async () => releaseStream(),
    foregroundHwnd: () => ipcRenderer.invoke(IPC.capture.foregroundHwnd),
  },
  provider: {
    prompt: (req) => ipcRenderer.invoke(IPC.provider.prompt, req),
    cancel: () => ipcRenderer.invoke(IPC.provider.cancel),
    testKey: (providerId) => ipcRenderer.invoke(IPC.provider.testKey, providerId),
    onChunk: (cb) => {
      const listener = (_: unknown, payload: { delta: string }) => cb(payload.delta);
      ipcRenderer.on(IPC.provider.chunk, listener);
      return () => ipcRenderer.removeListener(IPC.provider.chunk, listener);
    },
    onSearchStart: (cb) => {
      const listener = (_: unknown, payload: { query: string }) => cb(payload.query);
      ipcRenderer.on(IPC.provider.searchStart, listener);
      return () => ipcRenderer.removeListener(IPC.provider.searchStart, listener);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (patch) => ipcRenderer.invoke(IPC.settings.set, patch),
    setApiKey: (providerId, apiKey) =>
      ipcRenderer.invoke(IPC.settings.setApiKey, { providerId, apiKey }),
    hasApiKey: (providerId) => ipcRenderer.invoke(IPC.settings.hasApiKey, providerId),
    deleteApiKey: (providerId) => ipcRenderer.invoke(IPC.settings.deleteApiKey, providerId),
    onChange: (cb) => {
      const listener = (_: unknown, settings: unknown) => cb(settings as never);
      ipcRenderer.on(IPC.settings.changed, listener);
      return () => ipcRenderer.removeListener(IPC.settings.changed, listener);
    },
  },
  history: {
    list: () => ipcRenderer.invoke(IPC.history.list),
    clear: () => ipcRenderer.invoke(IPC.history.clear),
  },
  widget: {
    hide: () => ipcRenderer.invoke(IPC.widget.hide),
    setFocusable: (focusable) =>
      ipcRenderer.invoke(IPC.widget.setFocusable, { focusable }),
    beginTextInput: () => ipcRenderer.invoke(IPC.widget.beginTextInput),
    endTextInput: () => ipcRenderer.invoke(IPC.widget.endTextInput),
    setCompact: (compact) => ipcRenderer.invoke(IPC.widget.setCompact, { compact }),
    chooseWorkspaceFolder: () => ipcRenderer.invoke(IPC.widget.chooseWorkspaceFolder),
    pickImages: () => ipcRenderer.invoke(IPC.widget.pickImages),
  },
  overlay: {
    show: (req) => ipcRenderer.invoke(IPC.overlay.show, req),
    hide: () => ipcRenderer.invoke(IPC.overlay.hide),
    onRender: (cb) => {
      const listener = (_: unknown, payload: OverlayRenderPayload) => cb(payload);
      ipcRenderer.on(IPC.overlay.render, listener);
      return () => ipcRenderer.removeListener(IPC.overlay.render, listener);
    },
  },
  action: {
    execute: (req) => ipcRenderer.invoke(IPC.action.execute, req),
  },
  computer: {
    start: (req) => ipcRenderer.invoke(IPC.computer.start, req),
    continue: (req) => ipcRenderer.invoke(IPC.computer.continue, req),
    appendUserMessage: (req) =>
      ipcRenderer.invoke(IPC.computer.appendUserMessage, req),
    end: (loopId, outcome) =>
      ipcRenderer.invoke(IPC.computer.end, { loopId, outcome }),
    abort: (loopId) => ipcRenderer.invoke(IPC.computer.abort, { loopId }),
    execute: (req) => ipcRenderer.invoke(IPC.computer.execute, req),
    executeFile: (req) => ipcRenderer.invoke(IPC.computer.executeFile, req),
    executeLabel: (req) => ipcRenderer.invoke(IPC.computer.executeLabel, req),
    executeShell: (req) => ipcRenderer.invoke(IPC.computer.executeShell, req),
    resolveShellCwd: (cwd) =>
      ipcRenderer.invoke(IPC.computer.resolveShellCwd, { cwd }),
    queryRecordingContext: (point) =>
      ipcRenderer.invoke(IPC.computer.queryRecordingContext, { point }),
    isPathInScope: (path) => ipcRenderer.invoke(IPC.computer.isPathInScope, { path }),
  },
  audit: {
    list: () => ipcRenderer.invoke(IPC.audit.list),
    read: (filename) => ipcRenderer.invoke(IPC.audit.read, { filename }),
    export: (filename, format) =>
      ipcRenderer.invoke(IPC.audit.export, { filename, format }),
    delete: (filename) => ipcRenderer.invoke(IPC.audit.delete, { filename }),
  },
  auth: {
    startLoopback: () => ipcRenderer.invoke(IPC.auth.startLoopback),
    stopLoopback: () => ipcRenderer.invoke(IPC.auth.stopLoopback),
    onLoopbackCallback: (cb) => {
      const listener = (_: unknown, payload: { url: string }) => cb(payload.url);
      ipcRenderer.on(IPC.auth.loopbackCallback, listener);
      return () => ipcRenderer.removeListener(IPC.auth.loopbackCallback, listener);
    },
    setPendingEmail: (req) => ipcRenderer.invoke(IPC.auth.setPendingEmail, req),
    consumePendingEmail: () => ipcRenderer.invoke(IPC.auth.consumePendingEmail),
    clearPendingEmail: () => ipcRenderer.invoke(IPC.auth.clearPendingEmail),
  },
  stripe: {
    startCheckout: (req) => ipcRenderer.invoke(IPC.stripe.startCheckout, req),
    cancelCheckout: () => ipcRenderer.invoke(IPC.stripe.cancelCheckout),
    onCheckoutCallback: (cb) => {
      const listener = (_: unknown, payload: { url: string }) => cb(payload.url);
      ipcRenderer.on(IPC.stripe.checkoutCallback, listener);
      return () =>
        ipcRenderer.removeListener(IPC.stripe.checkoutCallback, listener);
    },
    updateSubscription: (req) =>
      ipcRenderer.invoke(IPC.stripe.updateSubscription, req),
    openCustomerPortal: (req) =>
      ipcRenderer.invoke(IPC.stripe.openCustomerPortal, req),
  },
  chatHistory: {
    start: (req) => ipcRenderer.invoke(IPC.chatHistory.start, req),
    appendTurn: (req) => ipcRenderer.invoke(IPC.chatHistory.appendTurn, req),
    list: () => ipcRenderer.invoke(IPC.chatHistory.list),
    read: (id) => ipcRenderer.invoke(IPC.chatHistory.read, { id }),
    delete: (id) => ipcRenderer.invoke(IPC.chatHistory.delete, { id }),
    readAttachment: (convId, p) =>
      ipcRenderer.invoke(IPC.chatHistory.readAttachment, { convId, path: p }),
  },
  plan: {
    read: () => ipcRenderer.invoke(IPC.plan.read),
    save: (req) => ipcRenderer.invoke(IPC.plan.save, req),
    clear: () => ipcRenderer.invoke(IPC.plan.clear),
    onChanged: (cb) => {
      const listener = (_e: unknown, plan: unknown) => cb(plan as any);
      ipcRenderer.on(IPC.plan.changed, listener);
      return () => ipcRenderer.removeListener(IPC.plan.changed, listener);
    },
  },
  routines: {
    list: () => ipcRenderer.invoke(IPC.routines.list),
    read: (id) => ipcRenderer.invoke(IPC.routines.read, { id }),
    readByOaNumber: (n) => ipcRenderer.invoke(IPC.routines.readByOaNumber, { n }),
    save: (req) => ipcRenderer.invoke(IPC.routines.save, req),
    update: (req) => ipcRenderer.invoke(IPC.routines.update, req),
    delete: (id) => ipcRenderer.invoke(IPC.routines.delete, { id }),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on(IPC.routines.changed, listener);
      return () => ipcRenderer.removeListener(IPC.routines.changed, listener);
    },
  },
};

contextBridge.exposeInMainWorld('optix', api);
