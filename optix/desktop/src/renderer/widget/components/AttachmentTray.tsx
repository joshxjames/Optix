import { useState } from 'react';

export type StagedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Object URL for thumbnail rendering — created on add, revoked on remove.
   *  Lifecycle is owned by the parent (App.tsx around lines 766/808/815) which
   *  calls `URL.revokeObjectURL` on submit / remove / clear. This component
   *  intentionally does NOT revoke in a `useEffect` cleanup because remount
   *  during normal re-renders would destroy still-live URLs. */
  previewUrl: string;
};

type Props = {
  attachments: StagedAttachment[];
  onRemove: (id: string) => void;
};

/** Small horizontal strip of thumbnail chips. Each chip shows a 32×32
 *  preview of the attached image with an X to remove. Hidden entirely
 *  when no attachments are staged. */
export function AttachmentTray({ attachments, onRemove }: Props) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-tray">
      {attachments.map((a) => (
        <AttachmentChip key={a.id} attachment={a} onRemove={onRemove} />
      ))}
    </div>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: StagedAttachment;
  onRemove: (id: string) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <span className="attachment-tray__chip" title={attachment.filename}>
      {imgFailed ? (
        <span className="attachment-tray__icon" aria-hidden="true">📎</span>
      ) : (
        <img
          src={attachment.previewUrl}
          alt={attachment.filename}
          width={32}
          height={32}
          onError={() => setImgFailed(true)}
        />
      )}
      <button
        type="button"
        className="attachment-tray__remove"
        onClick={(e) => {
          // Stop bubbling to keep the parent `.widget`'s drag region
          // from consuming the click as a drag-end gesture.
          e.stopPropagation();
          onRemove(attachment.id);
        }}
        aria-label={`Remove ${attachment.filename}`}
        title="Remove"
      >
        ×
      </button>
    </span>
  );
}
