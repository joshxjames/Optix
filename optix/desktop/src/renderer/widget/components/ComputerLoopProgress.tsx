import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AskUserAction,
  ComputerToolAction,
  FileToolAction,
  LabelToolAction,
  MetaToolAction,
  PlanToolAction,
  ShellToolAction,
} from '../../../shared/schemas';
import { ChoicePrompt } from './ChoicePrompt';
import { PlanApprovalGate } from './PlanApprovalGate';
import { CursorIcon } from './Icons';

export type LoopStepState = 'running' | 'done' | 'failed';

export type LoopActionItem = {
  kind: 'action';
  toolUseId: string;
  description: string;
  actionKind:
    | ComputerToolAction['action']
    | FileToolAction['action']
    | LabelToolAction['action']
    | MetaToolAction['action']
    | PlanToolAction['action']
    | ShellToolAction['action'];
  state: LoopStepState;
  errorText?: string;
};

export type LoopMessageItem = {
  kind: 'message';
  /** Stable key — turnIndex-based so React doesn't re-mount on rerender. */
  id: string;
  text: string;
  /** Render as the conclusion at the end of the run (slightly different
   *  styling so it reads as the final summary). */
  isFinal?: boolean;
};

export type LoopItem = LoopActionItem | LoopMessageItem;

/** Glyph per agent action kind (computer + file tools). Exported so the
 *  audit log viewer uses the same set of icons as the live run UI. */
export const ACTION_ICON: Partial<
  Record<
    | ComputerToolAction['action']
    | FileToolAction['action']
    | LabelToolAction['action']
    | MetaToolAction['action']
    | PlanToolAction['action']
    | ShellToolAction['action'],
    ReactNode
  >
> = {
  // Plan tool — agent proposed a plan that needs the user's blessing.
  set_plan: '📋',
  // Shell tool — agent wants to run a command.
  run_command: '⚡',
  // Computer-tool actions. Click variants share the SVG cursor icon so
  // they read as "pointer-driven" at a glance instead of as a stubby
  // unicode arrow.
  left_click: <CursorIcon />,
  right_click: <CursorIcon />,
  middle_click: <CursorIcon />,
  double_click: <CursorIcon />,
  triple_click: <CursorIcon />,
  left_click_drag: '↔',
  mouse_move: '➤',
  left_mouse_down: '⇩',
  left_mouse_up: '⇧',
  type: '⌨',
  key: '⌨',
  hold_key: '⌨',
  scroll: '↕',
  screenshot: '📷',
  wait: '⏱',
  cursor_position: '📍',
  // File-tool actions
  list_directory: '📁',
  read_file: '📄',
  search_files: '🔍',
  write_file: '✏',
  create_directory: '📂',
  // Label-based actions — same icons as their pixel counterparts to keep
  // the timeline visually consistent.
  click_label: <CursorIcon />,
  scroll_label: '↕',
  type_into_label: '⌨',
};

type Props = {
  /** Chronological mix of model-emitted messages and executed actions. */
  items: LoopItem[];
  turnIndex: number;
  /** True when the loop has finished — render a final-state header. */
  done?: boolean;
  /** True when the loop was capped (max turns reached). */
  capped?: boolean;
  /** When set, the action with this toolUseId is awaiting per-action
   *  approval. Approve / Deny / Type-something controls render inline. */
  pendingActionId?: string;
  onApprove?: () => void;
  onDeny?: () => void;
  /** User typed feedback for the model — sent as a tool_result correction so
   *  the model re-plans based on what the user wants instead. */
  onFeedback?: (text: string) => void;
  /** When set, the agent has called the `ask_user` meta tool and the
   *  loop is paused for user input. Renders a ChoicePrompt inline at
   *  the action's row; `onChoice` receives the picked value. */
  pendingAsk?: { toolUseId: string; action: AskUserAction };
  onChoice?: (value: string) => void;
  /** When set, the agent proposed a plan via the `plan` tool and the
   *  loop is paused for the user to approve / deny / send feedback.
   *  Renders a PlanApprovalGate inline at the action's row. */
  pendingPlan?: { toolUseId: string; action: PlanToolAction };
  onPlanDecision?: (
    decision:
      | { kind: 'approve' }
      | { kind: 'deny' }
      | { kind: 'feedback'; text: string },
  ) => void;
};

