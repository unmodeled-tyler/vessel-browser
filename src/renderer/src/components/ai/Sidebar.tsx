import {
  createSignal,
  For,
  Show,
  createEffect,
  createMemo,
  onCleanup,
  type Component,
} from "solid-js";
import { useAI } from "../../stores/ai";
import { useRuntime } from "../../stores/runtime";
import { useUI } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { useBookmarks } from "../../stores/bookmarks";
import { renderMarkdown } from "../../lib/markdown";
import {
  getBookmarkSearchMatch,
  normalizeBookmarkSearchText,
} from "../../../../shared/bookmark-search";
import type { BookmarkFolder } from "../../../../shared/types";
import { useScrollFade } from "../../lib/useScrollFade";
import vesselLogo from "../../assets/vessel-logo-transparent.png";
import "./ai.css";

const UNSORTED_FOLDER: BookmarkFolder = {
  id: "unsorted",
  name: "Unsorted",
  createdAt: "",
};

const MarkdownMessage = (props: { content: string }) => {
  const html = createMemo(() => renderMarkdown(props.content));

  return <div class="message-content markdown-content" innerHTML={html()} />;
};

const DropdownSelect = (props: {
  value: string;
  options: Array<{ value: string; label: string; description?: string }>;
  onChange: (value: string) => void;
  class?: string;
  ariaLabel?: string;
}) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  const selectedLabel = createMemo(
    () =>
      props.options.find((option) => option.value === props.value)?.label ||
      props.options[0]?.label ||
      "",
  );

  createEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  return (
    <div class={`dropdown-select ${props.class || ""}`} ref={rootRef}>
      <button
        class="dropdown-select-trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-label={props.ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span class="dropdown-select-value">{selectedLabel()}</span>
        <span
          class="dropdown-select-caret"
          classList={{ open: open() }}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div class="dropdown-select-menu" role="listbox">
          <For each={props.options}>
            {(option) => (
              <button
                class="dropdown-select-option"
                classList={{ selected: option.value === props.value }}
                type="button"
                role="option"
                aria-selected={option.value === props.value}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                }}
              >
                <span class="dropdown-select-option-copy">
                  <span class="dropdown-select-option-label">
                    {option.label}
                  </span>
                  <Show when={option.description}>
                    <span class="dropdown-select-option-description">
                      {option.description}
                    </span>
                  </Show>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

const Sidebar: Component<{ forceOpen?: boolean }> = (props) => {
  const {
    messages,
    streamingText,
    isStreaming,
    hasFirstChunk,
    streamStartedAt,
    clearHistory,
    query,
    cancel,
  } = useAI();
  const {
    runtimeState,
    pause,
    resume,
    setApprovalMode,
    resolveApproval,
    createCheckpoint,
    restoreCheckpoint,
    restoreSession,
  } = useRuntime();
  const {
    sidebarOpen,
    sidebarWidth,
    resizeSidebar,
    commitResize,
    toggleSidebar,
  } = useUI();
  const { activeTab, createTab } = useTabs();
  const {
    bookmarksState,
    saveBookmark,
    removeBookmark,
    createFolderWithSummary,
    removeFolder,
    renameFolder,
  } = useBookmarks();
  const [sidebarTab, setSidebarTab] = createSignal<"supervisor" | "bookmarks" | "checkpoints" | "chat">("supervisor");
  const [chatInput, setChatInput] = createSignal("");
  const [highlightCount, setHighlightCount] = createSignal(0);
  const [highlightIndex, setHighlightIndex] = createSignal(-1);

  // Poll for highlight count when chat tab is active
  createEffect(() => {
    if (sidebarTab() !== "chat") return;
    const poll = async () => {
      try {
        const count = await (window as any).vessel?.highlights?.getCount?.() ?? 0;
        setHighlightCount(count);
        // Reset index if highlights were cleared
        if (count === 0 && highlightIndex() >= 0) setHighlightIndex(-1);
      } catch { /* ignore */ }
    };
    void poll();
    const id = setInterval(poll, 2000);
    onCleanup(() => clearInterval(id));
  });

  const scrollToHighlight = async (idx: number) => {
    const count = highlightCount();
    if (count === 0) return;
    const clamped = Math.max(0, Math.min(idx, count - 1));
    setHighlightIndex(clamped);
    await (window as any).vessel?.highlights?.scrollTo?.(clamped);
  };

  const removeCurrentHighlight = async () => {
    const idx = highlightIndex();
    if (idx < 0) return;
    await (window as any).vessel?.highlights?.remove?.(idx);
    const newCount = await (window as any).vessel?.highlights?.getCount?.() ?? 0;
    setHighlightCount(newCount);
    if (newCount === 0) {
      setHighlightIndex(-1);
    } else if (idx >= newCount) {
      setHighlightIndex(newCount - 1);
      await (window as any).vessel?.highlights?.scrollTo?.(newCount - 1);
    }
  };

  const clearAllHighlights = async () => {
    await (window as any).vessel?.highlights?.clearAll?.();
    setHighlightCount(0);
    setHighlightIndex(-1);
  };

  createEffect(() => {
    const unsubscribe = window.vessel.highlights.onSidebarAction((action) => {
      if (action === "remove-current") {
        void removeCurrentHighlight();
        return;
      }
      if (action === "clear-all") {
        void clearAllHighlights();
      }
    });
    onCleanup(unsubscribe);
  });

  const handleChatSend = async () => {
    const prompt = chatInput().trim();
    if (!prompt || isStreaming()) return;
    setChatInput("");
    await query(prompt);
  };

  const handleRetry = () => {
    const msgs = messages();
    // Find the last user message and re-send it
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "user") {
        void query(msgs[i].content);
        return;
      }
    }
  };
  const [checkpointName, setCheckpointName] = createSignal("");
  const [bookmarkNote, setBookmarkNote] = createSignal("");
  const [bookmarkSaveExpanded, setBookmarkSaveExpanded] = createSignal(false);
  const [selectedFolderId, setSelectedFolderId] = createSignal<string>(
    UNSORTED_FOLDER.id,
  );
  const [newFolderName, setNewFolderName] = createSignal("");
  const [newFolderSummary, setNewFolderSummary] = createSignal("");
  const [bookmarkSearchQuery, setBookmarkSearchQuery] = createSignal("");
  const [editingFolderId, setEditingFolderId] = createSignal<string | null>(
    null,
  );
  const [editingFolderName, setEditingFolderName] = createSignal("");
  const [editingFolderSummary, setEditingFolderSummary] = createSignal("");
  const [expandedFolderIds, setExpandedFolderIds] = createSignal<string[]>([
    UNSORTED_FOLDER.id,
  ]);
  const [actionsExpanded, setActionsExpanded] = createSignal(false);
  const [checkpointsExpanded, setCheckpointsExpanded] = createSignal(false);
  const [isDragging, setIsDragging] = createSignal(false);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  let messagesContainerRef: HTMLDivElement | undefined;
  let messagesEndRef: HTMLDivElement | undefined;
  let hasInitializedMessageScroll = false;
  const recentActions = createMemo(() =>
    runtimeState().actions.slice(-8).reverse(),
  );
  const recentCheckpoints = createMemo(() =>
    runtimeState().checkpoints.slice(-5).reverse(),
  );
  const approvalModeOptions = createMemo(() => [
    {
      value: "manual",
      label: "Ask every time",
      description: "Review each agent action before it runs.",
    },
    {
      value: "confirm-dangerous",
      label: "Ask for risky actions",
      description:
        "Allow routine actions, but stop on destructive or sensitive ones.",
    },
    {
      value: "auto",
      label: "Allow all actions",
      description: "Run everything without approval prompts.",
    },
  ]);
  const approvalModeDescription = createMemo(() => {
    const currentMode = runtimeState().supervisor.approvalMode;
    return (
      approvalModeOptions().find((option) => option.value === currentMode)
        ?.description ?? "Controls when the supervisor must approve actions."
    );
  });
  const bookmarkFolders = createMemo(() => [
    UNSORTED_FOLDER,
    ...bookmarksState().folders,
  ]);
  const bookmarkFolderOptions = createMemo(() =>
    bookmarkFolders().map((folder) => ({
      value: folder.id,
      label: folder.name,
    })),
  );
  const groupedBookmarks = createMemo(() =>
    bookmarkFolders().map((folder) => ({
      ...folder,
      items: bookmarksState()
        .bookmarks.filter((bookmark) => bookmark.folderId === folder.id)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    })),
  );
  const normalizedBookmarkSearch = createMemo(() =>
    normalizeBookmarkSearchText(bookmarkSearchQuery()),
  );
  const filteredGroupedBookmarks = createMemo(() => {
    const query = bookmarkSearchQuery().trim();
    if (!normalizedBookmarkSearch()) return groupedBookmarks();

    return groupedBookmarks()
      .map((folder) => {
        const folderMatches =
          getBookmarkSearchMatch({
            query,
            folder: folder.name,
            folderSummary: folder.summary,
          }).matchedFields.length > 0;

        return {
          ...folder,
          items: folderMatches
            ? folder.items
            : folder.items.filter(
                (bookmark) =>
                  getBookmarkSearchMatch({
                    query,
                    title: bookmark.title,
                    url: bookmark.url,
                    note: bookmark.note,
                    folder: folder.name,
                    folderSummary: folder.summary,
                  }).matchedFields.length > 0,
              ),
        };
      })
      .filter((folder) => folder.items.length > 0);
  });
  const bookmarkMatchCount = createMemo(() =>
    filteredGroupedBookmarks().reduce(
      (total, folder) => total + folder.items.length,
      0,
    ),
  );
  const currentTab = createMemo(() => activeTab());
  const currentTabSaved = createMemo(() => {
    const tab = currentTab();
    if (!tab?.url) return false;
    return bookmarksState().bookmarks.some(
      (bookmark) => bookmark.url === tab.url,
    );
  });

  // Auto-scroll to bottom on new messages
  createEffect(() => {
    messages();
    streamingText();
    if (!hasInitializedMessageScroll) {
      hasInitializedMessageScroll = true;
      return;
    }
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
  });

  createEffect(() => {
    const isVisible = props.forceOpen || sidebarOpen();
    if (!isVisible) return;
    queueMicrotask(() => {
      if (messagesContainerRef) {
        messagesContainerRef.scrollTop = 0;
      }
    });
  });

  createEffect(() => {
    if (!isStreaming() || !streamStartedAt()) {
      setElapsedSeconds(0);
      return;
    }

    const tick = () => {
      const startedAt = streamStartedAt();
      if (!startedAt) return;
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      );
    };

    tick();
    const intervalId = window.setInterval(tick, 1000);
    onCleanup(() => window.clearInterval(intervalId));
  });

  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    // Expand the sidebar view to full window so pointer capture works across the drag
    window.vessel.ui.startSidebarResize();

    // Capture initial state so the reference frame stays fixed during drag
    const startX = e.screenX;
    const startWidth = sidebarWidth();

    const onPointerMove = (ev: PointerEvent) => {
      const delta = startX - ev.screenX;
      resizeSidebar(startWidth + delta);
    };

    const onPointerUp = () => {
      setIsDragging(false);
      commitResize();
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("lostpointercapture", onPointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("lostpointercapture", onPointerUp);
  };

  const formatBookmarkDate = (savedAt: string) =>
    new Date(savedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const handleSaveBookmark = async () => {
    const tab = currentTab();
    if (!tab?.url) return;
    await saveBookmark(
      tab.url,
      tab.title?.trim() || tab.url,
      selectedFolderId(),
      bookmarkNote(),
    );
    setBookmarkNote("");
    setBookmarkSaveExpanded(false);
  };

  const handleCreateFolder = async (e: Event) => {
    e.preventDefault();
    const name = newFolderName().trim();
    if (!name) return;
    const folder = await createFolderWithSummary(name, newFolderSummary());
    setNewFolderName("");
    setNewFolderSummary("");
    setSelectedFolderId(folder.id);
    setExpandedFolderIds((current) =>
      current.includes(folder.id) ? current : [...current, folder.id],
    );
  };

  const handleRenameFolder = async (folderId: string) => {
    const name = editingFolderName().trim();
    if (!name) return;
    const folder = await renameFolder(folderId, name, editingFolderSummary());
    if (!folder) return;
    setEditingFolderId(null);
    setEditingFolderName("");
    setEditingFolderSummary("");
  };

  const handleRemoveFolder = async (folderId: string) => {
    const confirmed = window.confirm(
      "Delete this folder? Its bookmarks will move to Unsorted.",
    );
    if (!confirmed) return;
    const removed = await removeFolder(folderId);
    if (!removed) return;
    if (selectedFolderId() === folderId) {
      setSelectedFolderId(UNSORTED_FOLDER.id);
    }
    setExpandedFolderIds((current) => current.filter((id) => id !== folderId));
    if (editingFolderId() === folderId) {
      setEditingFolderId(null);
      setEditingFolderName("");
      setEditingFolderSummary("");
    }
  };

  const toggleFolderExpanded = (folderId: string) => {
    setExpandedFolderIds((current) =>
      current.includes(folderId)
        ? current.filter((id) => id !== folderId)
        : [...current, folderId],
    );
  };

  const isFolderExpanded = (folderId: string) =>
    normalizedBookmarkSearch().length > 0 ||
    expandedFolderIds().includes(folderId);

  return (
    <Show when={props.forceOpen || sidebarOpen()}>
      <div
        class="sidebar"
        style={{ width: `${sidebarWidth()}px` }}
      >
        <div
          class="sidebar-resize-handle"
          classList={{ dragging: isDragging() }}
          onPointerDown={startResize}
        />
        <div class="sidebar-header">
          <div class="sidebar-brand">
            <img class="sidebar-logo" src={vesselLogo} alt="Vessel" />
            <span class="sidebar-brand-text">Vessel Browser</span>
          </div>
          <div class="sidebar-header-actions">
            <button
              class="sidebar-clear"
              onClick={clearHistory}
              title="Clear chat"
            >
              Clear
            </button>
            <button
              class="sidebar-close"
              onClick={() => void toggleSidebar()}
              title="Close AI chat (Esc)"
              aria-label="Close AI chat"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
              >
                <path
                  d="M3.5 3.5l7 7M10.5 3.5l-7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        </div>

        <div class="sidebar-tabs" role="tablist">
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "supervisor" }}
            role="tab"
            aria-selected={sidebarTab() === "supervisor"}
            onClick={() => setSidebarTab("supervisor")}
          >
            Supervisor
            <Show when={runtimeState().supervisor.pendingApprovals.length > 0}>
              <span class="sidebar-tab-badge">
                {runtimeState().supervisor.pendingApprovals.length}
              </span>
            </Show>
          </button>
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "bookmarks" }}
            role="tab"
            aria-selected={sidebarTab() === "bookmarks"}
            onClick={() => setSidebarTab("bookmarks")}
          >
            Bookmarks
          </button>
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "checkpoints" }}
            role="tab"
            aria-selected={sidebarTab() === "checkpoints"}
            onClick={() => setSidebarTab("checkpoints")}
          >
            Checkpoints
          </button>
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "chat" }}
            role="tab"
            aria-selected={sidebarTab() === "chat"}
            onClick={() => setSidebarTab("chat")}
          >
            Chat
          </button>
        </div>

        <div class="sidebar-messages" ref={(el) => { messagesContainerRef = el; useScrollFade(el); }}>
          <Show when={sidebarTab() === "supervisor"}>
          <section class="agent-panel">
            <div class="agent-panel-header">
              <div>
                <div class="agent-panel-title">Supervisor</div>
                <div class="agent-panel-subtitle">
                  {runtimeState().supervisor.paused
                    ? "Agent is paused"
                    : "Agent is live"}
                </div>
              </div>
              <span
                class="agent-status-pill"
                classList={{ paused: runtimeState().supervisor.paused }}
              >
                {runtimeState().supervisor.paused ? "Paused" : "Running"}
              </span>
            </div>

            <div class="agent-panel-controls">
              <DropdownSelect
                class="agent-select"
                value={runtimeState().supervisor.approvalMode}
                options={approvalModeOptions()}
                ariaLabel="Approval mode"
                onChange={(value) =>
                  void setApprovalMode(
                    value as "auto" | "confirm-dangerous" | "manual",
                  )
                }
              />
              <button
                class="agent-control-button"
                type="button"
                onClick={() =>
                  void (runtimeState().supervisor.paused ? resume() : pause())
                }
              >
                {runtimeState().supervisor.paused ? "Resume" : "Pause"}
              </button>
              <button
                class="agent-control-button"
                type="button"
                onClick={() => void restoreSession()}
              >
                Restore session
              </button>
            </div>

            <div class="agent-muted">{approvalModeDescription()}</div>

            <Show
              when={runtimeState().supervisor.pendingApprovals.length > 0}
              fallback={<div class="agent-muted">No pending approvals.</div>}
            >
              <div class="agent-section-title">Pending approvals</div>
              <For each={runtimeState().supervisor.pendingApprovals}>
                {(approval) => (
                  <div class="agent-card agent-card-approval">
                    <div class="agent-card-approval-stripe" aria-hidden="true" />
                    <div class="agent-card-title">{approval.name}</div>
                    <div class="agent-card-copy">{approval.argsSummary}</div>
                    <div class="agent-card-copy">{approval.reason}</div>
                    <div class="agent-card-actions">
                      <button
                        class="agent-primary-button"
                        type="button"
                        onClick={() => void resolveApproval(approval.id, true)}
                      >
                        Approve
                      </button>
                      <button
                        class="agent-control-button"
                        type="button"
                        onClick={() => void resolveApproval(approval.id, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>

            <div class="agent-section-header">
              <div class="agent-section-title">Recent actions</div>
              <Show when={recentActions().length > 0}>
                <button
                  class="agent-section-toggle"
                  type="button"
                  onClick={() => setActionsExpanded((current) => !current)}
                >
                  {actionsExpanded()
                    ? "Hide history"
                    : `Show history (${recentActions().length})`}
                </button>
              </Show>
            </div>
            <Show
              when={recentActions().length > 0}
              fallback={<div class="agent-muted">No actions yet.</div>}
            >
              <Show
                when={actionsExpanded()}
                fallback={
                  <div class="agent-muted">
                    Recent actions are collapsed to reduce noise.
                  </div>
                }
              >
                <For each={recentActions()}>
                  {(action) => (
                    <div class="agent-card">
                      <div class="agent-action-row">
                        <span class="agent-card-title">{action.name}</span>
                        <span class={`agent-action-status ${action.status}`}>
                          {action.status}
                        </span>
                      </div>
                      <div class="agent-card-copy">{action.argsSummary}</div>
                      <Show when={action.resultSummary}>
                        <div class="agent-card-copy success">
                          {action.resultSummary}
                        </div>
                      </Show>
                      <Show when={action.error}>
                        <div class="agent-card-copy error">{action.error}</div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </section>
          </Show>

          <Show when={sidebarTab() === "bookmarks"}>
          <section class="bookmark-panel">
            <div class="bookmark-panel-header">
              <div>
                <div class="bookmark-panel-title">Bookmarks</div>
                <div class="bookmark-panel-subtitle">
                  {normalizedBookmarkSearch()
                    ? `${bookmarkMatchCount()} matches for "${bookmarkSearchQuery().trim()}"`
                    : `${bookmarksState().bookmarks.length} saved across ${bookmarkFolders().length} folders`}
                </div>
              </div>
              <Show when={currentTabSaved()}>
                <span class="bookmark-status-pill">Saved</span>
              </Show>
            </div>

            <input
              class="bookmark-input bookmark-search-input"
              value={bookmarkSearchQuery()}
              onInput={(e) => setBookmarkSearchQuery(e.currentTarget.value)}
              placeholder="Search titles, URLs, notes, and folders"
            />

            <div class="bookmark-save-shell">
              <button
                class="bookmark-save-toggle"
                type="button"
                onClick={() => setBookmarkSaveExpanded((current) => !current)}
              >
                <span class="bookmark-save-toggle-copy">
                  <span class="bookmark-save-toggle-title">
                    Save Current Page
                  </span>
                  <span class="bookmark-save-toggle-subtitle">
                    Manual bookmark save options
                  </span>
                </span>
                <span
                  class="bookmark-save-toggle-caret"
                  classList={{ expanded: bookmarkSaveExpanded() }}
                  aria-hidden="true"
                >
                  ▾
                </span>
              </button>

              <Show when={bookmarkSaveExpanded()}>
                <div class="bookmark-save-card">
                  <div class="bookmark-current-title">
                    {currentTab()?.title || "No active page"}
                  </div>
                  <div class="bookmark-current-url">
                    {currentTab()?.url || "Open a page to save it here."}
                  </div>
                  <div class="bookmark-save-controls">
                    <DropdownSelect
                      class="bookmark-select"
                      value={selectedFolderId()}
                      options={bookmarkFolderOptions()}
                      ariaLabel="Bookmark folder"
                      onChange={(value) => setSelectedFolderId(value)}
                    />
                    <button
                      class="bookmark-primary-button"
                      type="button"
                      disabled={!currentTab()?.url}
                      onClick={() => void handleSaveBookmark()}
                    >
                      Save page
                    </button>
                  </div>
                  <textarea
                    class="bookmark-note-input"
                    value={bookmarkNote()}
                    onInput={(e) => setBookmarkNote(e.currentTarget.value)}
                    placeholder="Optional note about why this matters"
                    rows={2}
                  />
                </div>
              </Show>
            </div>

            <form class="bookmark-folder-create" onSubmit={handleCreateFolder}>
              <div class="bookmark-folder-form-fields">
                <input
                  class="bookmark-input"
                  value={newFolderName()}
                  onInput={(e) => setNewFolderName(e.currentTarget.value)}
                  placeholder="Create a folder"
                />
                <input
                  class="bookmark-input"
                  value={newFolderSummary()}
                  onInput={(e) => setNewFolderSummary(e.currentTarget.value)}
                  placeholder="Optional one-line summary"
                />
              </div>
              <button
                class="bookmark-secondary-button"
                type="submit"
                disabled={!newFolderName().trim()}
              >
                New folder
              </button>
            </form>

            <div class="bookmark-folder-list">
              <Show
                when={filteredGroupedBookmarks().length > 0}
                fallback={
                  <div class="bookmark-empty-folder">
                    {normalizedBookmarkSearch()
                      ? `No bookmarks matched "${bookmarkSearchQuery().trim()}".`
                      : "No bookmarks saved yet."}
                  </div>
                }
              >
                <For each={filteredGroupedBookmarks()}>
                  {(folder) => (
                    <div class="bookmark-folder-section">
                      <div
                        class="bookmark-folder-header clickable"
                        onClick={() => toggleFolderExpanded(folder.id)}
                        role="button"
                        tabindex="0"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggleFolderExpanded(folder.id);
                          }
                        }}
                      >
                        <div class="bookmark-folder-overview">
                          <span
                            class="bookmark-folder-chevron"
                            classList={{ expanded: isFolderExpanded(folder.id) }}
                            aria-hidden="true"
                          >
                            ▸
                          </span>
                          <div>
                            <div class="bookmark-folder-name">{folder.name}</div>
                            <div class="bookmark-folder-meta">
                              {folder.items.length} saved
                            </div>
                            <Show when={folder.summary}>
                              <div class="bookmark-folder-summary">
                                {folder.summary}
                              </div>
                            </Show>
                          </div>
                        </div>
                        <Show when={folder.id !== UNSORTED_FOLDER.id}>
                          <div class="bookmark-folder-actions">
                            <button
                              class="bookmark-ghost-button"
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingFolderId(folder.id);
                                setEditingFolderName(folder.name);
                                setEditingFolderSummary(folder.summary || "");
                              }}
                            >
                              Rename
                            </button>
                            <button
                              class="bookmark-ghost-button danger"
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleRemoveFolder(folder.id);
                              }}
                            >
                              Delete
                            </button>
                          </div>
                        </Show>
                      </div>

                      <Show when={editingFolderId() === folder.id}>
                        <div class="bookmark-folder-edit">
                          <div class="bookmark-folder-form-fields">
                            <input
                              class="bookmark-input"
                              value={editingFolderName()}
                              onInput={(e) =>
                                setEditingFolderName(e.currentTarget.value)
                              }
                            />
                            <input
                              class="bookmark-input"
                              value={editingFolderSummary()}
                              onInput={(e) =>
                                setEditingFolderSummary(e.currentTarget.value)
                              }
                              placeholder="Optional one-line summary"
                            />
                          </div>
                          <button
                            class="bookmark-secondary-button"
                            type="button"
                            disabled={!editingFolderName().trim()}
                            onClick={() => void handleRenameFolder(folder.id)}
                          >
                            Save
                          </button>
                          <button
                            class="bookmark-ghost-button"
                            type="button"
                            onClick={() => {
                              setEditingFolderId(null);
                              setEditingFolderName("");
                              setEditingFolderSummary("");
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </Show>

                      <Show
                        when={isFolderExpanded(folder.id)}
                        fallback={
                          <div class="bookmark-folder-collapsed-hint">
                            Click to view saved links.
                          </div>
                        }
                      >
                        <Show
                          when={folder.items.length > 0}
                          fallback={
                            <div class="bookmark-empty-folder">
                              No bookmarks in this folder yet.
                            </div>
                          }
                        >
                          <div class="bookmark-items">
                            <For each={folder.items}>
                              {(bookmark) => (
                                <div class="bookmark-item">
                                  <button
                                    class="bookmark-item-link"
                                    type="button"
                                    onClick={() => void createTab(bookmark.url)}
                                  >
                                    <span class="bookmark-item-title">
                                      {bookmark.title || bookmark.url}
                                    </span>
                                    <span class="bookmark-item-url">
                                      {bookmark.url}
                                    </span>
                                  </button>
                                  <Show when={bookmark.note}>
                                    <div class="bookmark-item-note">
                                      {bookmark.note}
                                    </div>
                                  </Show>
                                  <div class="bookmark-item-footer">
                                    <span class="bookmark-item-time">
                                      {formatBookmarkDate(bookmark.savedAt)}
                                    </span>
                                    <button
                                      class="bookmark-ghost-button danger"
                                      type="button"
                                      onClick={() =>
                                        void removeBookmark(bookmark.id)
                                      }
                                    >
                                      Remove
                                    </button>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </section>
          </Show>

          <Show when={sidebarTab() === "checkpoints"}>
          <section class="agent-panel checkpoint-panel">
            <div class="agent-panel-header">
              <div>
                <div class="agent-panel-title">Checkpoints</div>
                <div class="agent-panel-subtitle">
                  {recentCheckpoints().length > 0
                    ? `${recentCheckpoints().length} saved snapshots`
                    : "Save and restore session snapshots"}
                </div>
              </div>
            </div>

            <div class="agent-panel-body">
              <div class="agent-checkpoint-row">
                <input
                  class="agent-input"
                  value={checkpointName()}
                  onInput={(e) => setCheckpointName(e.currentTarget.value)}
                  placeholder="Checkpoint name"
                />
                <button
                  class="agent-primary-button"
                  type="button"
                  onClick={async () => {
                    const name = checkpointName().trim();
                    await createCheckpoint(name || undefined);
                    setCheckpointName("");
                  }}
                >
                  Save checkpoint
                </button>
              </div>

              <div class="agent-section-title">Recent checkpoints</div>
              <Show
                when={recentCheckpoints().length > 0}
                fallback={<div class="agent-muted">No checkpoints yet.</div>}
              >
                <div class="checkpoint-timeline">
                  <For each={recentCheckpoints()}>
                    {(checkpoint, i) => (
                      <div class="checkpoint-timeline-item">
                        <div class="checkpoint-timeline-rail">
                          <span
                            class="checkpoint-timeline-dot"
                            classList={{ latest: i() === 0 }}
                          />
                          <Show when={i() < recentCheckpoints().length - 1}>
                            <span class="checkpoint-timeline-line" />
                          </Show>
                        </div>
                        <div class="checkpoint-timeline-content">
                          <div class="checkpoint-timeline-name">{checkpoint.name}</div>
                          <div class="checkpoint-timeline-time">
                            {new Date(checkpoint.createdAt).toLocaleString()}
                          </div>
                          <button
                            class="agent-control-button"
                            type="button"
                            onClick={() => void restoreCheckpoint(checkpoint.id)}
                          >
                            Restore
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </section>
          </Show>

          <Show when={sidebarTab() === "chat"}>
            <For each={messages()}>
              {(msg) => (
                <div class={`message message-${msg.role}`}>
                  <MarkdownMessage content={msg.content} />
                </div>
              )}
            </For>

            <Show when={isStreaming()}>
              <div class="message message-assistant">
                <div class="message-content">
                  <Show
                    when={hasFirstChunk()}
                    fallback={
                      <div class="thinking-state">
                        <div class="thinking-orb" aria-hidden="true">
                          <span />
                          <span />
                          <span />
                        </div>
                        <div class="thinking-copy">
                          <div class="thinking-title">Thinking</div>
                        </div>
                      </div>
                    }
                  >
                    <div>
                      <MarkdownMessage content={streamingText()} />
                      <div class="streaming-status">
                        <span class="streaming-pulse" aria-hidden="true" />
                        <span>Generating</span>
                        <Show when={elapsedSeconds() > 0}>
                          <span>{` • ${elapsedSeconds()}s`}</span>
                        </Show>
                      </div>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            <Show when={runtimeState().supervisor.pendingApprovals.length > 0}>
              <For each={runtimeState().supervisor.pendingApprovals}>
                {(approval) => (
                  <div class="chat-approval">
                    <div class="chat-approval-icon" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 4.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11.5a.75.75 0 110-1.5.75.75 0 010 1.5z" fill="currentColor"/>
                      </svg>
                    </div>
                    <div class="chat-approval-body">
                      <div class="chat-approval-title">
                        Approval needed: <strong>{approval.name}</strong>
                      </div>
                      <Show when={approval.argsSummary}>
                        <div class="chat-approval-detail">{approval.argsSummary}</div>
                      </Show>
                      <div class="chat-approval-detail">{approval.reason}</div>
                      <div class="chat-approval-actions">
                        <button
                          class="chat-approval-btn chat-approval-approve"
                          type="button"
                          onClick={() => void resolveApproval(approval.id, true)}
                        >
                          Approve
                        </button>
                        <button
                          class="chat-approval-btn chat-approval-reject"
                          type="button"
                          onClick={() => void resolveApproval(approval.id, false)}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </Show>

            <Show when={messages().length === 0 && !isStreaming()}>
              <div class="sidebar-empty">
                <svg class="sidebar-empty-icon" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
                  {/* Edges — outer connections */}
                  <line x1="8" y1="8" x2="24" y2="5" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="24" y1="5" x2="40" y2="10" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="8" y1="8" x2="6" y2="24" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="40" y1="10" x2="44" y2="26" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="6" y1="24" x2="10" y2="38" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="44" y1="26" x2="38" y2="40" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="10" y1="38" x2="24" y2="44" stroke="var(--border-visible)" stroke-width="1" opacity="0.35" />
                  <line x1="38" y1="40" x2="24" y2="44" stroke="var(--border-visible)" stroke-width="1" opacity="0.35" />
                  {/* Edges — inner web */}
                  <line x1="8" y1="8" x2="20" y2="18" stroke="var(--border-visible)" stroke-width="1" opacity="0.5" />
                  <line x1="24" y1="5" x2="20" y2="18" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="40" y1="10" x2="32" y2="20" stroke="var(--border-visible)" stroke-width="1" opacity="0.5" />
                  <line x1="20" y1="18" x2="32" y2="20" stroke="var(--accent-primary)" stroke-width="0.75" opacity="0.3" />
                  <line x1="6" y1="24" x2="18" y2="30" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="20" y1="18" x2="18" y2="30" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="32" y1="20" x2="36" y2="30" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="44" y1="26" x2="36" y2="30" stroke="var(--border-visible)" stroke-width="1" opacity="0.45" />
                  <line x1="18" y1="30" x2="36" y2="30" stroke="var(--accent-primary)" stroke-width="0.75" opacity="0.25" />
                  <line x1="18" y1="30" x2="10" y2="38" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="36" y1="30" x2="38" y2="40" stroke="var(--border-visible)" stroke-width="1" opacity="0.4" />
                  <line x1="18" y1="30" x2="24" y2="44" stroke="var(--accent-primary)" stroke-width="0.75" opacity="0.2" />
                  <line x1="36" y1="30" x2="24" y2="44" stroke="var(--accent-primary)" stroke-width="0.75" opacity="0.2" />
                  {/* Nodes — outer ring */}
                  <circle cx="8" cy="8" r="2.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.55" />
                  <circle cx="24" cy="5" r="2" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.45" />
                  <circle cx="40" cy="10" r="3" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.7" />
                  <circle cx="6" cy="24" r="2" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.5" />
                  <circle cx="44" cy="26" r="2.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.55" />
                  <circle cx="10" cy="38" r="2.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.5" />
                  <circle cx="38" cy="40" r="2" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.45" />
                  <circle cx="24" cy="44" r="2.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.5" />
                  {/* Nodes — inner core */}
                  <circle cx="20" cy="18" r="3.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.85" />
                  <circle cx="32" cy="20" r="4" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.9" />
                  <circle cx="18" cy="30" r="3" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.75" />
                  <circle cx="36" cy="30" r="3.5" fill="var(--bg-secondary)" stroke="var(--accent-primary)" stroke-width="1.5" opacity="0.8" />
                </svg>
                <p class="sidebar-empty-title">Your move.</p>
                <p class="sidebar-empty-hint">
                  Configure a provider in Settings (Ctrl+,) then ask anything about the current page or beyond.
                </p>
              </div>
            </Show>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        <Show when={sidebarTab() === "chat"}>
          <Show when={isStreaming() || messages().length > 0}>
            <div class="chat-actions">
              <Show when={isStreaming()}>
                <button class="chat-action-btn" onClick={() => cancel()} title="Stop generating">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <rect x="2" y="2" width="10" height="10" rx="1.5" fill="currentColor" />
                  </svg>
                  Stop
                </button>
              </Show>
              <Show when={!isStreaming() && messages().length > 0}>
                <button class="chat-action-btn" onClick={handleRetry} title="Retry last prompt">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <path d="M10.5 1v3h-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  Retry
                </button>
              </Show>
            </div>
          </Show>
          <Show when={highlightCount() > 0}>
            <div class="highlight-nav">
              <button
                class="highlight-nav-btn"
                type="button"
                disabled={highlightIndex() <= 0}
                onClick={() => void scrollToHighlight(highlightIndex() - 1)}
                title="Previous highlight"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M8 10L4 6l4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <button
                class="highlight-nav-label"
                type="button"
                onClick={() => void scrollToHighlight(highlightIndex() < 0 ? 0 : highlightIndex())}
                title="Go to current highlight"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <circle cx="6" cy="6" r="3" fill="rgba(196, 160, 90, 0.6)" stroke="rgba(196, 160, 90, 0.9)" stroke-width="1" />
                </svg>
                {highlightIndex() >= 0
                  ? `${highlightIndex() + 1} / ${highlightCount()}`
                  : `${highlightCount()} highlight${highlightCount() > 1 ? "s" : ""}`}
              </button>
              <button
                class="highlight-nav-btn"
                type="button"
                disabled={highlightIndex() >= highlightCount() - 1}
                onClick={() => void scrollToHighlight(highlightIndex() < 0 ? 0 : highlightIndex() + 1)}
                title="Next highlight"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </Show>
          <div class="sidebar-input-area">
            <textarea
              class="sidebar-input"
              rows={2}
              placeholder="Ask anything..."
              value={chatInput()}
              onInput={(e) => setChatInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleChatSend();
                }
              }}
            />
            <button
              class="sidebar-send"
              disabled={!chatInput().trim() || isStreaming()}
              onClick={() => void handleChatSend()}
            >
              Send
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default Sidebar;
