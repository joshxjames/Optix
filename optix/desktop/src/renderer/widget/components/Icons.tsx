// Tiny inline SVG icon set. Stroke-based (Lucide-style) so they read as
// part of the theme rather than fighting the colored-emoji aesthetic the
// app started with. All icons paint via `currentColor` so the parent
// button's text colour drives them — meaning disabled / hover / active
// states "just work" via the existing CSS rules.
//
// Sized at 14×14 to match the previous emoji metrics (`.btn--icon` is
// 26×26 with a 14px font-size).

type IconProps = {
  size?: number;
  className?: string;
};

const baseProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export function FolderIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  );
}

// --- Audit-log stats icons -----------------------------------------------
// Each pairs with a numeric value in the audit detail meta row. The
// `title` attribute on the parent <span> provides the explanation, so
// these icons are visual anchors rather than full labels.

export function MessageIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Speech bubble outline. */}
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function TurnsIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Circular arrow — represents one turn / iteration. */}
      <path d="M21 12a9 9 0 1 1-3.5-7.1" />
      <polyline points="21 4 21 10 15 10" />
    </svg>
  );
}

export function ActionsIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Lightning bolt — a discrete tool execution. */}
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function ClockIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

export function DisplayIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function ProviderIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Sparkle / AI glyph — pairs with the provider/model name. */}
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
      <path d="M19 14l.6 1.8L21 16l-1.4.5L19 18l-.6-1.5L17 16l1.4-.2z" />
    </svg>
  );
}

export function PaperclipIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Paperclip — pairs with attachment counts. */}
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49" />
    </svg>
  );
}

export function CameraIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Camera body + lens — pairs with screenshot counts. */}
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

export function CursorIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Classic OS mouse-pointer arrow — pairs with click actions in the
          run timeline / audit log. */}
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51z" />
    </svg>
  );
}

export function PlanListIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Clipboard-with-checklist outline — pairs with the Plan button
          in the controls row + the inline plan card in the timeline. */}
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <line x1="9" y1="11" x2="15" y2="11" />
      <line x1="9" y1="15" x2="15" y2="15" />
      <line x1="9" y1="19" x2="13" y2="19" />
    </svg>
  );
}

export function RecordIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Filled circle inside an outline — classic record glyph. The
          outer ring is stroked via baseProps; we paint the inner
          fill explicitly so the recording-active state can re-tint
          via currentColor on the parent button. */}
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function RoutinesIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Stacked-list / history glyph — three short lines suggesting
          a list of routines. Pairs with the Routines button in the
          Automate controls row. */}
      <line x1="8" y1="6" x2="20" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function HelpIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Question-mark inside a circle — the universal "help / docs"
          glyph. Pairs with the docs button in the widget header. */}
      <circle cx="12" cy="12" r="10" />
      <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4" />
      <line x1="12" y1="17" x2="12" y2="17.01" />
    </svg>
  );
}

export function NewChatIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      {/* Speech bubble + plus mark — pairs with the "Clear chat /
          start fresh" button in the controls row. */}
      <path d="M21 11.5a7 7 0 0 1-7 7H8l-5 3v-9.5a7 7 0 0 1 7-7h4a7 7 0 0 1 7 6.5z" />
      <line x1="11" y1="9" x2="13" y2="9" />
      <line x1="12" y1="8" x2="12" y2="10" />
    </svg>
  );
}

// --- Pause / resume / stop control icons --------------------------------
// Used by the unified StopButton in the actions row. Same outer circle on
// each so the button's silhouette stays stable as state changes — only
// the inner glyph (bars / triangle / square) swaps.

export function CirclePauseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="10" />
      <line x1="10" y1="9" x2="10" y2="15" />
      <line x1="14" y1="9" x2="14" y2="15" />
    </svg>
  );
}

export function CirclePlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="10 8 16 12 10 16 10 8" />
    </svg>
  );
}

export function CircleStopIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...baseProps(size)} className={className}>
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}
