import {
  createSignal,
  For,
  Show,
  createEffect,
  createMemo,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { useAI } from "../../stores/ai";
import { useNow } from "../../stores/clock";
import { useRuntime } from "../../stores/runtime";
import { useUI } from "../../stores/ui";
import { useTabs } from "../../stores/tabs";
import { useHistory } from "../../stores/history";
import { useBookmarks } from "../../stores/bookmarks";
import { buildAndRememberBookmarkContext } from "../../lib/bookmark-context";
import { renderMarkdown } from "../../lib/markdown";
import { isPremiumStatus } from "../../lib/premium";
import {
  getBookmarkSearchMatch,
  normalizeBookmarkSearchText,
} from "../../../../shared/bookmark-search";
import type {
  Bookmark,
  BookmarkFolder,
  PremiumState,
} from "../../../../shared/types";
import { useScrollFade } from "../../lib/useScrollFade";
import DropdownSelect from "../shared/DropdownSelect";
import AutomationTab from "./AutomationTab";
import PageDiffTimeline from "./PageDiffTimeline";
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

type PremiumPromptKind = "premium_gate" | "iteration_limit";

function getPremiumPromptKind(content: string): PremiumPromptKind | null {
  if (content.includes("requires Vessel Premium")) {
    return "premium_gate";
  }
  if (content.includes("Reached maximum tool call limit")) {
    return "iteration_limit";
  }
  return null;
}

const PremiumPromptCard = (props: {
  kind: PremiumPromptKind;
  onStartTrial: () => void;
  onOpenSettings: () => void;
  compact?: boolean;
}) => {
  const title =
    props.kind === "premium_gate"
      ? "This workflow needs Premium"
      : "Need a longer autonomous run?";
  const body =
    props.kind === "premium_gate"
      ? "Unlock screenshots, saved sessions, workflow tracking, table extraction, and the credential vault with a 7-day free trial."
      : "Free chats pause after 50 tool calls in a turn. Vessel Premium raises the ceiling so the agent can finish longer workflows without stopping.";

  return (
    <div
      class="premium-inline-offer"
      classList={{ compact: props.compact === true }}
    >
      <div class="premium-inline-kicker">Vessel Premium</div>
      <div class="premium-inline-title">{title}</div>
      <p class="premium-inline-copy">{body}</p>
      <div class="premium-inline-actions">
        <button
          class="agent-primary-button premium-inline-primary"
          type="button"
          onClick={props.onStartTrial}
        >
          Start 7-day free trial — $5.99/mo after
        </button>
        <button
          class="agent-control-button premium-inline-secondary"
          type="button"
          onClick={props.onOpenSettings}
        >
          View details
        </button>
      </div>
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
    pendingQueries,
    pendingQueryCount,
    pendingQueryLimit,
    queueNotice,
    removePendingQuery,
    clearPendingQueries,
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
    updateCheckpointNote,
    undoLastAction,
    restoreSession,
  } = useRuntime();
  const {
    sidebarOpen,
    sidebarWidth,
    resizeSidebar,
    commitResize,
    toggleSidebar,
    openSettings,
  } = useUI();
  const { activeTab, createTab } = useTabs();
  const history = useHistory();
  const {
    bookmarksState,
    saveBookmark,
    updateBookmark,
    removeBookmark,
    exportHtml,
    exportJson,
    exportFolderHtml,
    createFolderWithSummary,
    removeFolder,
    renameFolder,
  } = useBookmarks();
  const [sidebarTab, setSidebarTab] = createSignal<
    "supervisor" | "bookmarks" | "checkpoints" | "chat" | "automation" | "history" | "diff"
  >("supervisor");
  const [chatInput, setChatInput] = createSignal("");
  const [highlightCount, setHighlightCount] = createSignal(0);
  const [highlightIndex, setHighlightIndex] = createSignal(-1);
  const [premiumState, setPremiumState] = createSignal<PremiumState>({
    status: "free",
    customerId: "",
    verificationToken: "",
    email: "",
    validatedAt: "",
    expiresAt: "",
  });
  const trackedPremiumContexts = new Set<string>();

  const isPremium = () => isPremiumStatus(premiumState().status);

  const trackPremiumContext = (
    step:
      | "chat_banner_viewed"
      | "chat_banner_clicked"
      | "premium_gate_seen"
      | "premium_gate_clicked"
      | "iteration_limit_seen"
      | "iteration_limit_clicked",
  ) => {
    if (trackedPremiumContexts.has(step)) return;
    trackedPremiumContexts.add(step);
    void window.vessel.premium.trackContext(step).catch(() => {
      trackedPremiumContexts.delete(step);
    });
  };

  const openPremiumCheckout = (
    step:
      | "chat_banner_clicked"
      | "premium_gate_clicked"
      | "iteration_limit_clicked",
  ) => {
    trackPremiumContext(step);
    void window.vessel.premium.checkout(premiumState().email || undefined);
  };

  const openPremiumDetails = () => {
    void openSettings();
  };

  onMount(() => {
    void window.vessel.premium.getState().then(setPremiumState).catch(() => {
      /* premium API unavailable */
    });
    const cleanup = window.vessel.premium.onUpdate(setPremiumState);
    onCleanup(cleanup);
  });

  const syncHighlightCount = async () => {
    try {
      const count = (await window.vessel.highlights.getCount()) ?? 0;
      setHighlightCount(count);
      if (count === 0) {
        setHighlightIndex(-1);
        return;
      }
      if (highlightIndex() >= count) {
        setHighlightIndex(count - 1);
      }
    } catch {
      /* ignore */
    }
  };

  createEffect(() => {
    if (sidebarTab() === "chat") {
      void syncHighlightCount();
    }
  });

  createEffect(() => {
    if (sidebarTab() === "chat" && !isPremium()) {
      trackPremiumContext("chat_banner_viewed");
    }
  });

  createEffect(() => {
    if (isPremium()) return;
    for (const message of messages()) {
      const kind = getPremiumPromptKind(message.content);
      if (kind === "premium_gate") {
        trackPremiumContext("premium_gate_seen");
      } else if (kind === "iteration_limit") {
        trackPremiumContext("iteration_limit_seen");
      }
    }

    const streamingKind = getPremiumPromptKind(streamingText());
    if (streamingKind === "premium_gate") {
      trackPremiumContext("premium_gate_seen");
    } else if (streamingKind === "iteration_limit") {
      trackPremiumContext("iteration_limit_seen");
    }
  });

  createEffect(() => {
    const unsubscribe = window.vessel.highlights.onCountUpdate((count) => {
      setHighlightCount(count);
      if (count === 0) {
        setHighlightIndex(-1);
        return;
      }
      if (highlightIndex() >= count) {
        setHighlightIndex(count - 1);
      }
    });
    onCleanup(unsubscribe);
  });

  const scrollToHighlight = async (idx: number) => {
    const count = highlightCount();
    if (count === 0) return;
    const clamped = Math.max(0, Math.min(idx, count - 1));
    setHighlightIndex(clamped);
    await window.vessel.highlights.scrollTo(clamped);
  };

  const removeCurrentHighlight = async () => {
    const idx = highlightIndex();
    if (idx < 0) return;
    await window.vessel.highlights.remove(idx);
    const nextCount = highlightCount();
    if (nextCount === 0) {
      setHighlightIndex(-1);
    } else if (idx >= nextCount) {
      setHighlightIndex(nextCount - 1);
      await window.vessel.highlights.scrollTo(nextCount - 1);
    }
  };

  const clearAllHighlights = async () => {
    await window.vessel.highlights.clearAll();
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

  createEffect(() => {
    const unsubscribe = window.vessel.bookmarks.onAddContextToChat(
      (bookmarkId) => {
        const bookmark = bookmarksState().bookmarks.find(
          (item) => item.id === bookmarkId,
        );
        if (!bookmark) return;

        const folder =
          bookmark.folderId === UNSORTED_FOLDER.id
            ? UNSORTED_FOLDER
            : (bookmarksState().folders.find(
                (item) => item.id === bookmark.folderId,
              ) ?? null);
        const contextBlock = buildAndRememberBookmarkContext({
          bookmark,
          folder,
          messages: messages(),
        });

        setSidebarTab("chat");
        setChatInput((current) =>
          current.trim()
            ? `${current.trim()}\n\n${contextBlock}`
            : contextBlock,
        );
        queueMicrotask(() => {
          chatInputRef?.focus();
          const length = chatInputRef?.value.length ?? 0;
          chatInputRef?.setSelectionRange(length, length);
        });
      },
    );
    onCleanup(unsubscribe);
  });

  const handleChatSend = async () => {
    const prompt = chatInput().trim();
    if (!prompt) return;
    const result = await query(prompt);
    if (result !== "rejected") {
      setChatInput("");
    }
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
  const [checkpointNote, setCheckpointNote] = createSignal("");
  const [bookmarkNote, setBookmarkNote] = createSignal("");
  const [bookmarkIntent, setBookmarkIntent] = createSignal("");
  const [bookmarkExpectedContent, setBookmarkExpectedContent] =
    createSignal("");
  const [bookmarkKeyFields, setBookmarkKeyFields] = createSignal("");
  const [bookmarkAgentHints, setBookmarkAgentHints] = createSignal("");
  const [bookmarkSaveExpanded, setBookmarkSaveExpanded] = createSignal(false);
  const [selectedFolderId, setSelectedFolderId] = createSignal<string>(
    UNSORTED_FOLDER.id,
  );
  const [newFolderName, setNewFolderName] = createSignal("");
  const [newFolderSummary, setNewFolderSummary] = createSignal("");
  const [bookmarkSearchQuery, setBookmarkSearchQuery] = createSignal("");
  const [bookmarkExportMessage, setBookmarkExportMessage] = createSignal("");
  const [bookmarkExporting, setBookmarkExporting] = createSignal(false);
  const [bookmarkImportExpanded, setBookmarkImportExpanded] = createSignal(false);
  const [bookmarkImporting, setBookmarkImporting] = createSignal(false);
  const [bookmarkImportMessage, setBookmarkImportMessage] = createSignal("");
  const [editingFolderId, setEditingFolderId] = createSignal<string | null>(
    null,
  );
  const [editingFolderName, setEditingFolderName] = createSignal("");
  const [editingFolderSummary, setEditingFolderSummary] = createSignal("");
  const [editingBookmarkId, setEditingBookmarkId] = createSignal<string | null>(
    null,
  );
  const [editingBookmarkTitle, setEditingBookmarkTitle] = createSignal("");
  const [editingBookmarkNote, setEditingBookmarkNote] = createSignal("");
  const [editingBookmarkIntent, setEditingBookmarkIntent] = createSignal("");
  const [editingBookmarkExpectedContent, setEditingBookmarkExpectedContent] =
    createSignal("");
  const [editingBookmarkKeyFields, setEditingBookmarkKeyFields] =
    createSignal("");
  const [editingBookmarkAgentHints, setEditingBookmarkAgentHints] =
    createSignal("");
  const [deletingFolderId, setDeletingFolderId] = createSignal<string | null>(
    null,
  );
  const [expandedFolderIds, setExpandedFolderIds] = createSignal<string[]>([
    UNSORTED_FOLDER.id,
  ]);
  const [actionsExpanded, setActionsExpanded] = createSignal(false);
  const [checkpointsExpanded, setCheckpointsExpanded] = createSignal(false);
  const [isDragging, setIsDragging] = createSignal(false);
  const now = useNow();
  let messagesContainerRef: HTMLDivElement | undefined;
  let messagesEndRef: HTMLDivElement | undefined;
  let chatInputRef: HTMLTextAreaElement | undefined;
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

  const elapsedSeconds = createMemo(() => {
    const startedAt = streamStartedAt();
    if (!isStreaming() || !startedAt) return 0;
    return Math.max(0, Math.floor((now() - startedAt) / 1000));
  });

  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    // Expand the sidebar view to full window so pointer capture works across the drag
    void window.vessel.ui.startSidebarResize().catch(() => {
      /* ignore IPC failures during drag start */
    });

    // Capture initial state so the reference frame stays fixed during drag
    const startX = e.screenX;
    const startWidth = sidebarWidth();
    let finished = false;

    // Use a mutable state object shared between handlers
    const state = { currentX: startX, rafId: null as number | null };

    const flushResizeUpdate = () => {
      state.rafId = null;
      if (finished) return;
      // Calculate width based on total delta from start (not incremental)
      const totalDelta = startX - state.currentX;
      const targetWidth = startWidth + totalDelta;
      const newWidth = Math.max(240, Math.min(800, Math.round(targetWidth)));
      resizeSidebar(newWidth);
    };

    const clearPointerTracking = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      target.removeEventListener("lostpointercapture", onPointerUp);
      if (target.hasPointerCapture?.(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      // Update current position - RAF will calculate the actual width
      state.currentX = ev.screenX;
      if (state.rafId === null) {
        state.rafId = requestAnimationFrame(flushResizeUpdate);
      }
    };

    const finishResize = () => {
      if (finished) return;
      finished = true;
      // Flush any pending resize before committing
      if (state.rafId !== null) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      flushResizeUpdate();
      setIsDragging(false);
      clearPointerTracking();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      void commitResize().catch(() => {
        /* ignore commit failures during drag cleanup */
      });
    };

    const onPointerUp = () => {
      finishResize();
    };

    const onWindowBlur = () => {
      finishResize();
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        finishResize();
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    target.addEventListener("lostpointercapture", onPointerUp);
  };

  const formatBookmarkDate = (savedAt: string) =>
    new Date(savedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const parseBookmarkKeyFields = (value: string): string[] | undefined => {
    const fields = value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    return fields.length > 0 ? fields : undefined;
  };

  const parseBookmarkAgentHints = (
    value: string,
  ): Record<string, string> | undefined => {
    const entries = value
      .split("\n")
      .map((line) => {
        const separator = line.indexOf(":");
        if (separator === -1) return null;
        const key = line.slice(0, separator).trim();
        const hint = line.slice(separator + 1).trim();
        return key ? ([key, hint] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] => Boolean(entry))
      .filter(([, hint]) => hint.length > 0);

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  const formatBookmarkKeyFields = (value?: string[]) => value?.join(", ") || "";

  const formatBookmarkAgentHints = (value?: Record<string, string>) =>
    value
      ? Object.entries(value)
          .map(([key, hint]) => `${key}: ${hint}`)
          .join("\n")
      : "";

  const resetBookmarkEditor = () => {
    setEditingBookmarkId(null);
    setEditingBookmarkTitle("");
    setEditingBookmarkNote("");
    setEditingBookmarkIntent("");
    setEditingBookmarkExpectedContent("");
    setEditingBookmarkKeyFields("");
    setEditingBookmarkAgentHints("");
  };

  const startEditingBookmark = (bookmark: Bookmark) => {
    setEditingBookmarkId(bookmark.id);
    setEditingBookmarkTitle(bookmark.title || bookmark.url);
    setEditingBookmarkNote(bookmark.note || "");
    setEditingBookmarkIntent(bookmark.intent || "");
    setEditingBookmarkExpectedContent(bookmark.expectedContent || "");
    setEditingBookmarkKeyFields(formatBookmarkKeyFields(bookmark.keyFields));
    setEditingBookmarkAgentHints(formatBookmarkAgentHints(bookmark.agentHints));
  };

  const handleSaveBookmark = async () => {
    const tab = currentTab();
    if (!tab?.url) return;
    await saveBookmark(
      tab.url,
      tab.title?.trim() || tab.url,
      selectedFolderId(),
      bookmarkNote(),
      bookmarkIntent() || undefined,
      bookmarkExpectedContent() || undefined,
      parseBookmarkKeyFields(bookmarkKeyFields()),
      parseBookmarkAgentHints(bookmarkAgentHints()),
    );
    setBookmarkNote("");
    setBookmarkIntent("");
    setBookmarkExpectedContent("");
    setBookmarkKeyFields("");
    setBookmarkAgentHints("");
    setBookmarkSaveExpanded(false);
  };

  const handleUpdateBookmark = async (bookmarkId: string) => {
    const updated = await updateBookmark(bookmarkId, {
      title: editingBookmarkTitle(),
      note: editingBookmarkNote(),
      intent: editingBookmarkIntent(),
      expectedContent: editingBookmarkExpectedContent(),
      keyFields: parseBookmarkKeyFields(editingBookmarkKeyFields()),
      agentHints: parseBookmarkAgentHints(editingBookmarkAgentHints()),
    });
    if (!updated) return;
    resetBookmarkEditor();
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

  const handleRemoveFolder = async (
    folderId: string,
    deleteContents: boolean,
  ) => {
    const removed = await removeFolder(folderId, deleteContents);
    if (!removed) return;
    setDeletingFolderId(null);
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

  const handleExportFolder = async (folderId: string, folderName: string) => {
    setBookmarkExporting(true);
    setBookmarkExportMessage("");
    try {
      const result = await exportFolderHtml(folderId, { includeNotes: true });
      if (!result) {
        setBookmarkExportMessage("Export canceled.");
        return;
      }
      setBookmarkExportMessage(
        `Exported ${folderName} (${result.count} bookmarks) to ${result.filePath}`,
      );
    } catch (error) {
      setBookmarkExportMessage(
        error instanceof Error
          ? error.message
          : `Could not export ${folderName}.`,
      );
    } finally {
      setBookmarkExporting(false);
    }
  };

  const handleExportBookmarks = async (
    format: "html" | "html-with-notes" | "json",
  ) => {
    setBookmarkExporting(true);
    setBookmarkExportMessage("");
    try {
      const result =
        format === "json"
          ? await exportJson()
          : await exportHtml({ includeNotes: format === "html-with-notes" });
      if (!result) {
        setBookmarkExportMessage("Export canceled.");
        return;
      }
      setBookmarkExportMessage(
        `Exported ${result.count} bookmarks to ${result.filePath}`,
      );
    } catch (error) {
      setBookmarkExportMessage(
        error instanceof Error ? error.message : "Could not export bookmarks.",
      );
    } finally {
      setBookmarkExporting(false);
    }
  };

  const handleImportBookmarks = async (format: "html" | "json") => {
    setBookmarkImporting(true);
    setBookmarkImportMessage("");
    try {
      const result =
        format === "json"
          ? await window.vessel.bookmarks.importJson()
          : await window.vessel.bookmarks.importHtml();
      if (!result) {
        setBookmarkImportMessage("Import canceled.");
        return;
      }
      setBookmarkImportMessage(
        `Imported ${result.imported} bookmarks (${result.skipped} duplicates skipped, ${result.errors} errors)`,
      );
    } catch (error) {
      setBookmarkImportMessage(
        error instanceof Error ? error.message : "Could not import bookmarks.",
      );
    } finally {
      setBookmarkImporting(false);
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

  onMount(() => {
    const cleanup = window.vessel.ui.onSidebarNavigate((tab) => {
      if (
        tab === "supervisor" ||
        tab === "bookmarks" ||
        tab === "checkpoints" ||
        tab === "chat" ||
        tab === "automation" ||
        tab === "history" ||
        tab === "diff"
      ) {
        setSidebarTab(tab);
      }
    });
    onCleanup(cleanup);
  });

  return (
    <Show when={props.forceOpen || sidebarOpen()}>
      <div class="sidebar" style={{ width: `${sidebarWidth()}px` }}>
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
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "automation" }}
            role="tab"
            aria-selected={sidebarTab() === "automation"}
            onClick={() => setSidebarTab("automation")}
          >
            Automate
          </button>
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "history" }}
            role="tab"
            aria-selected={sidebarTab() === "history"}
            onClick={() => setSidebarTab("history")}
          >
            History
          </button>
          <button
            class="sidebar-tab"
            classList={{ active: sidebarTab() === "diff" }}
            role="tab"
            aria-selected={sidebarTab() === "diff"}
            onClick={() => setSidebarTab("diff")}
          >
            Changes
          </button>
        </div>

        <div
          class="sidebar-messages"
          ref={(el) => {
            messagesContainerRef = el;
            useScrollFade(el);
          }}
        >
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
                <Show when={runtimeState().canUndo}>
                  <button
                    class="agent-primary-button"
                    type="button"
                    onClick={() => void undoLastAction()}
                    title={
                      runtimeState().undoInfo
                        ? `Undo: ${runtimeState().undoInfo!.actionName}`
                        : "Undo last action"
                    }
                  >
                    Undo last action
                  </button>
                </Show>
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
                      <div
                        class="agent-card-approval-stripe"
                        aria-hidden="true"
                      />
                      <div class="agent-card-title">{approval.name}</div>
                      <div class="agent-card-copy">{approval.argsSummary}</div>
                      <div class="agent-card-copy">{approval.reason}</div>
                      <div class="agent-card-actions">
                        <button
                          class="agent-primary-button"
                          type="button"
                          onClick={() =>
                            void resolveApproval(approval.id, true)
                          }
                        >
                          Approve
                        </button>
                        <button
                          class="agent-control-button"
                          type="button"
                          onClick={() =>
                            void resolveApproval(approval.id, false)
                          }
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
                          <div class="agent-card-copy error">
                            {action.error}
                          </div>
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

              <div class="bookmark-export-card">
                <div>
                  <div class="bookmark-panel-title">Export</div>
                  <div class="bookmark-panel-subtitle">
                    Save browser-ready HTML or a full Vessel archive
                  </div>
                </div>
                <div class="bookmark-export-actions">
                  <button
                    class="bookmark-secondary-button"
                    type="button"
                    disabled={bookmarkExporting()}
                    onClick={() => void handleExportBookmarks("html")}
                  >
                    Browser HTML
                  </button>
                  <button
                    class="bookmark-secondary-button"
                    type="button"
                    disabled={bookmarkExporting()}
                    onClick={() =>
                      void handleExportBookmarks("html-with-notes")
                    }
                  >
                    HTML + notes
                  </button>
                  <button
                    class="bookmark-secondary-button"
                    type="button"
                    disabled={bookmarkExporting()}
                    onClick={() => void handleExportBookmarks("json")}
                  >
                    Vessel JSON
                  </button>
                </div>
                <Show when={bookmarkExportMessage()}>
                  <div class="bookmark-export-message">
                    {bookmarkExportMessage()}
                  </div>
                </Show>
              </div>

              <div class="bookmark-import-shell">
                <button
                  class="bookmark-save-toggle"
                  type="button"
                  onClick={() => setBookmarkImportExpanded((current) => !current)}
                >
                  <span class="bookmark-save-toggle-copy">
                    <span class="bookmark-save-toggle-title">
                      Import Bookmarks
                    </span>
                    <span class="bookmark-save-toggle-subtitle">
                      Import from HTML or Vessel JSON
                    </span>
                  </span>
                  <span
                    class="bookmark-save-toggle-caret"
                    classList={{ expanded: bookmarkImportExpanded() }}
                    aria-hidden="true"
                  >
                    ▾
                  </span>
                </button>
                <Show when={bookmarkImportExpanded()}>
                  <div class="bookmark-save-body">
                    <div class="bookmark-export-actions">
                      <button
                        class="bookmark-secondary-button"
                        type="button"
                        disabled={bookmarkImporting()}
                        onClick={() => void handleImportBookmarks("html")}
                      >
                        Import HTML
                      </button>
                      <button
                        class="bookmark-secondary-button"
                        type="button"
                        disabled={bookmarkImporting()}
                        onClick={() => void handleImportBookmarks("json")}
                      >
                        Import JSON
                      </button>
                    </div>
                    <Show when={bookmarkImportMessage()}>
                      <div class="bookmark-export-message">
                        {bookmarkImportMessage()}
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>

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
                    <textarea
                      class="bookmark-note-input"
                      value={bookmarkIntent()}
                      onInput={(e) =>
                        setBookmarkIntent(e.currentTarget.value)
                      }
                      placeholder="Intent: what is this page for?"
                      rows={1}
                    />
                    <textarea
                      class="bookmark-note-input"
                      value={bookmarkExpectedContent()}
                      onInput={(e) =>
                        setBookmarkExpectedContent(e.currentTarget.value)
                      }
                      placeholder="Expected content: what should be here?"
                      rows={1}
                    />
                    <input
                      class="bookmark-input"
                      value={bookmarkKeyFields()}
                      onInput={(e) =>
                        setBookmarkKeyFields(e.currentTarget.value)
                      }
                      placeholder="Key fields (comma-separated)"
                    />
                    <textarea
                      class="bookmark-note-input"
                      value={bookmarkAgentHints()}
                      onInput={(e) =>
                        setBookmarkAgentHints(e.currentTarget.value)
                      }
                      placeholder="Agent hints (one key:value per line)"
                      rows={2}
                    />
                  </div>
                </Show>
              </div>

              <form
                class="bookmark-folder-create"
                onSubmit={handleCreateFolder}
              >
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
                              classList={{
                                expanded: isFolderExpanded(folder.id),
                              }}
                              aria-hidden="true"
                            >
                              ▸
                            </span>
                            <div>
                              <div class="bookmark-folder-name">
                                {folder.name}
                              </div>
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
                                class="bookmark-ghost-button"
                                type="button"
                                disabled={bookmarkExporting()}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void handleExportFolder(folder.id, folder.name);
                                }}
                              >
                                Export
                              </button>
                              <button
                                class="bookmark-ghost-button danger"
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeletingFolderId(folder.id);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </Show>
                        </div>

                        <Show when={deletingFolderId() === folder.id}>
                          <div class="bookmark-folder-delete-confirm">
                            <p class="bookmark-delete-prompt">
                              Delete "{folder.name}"?
                              {folder.items.length > 0
                                ? ` This folder has ${folder.items.length} bookmark${folder.items.length === 1 ? "" : "s"}.`
                                : ""}
                            </p>
                            <div class="bookmark-delete-options">
                              <Show when={folder.items.length > 0}>
                                <button
                                  class="bookmark-ghost-button"
                                  type="button"
                                  onClick={() =>
                                    void handleRemoveFolder(folder.id, false)
                                  }
                                >
                                  Keep bookmarks
                                </button>
                              </Show>
                              <button
                                class="bookmark-ghost-button danger"
                                type="button"
                                onClick={() =>
                                  void handleRemoveFolder(folder.id, true)
                                }
                              >
                                {folder.items.length > 0
                                  ? "Delete all"
                                  : "Delete folder"}
                              </button>
                              <button
                                class="bookmark-ghost-button"
                                type="button"
                                onClick={() => setDeletingFolderId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </Show>

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
                                  <div
                                    class="bookmark-item"
                                    data-bookmark-id={bookmark.id}
                                  >
                                    <button
                                      class="bookmark-item-link"
                                      type="button"
                                      onClick={() =>
                                        void createTab(bookmark.url)
                                      }
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
                                    <Show
                                      when={
                                        bookmark.intent ||
                                        bookmark.expectedContent ||
                                        (bookmark.keyFields?.length || 0) > 0 ||
                                        ((bookmark.agentHints &&
                                          Object.keys(bookmark.agentHints)
                                            .length) ||
                                          0) > 0
                                      }
                                    >
                                      <div class="bookmark-item-note">
                                        <Show when={bookmark.intent}>
                                          <div>
                                            <strong>Intent:</strong>{" "}
                                            {bookmark.intent}
                                          </div>
                                        </Show>
                                        <Show when={bookmark.expectedContent}>
                                          <div>
                                            <strong>Expected:</strong>{" "}
                                            {bookmark.expectedContent}
                                          </div>
                                        </Show>
                                        <Show
                                          when={
                                            (bookmark.keyFields?.length || 0) > 0
                                          }
                                        >
                                          <div>
                                            <strong>Key fields:</strong>{" "}
                                            {bookmark.keyFields?.join(", ")}
                                          </div>
                                        </Show>
                                        <Show
                                          when={
                                            bookmark.agentHints &&
                                            Object.keys(bookmark.agentHints)
                                              .length > 0
                                          }
                                        >
                                          <div>
                                            <strong>Hints:</strong>{" "}
                                            {Object.entries(
                                              bookmark.agentHints || {},
                                            )
                                              .map(
                                                ([key, hint]) =>
                                                  `${key}: ${hint}`,
                                              )
                                              .join(" • ")}
                                          </div>
                                        </Show>
                                      </div>
                                    </Show>
                                    <Show when={editingBookmarkId() === bookmark.id}>
                                      <div class="bookmark-folder-edit">
                                        <input
                                          class="bookmark-input"
                                          value={editingBookmarkTitle()}
                                          onInput={(e) =>
                                            setEditingBookmarkTitle(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Bookmark title"
                                        />
                                        <textarea
                                          class="bookmark-note-input"
                                          rows={2}
                                          value={editingBookmarkNote()}
                                          onInput={(e) =>
                                            setEditingBookmarkNote(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Why this bookmark matters"
                                        />
                                        <textarea
                                          class="bookmark-note-input"
                                          rows={1}
                                          value={editingBookmarkIntent()}
                                          onInput={(e) =>
                                            setEditingBookmarkIntent(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Intent"
                                        />
                                        <textarea
                                          class="bookmark-note-input"
                                          rows={1}
                                          value={editingBookmarkExpectedContent()}
                                          onInput={(e) =>
                                            setEditingBookmarkExpectedContent(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Expected content"
                                        />
                                        <input
                                          class="bookmark-input"
                                          value={editingBookmarkKeyFields()}
                                          onInput={(e) =>
                                            setEditingBookmarkKeyFields(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Key fields (comma-separated)"
                                        />
                                        <textarea
                                          class="bookmark-note-input"
                                          rows={2}
                                          value={editingBookmarkAgentHints()}
                                          onInput={(e) =>
                                            setEditingBookmarkAgentHints(
                                              e.currentTarget.value,
                                            )
                                          }
                                          placeholder="Agent hints (one key:value per line)"
                                        />
                                        <div class="bookmark-item-footer">
                                          <button
                                            class="bookmark-secondary-button"
                                            type="button"
                                            onClick={() =>
                                              void handleUpdateBookmark(
                                                bookmark.id,
                                              )
                                            }
                                          >
                                            Save edits
                                          </button>
                                          <button
                                            class="bookmark-ghost-button"
                                            type="button"
                                            onClick={resetBookmarkEditor}
                                          >
                                            Cancel
                                          </button>
                                        </div>
                                      </div>
                                    </Show>
                                    <div class="bookmark-item-footer">
                                      <span class="bookmark-item-time">
                                        {formatBookmarkDate(bookmark.savedAt)}
                                      </span>
                                      <button
                                        class="bookmark-ghost-button"
                                        type="button"
                                        onClick={() =>
                                          editingBookmarkId() === bookmark.id
                                            ? resetBookmarkEditor()
                                            : startEditingBookmark(bookmark)
                                        }
                                      >
                                        {editingBookmarkId() === bookmark.id
                                          ? "Close"
                                          : "Edit"}
                                      </button>
                                      <button
                                        class="bookmark-ghost-button danger"
                                        type="button"
                                        onClick={() => {
                                          if (editingBookmarkId() === bookmark.id) {
                                            resetBookmarkEditor();
                                          }
                                          void removeBookmark(bookmark.id);
                                        }}
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
                  <textarea
                    class="agent-textarea"
                    rows={2}
                    value={checkpointNote()}
                    onInput={(e) => setCheckpointNote(e.currentTarget.value)}
                    placeholder="Optional note for this checkpoint"
                  />
                  <button
                    class="agent-primary-button"
                    type="button"
                    onClick={async () => {
                      const name = checkpointName().trim();
                      await createCheckpoint(
                        name || undefined,
                        checkpointNote() || undefined,
                      );
                      setCheckpointName("");
                      setCheckpointNote("");
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
                            <div class="checkpoint-timeline-name">
                              {checkpoint.name}
                            </div>
                            <div class="checkpoint-timeline-time">
                              {new Date(checkpoint.createdAt).toLocaleString()}
                            </div>
                            <textarea
                              class="agent-textarea"
                              rows={2}
                              placeholder="Add a note..."
                              value={checkpoint.note || ""}
                              onBlur={(e) =>
                                void updateCheckpointNote(
                                  checkpoint.id,
                                  e.currentTarget.value,
                                )
                              }
                            />
                            <button
                              class="agent-control-button"
                              type="button"
                              onClick={() =>
                                void restoreCheckpoint(checkpoint.id)
                              }
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

          <Show when={sidebarTab() === "automation"}>
            <AutomationTab onRun={() => setSidebarTab("supervisor")} />
          </Show>

          <Show when={sidebarTab() === "history"}>
            <div class="history-panel">
              <div class="history-panel-header">
                <span class="history-panel-title">Browsing History</span>
                <div class="history-panel-actions">
                  <button
                    class="history-clear-btn"
                    onClick={async () => {
                      await history.clear();
                    }}
                  >
                    Clear
                  </button>
                  <button
                    class="history-clear-btn"
                    onClick={async () => {
                      const result = await window.vessel.history.exportHtml();
                      if (!result) return;
                    }}
                  >
                    Export HTML
                  </button>
                  <button
                    class="history-clear-btn"
                    onClick={async () => {
                      const result = await window.vessel.history.exportJson();
                      if (!result) return;
                    }}
                  >
                    Export JSON
                  </button>
                  <button
                    class="history-clear-btn"
                    onClick={async () => {
                      const result = await window.vessel.history.importFile();
                      if (!result) return;
                    }}
                  >
                    Import
                  </button>
                </div>
              </div>
              <div class="history-list">
                <For each={history.historyState().entries}>
                  {(entry) => (
                    <button
                      class="history-entry"
                      onClick={() => createTab(entry.url)}
                    >
                      <span class="history-entry-title">{entry.title || entry.url}</span>
                      <span class="history-entry-url">{entry.url}</span>
                      <span class="history-entry-time">
                        {new Date(entry.visitedAt).toLocaleString()}
                      </span>
                    </button>
                  )}
                </For>
                <Show when={history.historyState().entries.length === 0}>
                  <p class="history-empty">No browsing history yet.</p>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={sidebarTab() === "diff"}>
            <section class="agent-panel">
              <div class="agent-panel-header">
                <div class="agent-panel-title">What Changed</div>
                <div class="agent-panel-subtitle">
                  {isPremium()
                    ? "Page change timeline"
                    : "Premium feature"}
                </div>
              </div>
              <Show
                when={isPremium()}
                fallback={
                  <div class="kit-upsell premium-chat-banner">
                    <p class="kit-upsell-title">Vessel Premium</p>
                    <p class="kit-upsell-body premium-chat-banner-body">
                      The Diff timeline is a premium feature. Upgrade to see a
                      full history of what changed on this page.
                    </p>
                    <div class="premium-inline-actions premium-chat-banner-actions">
                      <button
                        class="agent-primary-button premium-inline-primary"
                        type="button"
                        onClick={() =>
                          void window.vessel.premium
                            .checkout(premiumState().email || undefined)
                            .catch(() => {
                              /* ignore */
                            })
                        }
                      >
                        Start 7-day free trial — $5.99/mo after
                      </button>
                      <button
                        class="agent-control-button premium-inline-secondary"
                        type="button"
                        onClick={openPremiumDetails}
                      >
                        See Premium
                      </button>
                    </div>
                  </div>
                }
              >
                <PageDiffTimeline />
              </Show>
            </section>
          </Show>

          <Show when={sidebarTab() === "chat"}>
            <Show when={!isPremium()}>
              <div class="kit-upsell premium-chat-banner">
                <p class="kit-upsell-title">Vessel Premium</p>
                <p class="kit-upsell-body premium-chat-banner-body">
                  Give the built-in agent a bigger toolbox and longer runway:
                  screenshots, saved sessions, workflow tracking, table
                  extraction, and up to 1,000 tool calls per turn.
                </p>
                <div class="premium-inline-actions premium-chat-banner-actions">
                  <button
                    class="agent-primary-button premium-inline-primary"
                    type="button"
                    onClick={() => openPremiumCheckout("chat_banner_clicked")}
                  >
                    Start 7-day free trial — $5.99/mo after
                  </button>
                  <button
                    class="agent-control-button premium-inline-secondary"
                    type="button"
                    onClick={openPremiumDetails}
                  >
                    See Premium
                  </button>
                </div>
              </div>
            </Show>
            <For each={messages()}>
              {(msg) => (
                <div class={`message message-${msg.role}`}>
                  <MarkdownMessage content={msg.content} />
                  <Show
                    when={
                      msg.role === "assistant"
                        ? getPremiumPromptKind(msg.content)
                        : null
                    }
                  >
                    {(kind) => (
                      <PremiumPromptCard
                        kind={kind()}
                        compact
                        onStartTrial={() =>
                          openPremiumCheckout(
                            kind() === "premium_gate"
                              ? "premium_gate_clicked"
                              : "iteration_limit_clicked",
                          )
                        }
                        onOpenSettings={openPremiumDetails}
                      />
                    )}
                  </Show>
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
                      <Show when={getPremiumPromptKind(streamingText())}>
                        {(kind) => (
                          <PremiumPromptCard
                            kind={kind()}
                            compact
                            onStartTrial={() =>
                              openPremiumCheckout(
                                kind() === "premium_gate"
                                  ? "premium_gate_clicked"
                                  : "iteration_limit_clicked",
                              )
                            }
                            onOpenSettings={openPremiumDetails}
                          />
                        )}
                      </Show>
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
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 4.75a.75.75 0 011.5 0v3.5a.75.75 0 01-1.5 0v-3.5zM8 11.5a.75.75 0 110-1.5.75.75 0 010 1.5z"
                          fill="currentColor"
                        />
                      </svg>
                    </div>
                    <div class="chat-approval-body">
                      <div class="chat-approval-title">
                        Approval needed: <strong>{approval.name}</strong>
                      </div>
                      <Show when={approval.argsSummary}>
                        <div class="chat-approval-detail">
                          {approval.argsSummary}
                        </div>
                      </Show>
                      <div class="chat-approval-detail">{approval.reason}</div>
                      <div class="chat-approval-actions">
                        <button
                          class="chat-approval-btn chat-approval-approve"
                          type="button"
                          onClick={() =>
                            void resolveApproval(approval.id, true)
                          }
                        >
                          Approve
                        </button>
                        <button
                          class="chat-approval-btn chat-approval-reject"
                          type="button"
                          onClick={() =>
                            void resolveApproval(approval.id, false)
                          }
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
                <svg
                  class="sidebar-empty-icon"
                  width="48"
                  height="48"
                  viewBox="0 0 48 48"
                  aria-hidden="true"
                >
                  {/* Edges — outer connections */}
                  <line
                    x1="8"
                    y1="8"
                    x2="24"
                    y2="5"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="24"
                    y1="5"
                    x2="40"
                    y2="10"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="8"
                    y1="8"
                    x2="6"
                    y2="24"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="40"
                    y1="10"
                    x2="44"
                    y2="26"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="6"
                    y1="24"
                    x2="10"
                    y2="38"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="44"
                    y1="26"
                    x2="38"
                    y2="40"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="10"
                    y1="38"
                    x2="24"
                    y2="44"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.35"
                  />
                  <line
                    x1="38"
                    y1="40"
                    x2="24"
                    y2="44"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.35"
                  />
                  {/* Edges — inner web */}
                  <line
                    x1="8"
                    y1="8"
                    x2="20"
                    y2="18"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.5"
                  />
                  <line
                    x1="24"
                    y1="5"
                    x2="20"
                    y2="18"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="40"
                    y1="10"
                    x2="32"
                    y2="20"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.5"
                  />
                  <line
                    x1="20"
                    y1="18"
                    x2="32"
                    y2="20"
                    stroke="var(--accent-primary)"
                    stroke-width="0.75"
                    opacity="0.3"
                  />
                  <line
                    x1="6"
                    y1="24"
                    x2="18"
                    y2="30"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="20"
                    y1="18"
                    x2="18"
                    y2="30"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="32"
                    y1="20"
                    x2="36"
                    y2="30"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="44"
                    y1="26"
                    x2="36"
                    y2="30"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.45"
                  />
                  <line
                    x1="18"
                    y1="30"
                    x2="36"
                    y2="30"
                    stroke="var(--accent-primary)"
                    stroke-width="0.75"
                    opacity="0.25"
                  />
                  <line
                    x1="18"
                    y1="30"
                    x2="10"
                    y2="38"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="36"
                    y1="30"
                    x2="38"
                    y2="40"
                    stroke="var(--border-visible)"
                    stroke-width="1"
                    opacity="0.4"
                  />
                  <line
                    x1="18"
                    y1="30"
                    x2="24"
                    y2="44"
                    stroke="var(--accent-primary)"
                    stroke-width="0.75"
                    opacity="0.2"
                  />
                  <line
                    x1="36"
                    y1="30"
                    x2="24"
                    y2="44"
                    stroke="var(--accent-primary)"
                    stroke-width="0.75"
                    opacity="0.2"
                  />
                  {/* Nodes — outer ring */}
                  <circle
                    cx="8"
                    cy="8"
                    r="2.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.55"
                  />
                  <circle
                    cx="24"
                    cy="5"
                    r="2"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.45"
                  />
                  <circle
                    cx="40"
                    cy="10"
                    r="3"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.7"
                  />
                  <circle
                    cx="6"
                    cy="24"
                    r="2"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.5"
                  />
                  <circle
                    cx="44"
                    cy="26"
                    r="2.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.55"
                  />
                  <circle
                    cx="10"
                    cy="38"
                    r="2.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.5"
                  />
                  <circle
                    cx="38"
                    cy="40"
                    r="2"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.45"
                  />
                  <circle
                    cx="24"
                    cy="44"
                    r="2.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.5"
                  />
                  {/* Nodes — inner core */}
                  <circle
                    cx="20"
                    cy="18"
                    r="3.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.85"
                  />
                  <circle
                    cx="32"
                    cy="20"
                    r="4"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.9"
                  />
                  <circle
                    cx="18"
                    cy="30"
                    r="3"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.75"
                  />
                  <circle
                    cx="36"
                    cy="30"
                    r="3.5"
                    fill="var(--bg-secondary)"
                    stroke="var(--accent-primary)"
                    stroke-width="1.5"
                    opacity="0.8"
                  />
                </svg>
                <p class="sidebar-empty-title">Your move.</p>
                <p class="sidebar-empty-hint">
                  Configure a provider in Settings (Ctrl+,) then ask anything
                  about the current page or beyond.
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
                <button
                  class="chat-action-btn"
                  onClick={() => cancel()}
                  title="Stop generating"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="2"
                      y="2"
                      width="10"
                      height="10"
                      rx="1.5"
                      fill="currentColor"
                    />
                  </svg>
                  Stop
                </button>
              </Show>
              <Show when={!isStreaming() && messages().length > 0}>
                <button
                  class="chat-action-btn"
                  onClick={handleRetry}
                  title="Retry last prompt"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M11.5 7a4.5 4.5 0 1 1-1.3-3.2"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                    />
                    <path
                      d="M10.5 1v3h-3"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
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
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M8 10L4 6l4-4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
              <button
                class="highlight-nav-label"
                type="button"
                onClick={() =>
                  void scrollToHighlight(
                    highlightIndex() < 0 ? 0 : highlightIndex(),
                  )
                }
                title="Go to current highlight"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle
                    cx="6"
                    cy="6"
                    r="3"
                    fill="rgba(196, 160, 90, 0.6)"
                    stroke="rgba(196, 160, 90, 0.9)"
                    stroke-width="1"
                  />
                </svg>
                {highlightIndex() >= 0
                  ? `${highlightIndex() + 1} / ${highlightCount()}`
                  : `${highlightCount()} highlight${highlightCount() > 1 ? "s" : ""}`}
              </button>
              <button
                class="highlight-nav-btn"
                type="button"
                disabled={highlightIndex() >= highlightCount() - 1}
                onClick={() =>
                  void scrollToHighlight(
                    highlightIndex() < 0 ? 0 : highlightIndex() + 1,
                  )
                }
                title="Next highlight"
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M4 2l4 4-4 4"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </button>
            </div>
          </Show>
          <Show when={queueNotice() !== null || pendingQueryCount() > 0}>
            <div class="chat-queue-status">
              <div class="chat-queue-status-row">
                <span>{queueNotice() ?? `Queued ${pendingQueryCount()}/${pendingQueryLimit}.`}</span>
                <Show when={pendingQueryCount() > 0}>
                  <button
                    class="chat-queue-clear"
                    type="button"
                    onClick={() => clearPendingQueries()}
                  >
                    Clear queue
                  </button>
                </Show>
              </div>
              <Show when={pendingQueries().length > 0}>
                <div class="chat-queue-list">
                  <For each={pendingQueries()}>
                    {(pendingPrompt, index) => (
                      <div class="chat-queue-item">
                        <span class="chat-queue-text" title={pendingPrompt}>
                          {pendingPrompt}
                        </span>
                        <button
                          class="chat-queue-remove"
                          type="button"
                          aria-label={`Remove queued prompt ${index() + 1}`}
                          onClick={() => removePendingQuery(index())}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
          <div class="sidebar-input-area">
            <textarea
              class="sidebar-input"
              rows={2}
              placeholder={isStreaming() ? "Send now to queue the next prompt..." : "Ask anything..."}
              ref={chatInputRef}
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
              disabled={!chatInput().trim()}
              onClick={() => void handleChatSend()}
            >
              {isStreaming() ? "Queue" : "Send"}
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
};

export default Sidebar;
