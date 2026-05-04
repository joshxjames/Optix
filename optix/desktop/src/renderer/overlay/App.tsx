import React, { useEffect, useState } from 'react';
import type { OverlayRenderPayload } from '../../shared/api';

const LABEL_HEIGHT_PX = 22;

export function App(): JSX.Element | null {
  const [payload, setPayload] = useState<OverlayRenderPayload | null>(null);

  useEffect(() => {
    // Wrap the callback body so a thrown exception inside setPayload
    // (or any future logic we add here) doesn't propagate up through
    // the IPC dispatcher — that path tears down the listener and
    // leaves the overlay deaf to subsequent renders. Catching here
    // keeps the unsubscribe handle valid and the listener alive.
    const unsubscribe = window.optix.overlay.onRender((next) => {
      try {
        setPayload(next ?? null);
      } catch (err) {
        console.error('[optix-overlay] onRender handler threw:', err);
      }
    });
    return () => {
      unsubscribe();
    };
  }, []);

  if (!payload) return null;

  const { regions, imageWidth, imageHeight, displayWidth, displayHeight } = payload;
  if (!regions || regions.length === 0) return null;
  if (!imageWidth || !imageHeight) return null;

  const scaleX = displayWidth / imageWidth;
  const scaleY = displayHeight / imageHeight;

  return (
    <div className="overlay">
      {regions.map((region, idx) => {
        const left = region.x * scaleX;
        const top = region.y * scaleY;
        const width = region.width * scaleX;
        const height = region.height * scaleY;
        const labelAbove = top >= LABEL_HEIGHT_PX + 4;
        const label = region.label ?? `Region ${idx + 1}`;

        return (
          <React.Fragment key={`${idx}-${label}`}>
            <div
              className="overlay__box"
              style={{
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
              }}
            />
            <div
              className="overlay__label"
              style={{
                left: `${left}px`,
                top: labelAbove
                  ? `${top - LABEL_HEIGHT_PX - 4}px`
                  : `${top + 4}px`,
              }}
            >
              {label}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
