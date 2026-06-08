import { app } from "electron";
import path from "path";
import {
  createDebouncedJsonPersistence,
  loadJsonFile,
} from "./json-file";

/**
 * Configuration for a PersistentState instance.
 *
 * @typeParam T  The full state shape stored on disk.
 * @typeParam E  The type emitted to subscribers (defaults to T).
 *               Use a different E when you want to project/derive
 *               the emitted value (e.g., paginated views).
 */
export interface PersistentStateConfig<T, E = T> {
  /** Filename under Electron's userData directory (e.g., "vessel-bookmarks.json"). */
  filename: string;

  /** Default state used when the file doesn't exist or is corrupt. */
  fallback: T;

  /**
   * Parse raw JSON into a validated state object.
   * Receives the parsed JSON value (typed as `unknown` for safety).
   * Should apply defensive checks (Array.isArray, typeof, etc.)
   * and return a valid T.
   */
  parse: (raw: unknown) => T;

  /** Log label for persistence operations (e.g., "bookmarks"). */
  logLabel: string;

  /** Debounce interval in ms before writing to disk. Defaults to 250. */
  debounceMs?: number;

  /** Whether to reset the debounce timer on each schedule call. Defaults to false. */
  resetOnSchedule?: boolean;

  /** Whether to use safeStorage encryption for the file. Defaults to false. */
  secure?: boolean;

  /**
   * Create a snapshot for emitting to subscribers.
   * Defaults to identity (emits the full state).
   * Return a derived type if you need to project the state
   * (e.g., paginated views).
   */
  snapshot?: (state: T) => E;
}

/**
 * Generic persistent state manager that eliminates the boilerplate
 * shared by bookmarks, history, highlights, and other domain managers.
 *
 * Handles:
 * - Lazy loading from a JSON file with defensive parsing
 * - Debounced persistence to disk
 * - Listener-based change notification
 * - Guaranteed initialization (no more `state!` assertions)
 *
 * Usage:
 * ```ts
 * const bookmarks = new PersistentState<BookmarksState>({
 *   filename: "vessel-bookmarks.json",
 *   fallback: { folders: [], bookmarks: [] },
 *   parse: (raw) => ({ ... }),
 *   logLabel: "bookmarks",
 * });
 *
 * // Read state (auto-loads if needed):
 * const s = bookmarks.getState();
 *
 * // Mutate, persist, and notify:
 * bookmarks.mutate(s => { s.bookmarks.push(newBookmark); });
 * ```
 */
export class PersistentState<T, E = T> {
  private state: T | null = null;
  private listeners = new Set<(snapshot: E) => void>();
  private persistence: ReturnType<typeof createDebouncedJsonPersistence<T>> | null = null;
  private readonly config: Required<PersistentStateConfig<T, E>>;

  constructor(config: PersistentStateConfig<T, E>) {
    this.config = {
      debounceMs: 250,
      resetOnSchedule: false,
      secure: false,
      snapshot: (s) => s as unknown as E,
      ...config,
    };
  }

  // --- State access ---

  /** Get the current state, loading from disk if needed. */
  getState(): T {
    if (this.state) return this.state;
    this.state = loadJsonFile({
      filePath: this.getFilePath(),
      fallback: this.config.fallback,
      parse: this.config.parse,
      secure: this.config.secure,
    });
    return this.state;
  }

  /**
   * Update state via a mutator function.
   * The mutator receives the current state and should mutate it in place.
   * Does NOT automatically save or emit — call save() and emit() as needed.
   */
  update(mutator: (state: T) => void): void {
    const s = this.getState();
    mutator(s);
  }

  /**
   * Mutate state and apply persistence/notification as one operation.
   * The mutator may return a value, such as the item it created or removed.
   */
  mutate<R>(
    mutator: (state: T) => R,
    options: { save?: boolean; emit?: boolean } = {},
  ): R {
    const result = mutator(this.getState());
    if (options.save ?? true) {
      this.save();
    }
    if (options.emit ?? true) {
      this.emit();
    }
    return result;
  }

  // --- Persistence ---

  /** Get the file path for this state's JSON file. */
  getFilePath(): string {
    return path.join(app.getPath("userData"), this.config.filename);
  }

  /** Schedule a debounced write to disk. */
  save(): void {
    this.getPersistence().schedule();
  }

  /** Flush any pending write to disk immediately. */
  flushPersist(): Promise<void> {
    return this.getPersistence().flush();
  }

  // --- Change notification ---

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: E) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit the current state to all subscribers. No-op if state hasn't been loaded. */
  emit(): void {
    if (!this.state) return;
    const snapshot = this.config.snapshot(this.state);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  // --- Private ---

  private getPersistence(): ReturnType<typeof createDebouncedJsonPersistence<T>> {
    if (!this.persistence) {
      this.persistence = createDebouncedJsonPersistence({
        debounceMs: this.config.debounceMs,
        filePath: this.getFilePath(),
        getValue: () => this.state,
        logLabel: this.config.logLabel,
        resetOnSchedule: this.config.resetOnSchedule,
        secure: this.config.secure,
      });
    }
    return this.persistence;
  }
}
