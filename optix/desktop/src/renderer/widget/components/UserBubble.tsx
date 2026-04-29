import type { Mode } from '../../../shared/schemas';

/**
 * Renders the user's prompt text as a chat-bubble above each turn's
 * response. Shows attached upload filenames as small badges so the user
 * can see what they sent without expanding the bubble.
 */
export function UserBubble({
  prompt,
  mode,
  attachmentNames,
}: {
  prompt: string;
  mode: Mode;
  attachmentNames: string[];
}) {
  return (
    <div className="user-bubble" data-mode={mode}>
      <div className="user-bubble__text">{prompt}</div>
      {attachmentNames.length > 0 && (
        <div className="user-bubble__attachments">
          {attachmentNames.map((n, i) => (
            <span key={`${i}-${n}`} className="user-bubble__attachment">
              📎 {n}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