export function ComputerLoopProgress({
  items,
  turnIndex,
  done,
  capped,
  pendingActionId,
  onApprove,
  onDeny,
  onFeedback,
  pendingAsk,
  onChoice,
  pendingPlan,
  onPlanDecision,
}: Props) {
  const headerLabel = done
    ? capped
      ? 'Stopped — turn limit reached'
      : 'Done'
    : pendingActionId
      ? 'Awaiting approval'
      : `Working… turn ${turnIndex + 1}`;
  const actionCount = items.filter((i) => i.kind === 'action').length;

  // Auto-scroll: keep the most recent item (or the pending-approval /
  // ask-user step) visible. Re-runs when items count or pending state
  // changes.
  const lastItemRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!lastItemRef.current) return;
    lastItemRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [items.length, pendingActionId, pendingAsk?.toolUseId, pendingPlan?.toolUseId, done]);

  return (
    <article className={`response loop ${done ? 'loop--done' : 'loop--running'}`}>
      <header className="response__header">
        <span className="response__intent">{headerLabel}</span>
        <span className="response__confidence" title="Steps executed">
          {actionCount} step{actionCount === 1 ? '' : 's'}
        </span>
      </header>
      <div className="response__scroll">
        {items.length > 0 && (
          <ul className="loop__steps">
            {items.map((item, i) => {
              const isLast = i === items.length - 1;
              if (item.kind === 'message') {
                return (
                  <li
                    key={item.id}
                    ref={isLast ? lastItemRef : undefined}
                    className={`loop__message${item.isFinal ? ' loop__message--final' : ''}`}
                  >
                    {item.text}
                  </li>
                );
              }
              const isPending = pendingActionId === item.toolUseId;
              const isAskingHere = pendingAsk?.toolUseId === item.toolUseId;
              const isPlanningHere = pendingPlan?.toolUseId === item.toolUseId;
              return (
                <li
                  key={item.toolUseId}
                  ref={isLast ? lastItemRef : undefined}
                  className={`loop__step loop__step--${item.state}${isPending || isPlanningHere ? ' loop__step--pending-approval' : ''}`}
                >
                  <span className="loop__step-icon" aria-hidden="true">
                    {ACTION_ICON[item.actionKind] ?? '•'}
                  </span>
                  <span className="loop__step-desc">{item.description}</span>
                  <span className={`loop__step-status loop__step-status--${item.state}`}>
                    {isPending || isAskingHere || isPlanningHere
                      ? ''
                      : item.state === 'running'
                        ? '…'
                        : item.state === 'done'
                          ? '✓'
                          : item.state === 'failed'
                            ? '✗'
                            : ''}
                  </span>
                  {item.state === 'failed' && item.errorText && (
                    <span className="loop__step-error">{item.errorText}</span>
                  )}
                  {isPending && (
                    <PerActionApproval
                      // Re-key on toolUseId so any in-progress text input is
                      // discarded between actions.
                      key={item.toolUseId}
                      onApprove={() => onApprove?.()}
                      onDeny={() => onDeny?.()}
                      onFeedback={(text) => onFeedback?.(text)}
                    />
                  )}
                  {isAskingHere && pendingAsk && (
                    <ChoicePrompt
                      key={pendingAsk.toolUseId}
                      action={pendingAsk.action}
                      onSubmit={(value) => onChoice?.(value)}
                    />
                  )}
                  {isPlanningHere && pendingPlan && (
                    <PlanApprovalGate
                      key={pendingPlan.toolUseId}
                      action={pendingPlan.action}
                      onDecide={(d) => onPlanDecision?.(d)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}

function PerActionApproval({
  onApprove,
  onDeny,
  onFeedback,
}: {
  onApprove: () => void;
  onDeny: () => void;
  onFeedback: (text: string) => void;
}) {
  const [showInput, setShowInput] = useState(false);
  const [feedback, setFeedback] = useState('');

  // When the textarea opens we briefly need keyboard focus on the widget;
  // when it closes (or the component unmounts because the next action is
  // up), we hand focus back to the user's target app via the saved HWND.
  useEffect(() => {
    if (showInput) {
      void window.optix.widget.beginTextInput();
      return () => {
        void window.optix.widget.endTextInput();
      };
    }
    return undefined;
  }, [showInput]);

  function submit(): void {
    const text = feedback.trim();
    if (!text) return;
    // Close the input first so the useEffect cleanup restores foreground
    // BEFORE the loop sends the feedback and runs the next action.
    setShowInput(false);
    onFeedback(text);
  }

  function approveAndClose(): void {
    if (showInput) setShowInput(false);
    onApprove();
  }
  function denyAndClose(): void {
    if (showInput) setShowInput(false);
    onDeny();
  }

  return (
    <div className="loop__step-approval">
      <div className="loop__step-approval-buttons">
        <button
          type="button"
          className="btn btn--small btn--primary"
          onClick={approveAndClose}
        >
          Approve
        </button>
        <button
          type="button"
          className={`btn btn--small${showInput ? ' btn--toggled' : ''}`}
          onClick={() => setShowInput((s) => !s)}
        >
          Type something
        </button>
        <button
          type="button"
          className="btn btn--small"
          onClick={denyAndClose}
        >
          Deny
        </button>
      </div>
      {showInput && (
        <div className="loop__step-feedback">
          <textarea
            className="loop__step-feedback-input"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Tell the agent what to do instead…"
            rows={2}
            autoFocus
          />
          <button
            type="button"
            className="btn btn--small btn--primary"
            onClick={submit}
            disabled={!feedback.trim()}
          >
            Send
          </button>
        </div>
      )}
    </div>
  );
}
