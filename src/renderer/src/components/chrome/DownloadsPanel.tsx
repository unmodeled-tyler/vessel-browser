import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import type { DownloadRecord } from "../../../../shared/types";
import "./chrome.css";

const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const DownloadsPanel: Component<{ open: boolean; onClose: () => void }> = (props) => {
  const [items, setItems] = createSignal<DownloadRecord[]>([]);

  const load = async () => setItems(await window.vessel.downloads.getAll());

  onMount(() => {
    void load();
    const off = window.vessel.downloads.onUpdate(setItems);
    onCleanup(off);
  });

  return (
    <Show when={props.open}>
      <div class="modal-backdrop" onClick={props.onClose}>
        <div class="downloads-panel" onClick={(e) => e.stopPropagation()}>
          <div class="downloads-panel-header">
            <div>
              <h2>Downloads</h2>
              <p>Recent files saved by Vessel</p>
            </div>
            <div class="downloads-panel-actions">
              <button onClick={async () => { await window.vessel.downloads.clear(); await load(); }}>Clear</button>
              <button onClick={props.onClose}>Close</button>
            </div>
          </div>
          <div class="downloads-panel-list">
            <For each={items()} fallback={<div class="downloads-empty">No downloads yet.</div>}>
              {(item) => (
                <div class="downloads-row">
                  <div class="downloads-file">
                    <strong>{item.filename}</strong>
                    <span>{item.savePath}</span>
                    <Show when={item.url}>
                      {(url) => <span>Source: {url()}</span>}
                    </Show>
                    <small>{item.state} · {formatBytes(item.receivedBytes)}{item.totalBytes ? ` / ${formatBytes(item.totalBytes)}` : ""}</small>
                  </div>
                  <div class="downloads-row-actions">
                    <button disabled={item.state !== "completed"} onClick={() => window.vessel.downloads.open(item.id)}>Open</button>
                    <button onClick={() => window.vessel.downloads.showInFolder(item.id)}>Show in folder</button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default DownloadsPanel;
