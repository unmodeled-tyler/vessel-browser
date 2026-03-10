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
import type { BookmarkFolder } from "../../../../shared/types";
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

const Sidebar: Component<{ forceOpen?: boolean }> = (props) => {
  const {
    messages,
    streamingText,
    isStreaming,
    hasFirstChunk,
    streamStartedAt,
    query,
    cancel,
    clearHistory,
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
  const { activeTab, navigate } = useTabs();
  const {
    bookmarksState,
    saveBookmark,
    removeBookmark,
    createFolder,
    removeFolder,
    renameFolder,
  } = useBookmarks();
  const [input, setInput] = createSignal("");
  const [checkpointName, setCheckpointName] = createSignal("");
  const [bookmarkNote, setBookmarkNote] = createSignal("");
  const [selectedFolderId, setSelectedFolderId] = createSignal<string>(
    UNSORTED_FOLDER.id,
  );
  const [newFolderName, setNewFolderName] = createSignal("");
  const [editingFolderId, setEditingFolderId] = createSignal<string | null>(
    null,
  );
  const [editingFolderName, setEditingFolderName] = createSignal("");
  const [isDragging, setIsDragging] = createSignal(false);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  let messagesEndRef: HTMLDivElement | undefined;
  const recentActions = createMemo(() =>
    runtimeState().actions.slice(-8).reverse(),
  );
  const recentCheckpoints = createMemo(() =>
    runtimeState().checkpoints.slice(-5).reverse(),
  );
  const bookmarkFolders = createMemo(() => [
    UNSORTED_FOLDER,
    ...bookmarksState().folders,
  ]);
  const groupedBookmarks = createMemo(() =>
    bookmarkFolders().map((folder) => ({
      ...folder,
      items: bookmarksState()
        .bookmarks.filter((bookmark) => bookmark.folderId === folder.id)
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    })),
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
    messagesEndRef?.scrollIntoView({ behavior: "smooth" });
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

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const val = input().trim();
    if (!val || isStreaming()) return;
    setInput("");
    await query(val);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      void toggleSidebar();
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const startResize = (e: MouseEvent) => {
    if (props.forceOpen) return;

    e.preventDefault();
    setIsDragging(true);

    const onMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX;
      resizeSidebar(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      commitResize();
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
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
  };

  const handleCreateFolder = async (e: Event) => {
    e.preventDefault();
    const name = newFolderName().trim();
    if (!name) return;
    const folder = await createFolder(name);
    setNewFolderName("");
    setSelectedFolderId(folder.id);
  };

  const handleRenameFolder = async (folderId: string) => {
    const name = editingFolderName().trim();
    if (!name) return;
    const folder = await renameFolder(folderId, name);
    if (!folder) return;
    setEditingFolderId(null);
    setEditingFolderName("");
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
    if (editingFolderId() === folderId) {
      setEditingFolderId(null);
      setEditingFolderName("");
    }
  };

  return (
    <Show when={props.forceOpen || sidebarOpen()}>
      <div
        class="sidebar"
        style={{ width: props.forceOpen ? "100%" : `${sidebarWidth()}px` }}
      >
        <Show when={!props.forceOpen}>
          <div
            class="sidebar-resize-handle"
            classList={{ dragging: isDragging() }}
            onMouseDown={startResize}
          />
        </Show>
        <div class="sidebar-header">
          <span class="sidebar-title">Vessel AI</span>
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

        <div class="sidebar-messages">
          <section class="bookmark-panel">
            <div class="bookmark-panel-header">
              <div>
                <div class="bookmark-panel-title">Bookmarks</div>
                <div class="bookmark-panel-subtitle">
                  {bookmarksState().bookmarks.length} saved across{" "}
                  {bookmarkFolders().length} folders
                </div>
              </div>
              <Show when={currentTabSaved()}>
                <span class="bookmark-status-pill">Saved</span>
              </Show>
            </div>

            <div class="bookmark-save-card">
              <div class="bookmark-current-title">
                {currentTab()?.title || "No active page"}
              </div>
              <div class="bookmark-current-url">
                {currentTab()?.url || "Open a page to save it here."}
              </div>
              <div class="bookmark-save-controls">
                <select
                  class="bookmark-select"
                  value={selectedFolderId()}
                  onChange={(e) => setSelectedFolderId(e.currentTarget.value)}
                >
                  <For each={bookmarkFolders()}>
                    {(folder) => (
                      <option value={folder.id}>{folder.name}</option>
                    )}
                  </For>
                </select>
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

            <form class="bookmark-folder-create" onSubmit={handleCreateFolder}>
              <input
                class="bookmark-input"
                value={newFolderName()}
                onInput={(e) => setNewFolderName(e.currentTarget.value)}
                placeholder="Create a folder"
              />
              <button
                class="bookmark-secondary-button"
                type="submit"
                disabled={!newFolderName().trim()}
              >
                New folder
              </button>
            </form>

            <div class="bookmark-folder-list">
              <For each={groupedBookmarks()}>
                {(folder) => (
                  <div class="bookmark-folder-section">
                    <div class="bookmark-folder-header">
                      <div>
                        <div class="bookmark-folder-name">{folder.name}</div>
                        <div class="bookmark-folder-meta">
                          {folder.items.length} saved
                        </div>
                      </div>
                      <Show when={folder.id !== UNSORTED_FOLDER.id}>
                        <div class="bookmark-folder-actions">
                          <button
                            class="bookmark-ghost-button"
                            type="button"
                            onClick={() => {
                              setEditingFolderId(folder.id);
                              setEditingFolderName(folder.name);
                            }}
                          >
                            Rename
                          </button>
                          <button
                            class="bookmark-ghost-button danger"
                            type="button"
                            onClick={() => void handleRemoveFolder(folder.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </Show>
                    </div>

                    <Show when={editingFolderId() === folder.id}>
                      <div class="bookmark-folder-edit">
                        <input
                          class="bookmark-input"
                          value={editingFolderName()}
                          onInput={(e) =>
                            setEditingFolderName(e.currentTarget.value)
                          }
                        />
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
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </Show>

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
                                onClick={() => navigate(bookmark.url)}
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
                  </div>
                )}
              </For>
            </div>
          </section>

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
              <select
                class="agent-select"
                value={runtimeState().supervisor.approvalMode}
                onChange={(e) =>
                  void setApprovalMode(
                    e.currentTarget.value as
                      | "auto"
                      | "confirm-dangerous"
                      | "manual",
                  )
                }
              >
                <option value="auto">Auto approve</option>
                <option value="confirm-dangerous">Approve dangerous</option>
                <option value="manual">Approve everything</option>
              </select>
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

            <Show
              when={runtimeState().supervisor.pendingApprovals.length > 0}
              fallback={<div class="agent-muted">No pending approvals.</div>}
            >
              <div class="agent-section-title">Pending approvals</div>
              <For each={runtimeState().supervisor.pendingApprovals}>
                {(approval) => (
                  <div class="agent-card">
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

            <div class="agent-section-title">Recent checkpoints</div>
            <Show
              when={recentCheckpoints().length > 0}
              fallback={<div class="agent-muted">No checkpoints yet.</div>}
            >
              <For each={recentCheckpoints()}>
                {(checkpoint) => (
                  <div class="agent-card compact">
                    <div>
                      <div class="agent-card-title">{checkpoint.name}</div>
                      <div class="agent-card-copy">
                        {new Date(checkpoint.createdAt).toLocaleString()}
                      </div>
                    </div>
                    <button
                      class="agent-control-button"
                      type="button"
                      onClick={() => void restoreCheckpoint(checkpoint.id)}
                    >
                      Restore
                    </button>
                  </div>
                )}
              </For>
            </Show>

            <div class="agent-section-title">Recent actions</div>
            <Show
              when={recentActions().length > 0}
              fallback={<div class="agent-muted">No actions yet.</div>}
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
          </section>

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

          <Show when={messages().length === 0 && !isStreaming()}>
            <div class="sidebar-empty">
              <p>Ask me anything about the current page.</p>
              <p class="sidebar-empty-hint">
                Try "summarize", "what is this about?", or any question.
              </p>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        <form class="sidebar-input-area" onSubmit={handleSubmit}>
          <textarea
            class="sidebar-input"
            value={input()}
            onInput={(e) => setInput(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something..."
            rows={2}
            disabled={isStreaming()}
          />
          <Show
            when={isStreaming()}
            fallback={
              <button
                class="sidebar-send"
                type="submit"
                disabled={!input().trim()}
              >
                Send
              </button>
            }
          >
            <button class="sidebar-cancel" type="button" onClick={cancel}>
              Stop
            </button>
          </Show>
        </form>
      </div>
    </Show>
  );
};

export default Sidebar;
