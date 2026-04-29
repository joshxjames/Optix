// IPC channel name constants. Importing the same constant in main + preload
// prevents typo drift between handler and invoker.

export const IPC = {
  // Screen capture pixels are grabbed in the renderer via getDisplayMedia.
  // Main only contributes the foreground-HWND query — used by the smart
  // capture-reuse logic (skip the recapture when the user is still in
  // the same window as the last shot).
  capture: {
    /** Returns the foreground window's HWND as a decimal string, or null. */
    foregroundHwnd: 'capture:foregroundHwnd',
  },
  provider: {
    prompt: 'provider:prompt',
    cancel: 'provider:cancel',
    testKey: 'provider:testKey',
    // main → renderer: emits token deltas while a streaming provider call is
    // in flight. Renderer extracts the `answer` field progressively.
    chunk: 'provider:chunk',
    // main → renderer: fired once when a web search starts so the UI can
    // flip a "Searching..." badge before the response arrives.
    searchStart: 'provider:searchStart',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    setApiKey: 'settings:setApiKey',
    hasApiKey: 'settings:hasApiKey',
    deleteApiKey: 'settings:deleteApiKey',
    changed: 'settings:changed',
  },
  history: {
    list: 'history:list',
    clear: 'history:clear',
  },
  widget: {
    hide: 'widget:hide',
    // Toggle whether the widget can receive keyboard focus. Used during
    // per-action approval pauses so the user can type in our feedback
    // textarea — at all other times during a Computer Use loop the widget
    // stays non-focusable so robotjs typeString lands in the foreground app.
    setFocusable: 'widget:setFocusable',
    // Begin/end a text-input session. `begin` captures the current OS
    // foreground window, then makes the widget focusable + focuses it so
    // the user can type. `end` restores the previously-captured foreground
    // window so the next robotjs action lands where the user expected.
    beginTextInput: 'widget:beginTextInput',
    endTextInput: 'widget:endTextInput',
    // Toggle compact mode — shrink/restore the widget window to header-only.
    setCompact: 'widget:setCompact',
    // renderer → main: open a native directory picker and save the chosen
    // path to settings as the agent workspace. Returns the chosen path or
    // null if the user cancelled.
    chooseWorkspaceFolder: 'widget:chooseWorkspaceFolder',
    // renderer → main: open a file picker for images. Returns a list of
    // { filename, mimeType, bytes } for each selected image.
    pickImages: 'widget:pickImages',
  },
  overlay: {
    // renderer (widget) → main: show the overlay with these regions
    show: 'overlay:show',
    // renderer → main: hide the overlay
    hide: 'overlay:hide',
    // main → overlay renderer: render this payload
    render: 'overlay:render',
  },
  action: {
    // renderer → main: execute one approved action on the OS
    execute: 'action:execute',
  },
  computer: {
    // renderer → main: start a Computer Use loop with an initial prompt + screenshot
    start: 'computer:start',
    // renderer → main: feed tool_results back, get next turn
    continue: 'computer:continue',
    // renderer → main: append a NEW user message to a paused loop
    //   (conversationMode follow-ups). Agent keeps full memory.
    appendUserMessage: 'computer:appendUserMessage',
    // renderer → main: tear down a loop's adapter state. Used when
    //   the renderer-side conversation resets (new chat, mode toggle).
    end: 'computer:end',
    // renderer → main: abort the in-flight loop
    abort: 'computer:abort',
    // renderer → main: run a single computer-tool action via the executor
    execute: 'computer:execute',
    // renderer → main: run a single file-system action via the file executor
    executeFile: 'computer:executeFile',
    // renderer → main: run a single label-based action (resolve via UIA, then robotjs)
    executeLabel: 'computer:executeLabel',
    // renderer → main: run a single shell command and stream stdout/stderr back
    executeShell: 'computer:executeShell',
    // renderer → main: resolve the effective cwd for a shell command + check
    //   whether it falls inside the current workspace (drives the gating UX)
    resolveShellCwd: 'computer:resolveShellCwd',
    // renderer → main: capture semantic context (UIA element under point +
    //   foreground window title) for the routine recorder. Optional point —
    //   actions without coordinates still benefit from the window title.
    queryRecordingContext: 'computer:queryRecordingContext',
    // renderer → main: check whether a path is inside the user's workspace folder
    isPathInScope: 'computer:isPathInScope',
  },
  audit: {
    // renderer → main: list all audit log summaries newest-first
    list: 'audit:list',
    // renderer → main: read a single audit log by filename
    read: 'audit:read',
    // renderer → main: prompt the user with a save dialog and write the
    //   audit log to disk in the requested format
    export: 'audit:export',
    // renderer → main: delete an audit log by filename
    delete: 'audit:delete',
  },
  routines: {
    // renderer → main: list all routine summaries newest-first.
    list: 'routines:list',
    // renderer → main: read a single routine including its full
    //   action list.
    read: 'routines:read',
    // renderer → main: read a routine by its sequential OA number
    //   (the human-friendly identifier used in `/OA-{n}` tokens).
    readByOaNumber: 'routines:readByOaNumber',
    // renderer → main: persist a freshly-recorded run as a new
    //   routine. Returns the saved routine.
    save: 'routines:save',
    // renderer → main: edit an existing routine (rename / re-prompt /
    //   reorder + delete actions).
    update: 'routines:update',
    // renderer → main: drop a routine + its file.
    delete: 'routines:delete',
    // main → renderer: a routine was saved / updated / deleted; list
    //   views can refresh.
    changed: 'routines:changed',
  },
  plan: {
    // renderer → main: read the saved plan, or null if none.
    read: 'plan:read',
    // renderer → main: overwrite the saved plan with new content.
    save: 'plan:save',
    // renderer → main: drop the saved plan (clear button in the
    //   plan view).
    clear: 'plan:clear',
    // main → renderer: a plan was saved/cleared; renderer refreshes
    //   its plan-button + plan-view state.
    changed: 'plan:changed',
  },
  chatHistory: {
    // renderer → main: start a new conversation; returns id for renderer state
    start: 'chatHistory:start',
    // renderer → main: append a finalized turn (with attachment + capture
    //   bytes) to the conversation; main writes binaries to disk and the
    //   updated JSON. Returns the persisted ConversationTurn.
    appendTurn: 'chatHistory:appendTurn',
    // renderer → main: list all conversations newest-first (for the viewer)
    list: 'chatHistory:list',
    // renderer → main: read a single conversation by id
    read: 'chatHistory:read',
    // renderer → main: delete a conversation + its image directory
    delete: 'chatHistory:delete',
    // renderer → main: read one attachment's bytes by relative path
    readAttachment: 'chatHistory:readAttachment',
  },
} as const;
