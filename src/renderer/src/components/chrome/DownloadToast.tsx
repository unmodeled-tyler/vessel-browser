import {
  For,
  createSignal,
  onMount,
  onCleanup,
  type Component,
} from "solid-js";
import "./chrome.css";

interface DownloadItem {
  id: string;
  savePath: string;
  filename: string;
  totalBytes: number;
  receivedBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  leaving: boolean;
}

const TOAST_DONE_DURATION_MS = 4200;
const TOAST_EXIT_MS = 300;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const DownloadToast: Component = () => {
  const [downloads, setDownloads] = createSignal<DownloadItem[]>([]);
  const downloadMap = new Map<string, DownloadItem>();
  const timeoutIds = new Map<string, number>();
  let idCounter = 0;

  const scheduleRemoval = (id: string) => {
    const timeoutId = window.setTimeout(() => dismissDownload(id), TOAST_EXIT_MS);
    timeoutIds.set(id, timeoutId);

    setDownloads((current) =>
      current.map((d) => (d.id === id ? { ...d, leaving: true } : d)),
    );
  };

  const dismissDownload = (id: string) => {
    setDownloads((current) => {
      const item = current.find((d) => d.id === id);
      if (item) downloadMap.delete(item.savePath);
      return current.filter((d) => d.id !== id);
    });
  };

  const scheduleDoneRemoval = (id: string) => {
    // Keep the "completed" toast visible for a few seconds
    const tid = window.setTimeout(() => scheduleRemoval(id), TOAST_DONE_DURATION_MS);
    timeoutIds.set(id, tid);
  };

  onMount(() => {
    const cleanupStarted = window.vessel.downloads.onStarted((info) => {
      const id = `dl-${++idCounter}`;
      const item: DownloadItem = {
        id,
        savePath: info.savePath,
        filename: info.filename,
        totalBytes: info.totalBytes,
        receivedBytes: info.receivedBytes,
        state: "progressing",
        leaving: false,
      };
      downloadMap.set(info.savePath, item);
      setDownloads((current) => [...current.slice(-4), item]);
    });

    const cleanupProgress = window.vessel.downloads.onProgress((info) => {
      const item = downloadMap.get(info.savePath);
      if (!item) return;
      item.receivedBytes = info.receivedBytes;
      item.totalBytes = info.totalBytes;
      setDownloads((current) =>
        current.map((d) =>
          d.id === item.id
            ? { ...d, receivedBytes: info.receivedBytes, totalBytes: info.totalBytes }
            : d,
        ),
      );
    });

    const cleanupDone = window.vessel.downloads.onDone((info) => {
      const item = downloadMap.get(info.savePath);
      if (!item) return;
      const finalState = info.state === "completed" ? "completed" : info.state === "cancelled" ? "cancelled" : "interrupted";
      item.state = finalState;
      setDownloads((current) =>
        current.map((d) =>
          d.id === item.id ? { ...d, state: finalState, receivedBytes: info.receivedBytes } : d,
        ),
      );
      scheduleDoneRemoval(item.id);
    });

    onCleanup(() => {
      cleanupStarted();
      cleanupProgress();
      cleanupDone();
      for (const tid of timeoutIds.values()) {
        window.clearTimeout(tid);
      }
      timeoutIds.clear();
    });
  });

  const progressPercent = (d: DownloadItem) => {
    if (d.totalBytes <= 0) return 0;
    return Math.min(100, Math.round((d.receivedBytes / d.totalBytes) * 100));
  };

  return (
    <div class="download-toast-stack" aria-live="polite">
      <For each={downloads()}>
        {(dl) => (
          <div
            class="download-toast"
            classList={{ "download-toast-leaving": dl.leaving }}
            role="status"
          >
            <div class="download-toast-header">
              <span class="download-toast-filename">{dl.filename}</span>
              <Show when={dl.state === "completed"}>
                <span class="download-toast-done">&#10003;</span>
              </Show>
              <Show when={dl.state === "cancelled" || dl.state === "interrupted"}>
                <span class="download-toast-failed">!</span>
              </Show>
            </div>
            <Show when={dl.state === "progressing"}>
              <div class="download-toast-bar-track">
                <div
                  class="download-toast-bar-fill"
                  style={{ width: `${progressPercent(dl)}%` }}
                />
              </div>
              <div class="download-toast-size">
                {formatBytes(dl.receivedBytes)}
                <Show when={dl.totalBytes > 0}>
                  {" / "}
                  {formatBytes(dl.totalBytes)}
                </Show>
              </div>
            </Show>
            <Show when={dl.state === "completed"}>
              <div class="download-toast-size download-toast-size-done">
                {formatBytes(dl.receivedBytes)} downloaded
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
};

export default DownloadToast;
