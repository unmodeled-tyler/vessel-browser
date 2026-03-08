import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";
import type {
  AgentCheckpoint,
  AgentRuntimeState,
  ApprovalMode,
  ProviderConfig,
  ProviderModelsResult,
  ProviderMeta,
  ProviderId,
  ProviderUpdateResult,
  SessionSnapshot,
} from "../shared/types";

const api = {
  tabs: {
    create: (url?: string) => ipcRenderer.invoke(Channels.TAB_CREATE, url),
    close: (id: string) => ipcRenderer.invoke(Channels.TAB_CLOSE, id),
    switch: (id: string) => ipcRenderer.invoke(Channels.TAB_SWITCH, id),
    navigate: (id: string, url: string) =>
      ipcRenderer.invoke(Channels.TAB_NAVIGATE, id, url),
    back: (id: string) => ipcRenderer.invoke(Channels.TAB_BACK, id),
    forward: (id: string) => ipcRenderer.invoke(Channels.TAB_FORWARD, id),
    reload: (id: string) => ipcRenderer.invoke(Channels.TAB_RELOAD, id),
    onStateUpdate: (
      cb: (tabs: any[], activeId: string) => void,
    ): (() => void) => {
      const handler = (_: any, tabs: any[], activeId: string) =>
        cb(tabs, activeId);
      ipcRenderer.on(Channels.TAB_STATE_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.TAB_STATE_UPDATE, handler);
    },
  },
  ai: {
    query: (prompt: string) => ipcRenderer.invoke(Channels.AI_QUERY, prompt),
    onStreamStart: (cb: (prompt: string) => void): (() => void) => {
      const handler = (_: any, prompt: string) => cb(prompt);
      ipcRenderer.on(Channels.AI_STREAM_START, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_START, handler);
    },
    onStreamChunk: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: any, chunk: string) => cb(chunk);
      ipcRenderer.on(Channels.AI_STREAM_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_CHUNK, handler);
    },
    onStreamEnd: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_END, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_END, handler);
    },
    cancel: () => ipcRenderer.invoke(Channels.AI_CANCEL),
    getRuntime: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_RUNTIME_GET),
    onRuntimeUpdate: (cb: (state: AgentRuntimeState) => void): (() => void) => {
      const handler = (_: any, state: AgentRuntimeState) => cb(state);
      ipcRenderer.on(Channels.AGENT_RUNTIME_UPDATE, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AGENT_RUNTIME_UPDATE, handler);
    },
    pause: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_PAUSE),
    resume: (): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_RESUME),
    setApprovalMode: (mode: ApprovalMode): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_SET_APPROVAL_MODE, mode),
    resolveApproval: (
      approvalId: string,
      approved: boolean,
    ): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_APPROVAL_RESOLVE, approvalId, approved),
    createCheckpoint: (
      name?: string,
      note?: string,
    ): Promise<AgentCheckpoint> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_CREATE, name, note),
    restoreCheckpoint: (
      checkpointId: string,
    ): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_RESTORE, checkpointId),
    captureSession: (note?: string): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_CAPTURE, note),
    restoreSession: (
      snapshot?: SessionSnapshot | null,
    ): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_RESTORE, snapshot),
  },
  content: {
    extract: () => ipcRenderer.invoke(Channels.CONTENT_EXTRACT),
    toggleReader: () => ipcRenderer.invoke(Channels.READER_MODE_TOGGLE),
  },
  ui: {
    toggleSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_TOGGLE),
    resizeSidebar: (width: number) =>
      ipcRenderer.invoke(Channels.SIDEBAR_RESIZE, width),
    toggleFocusMode: () => ipcRenderer.invoke(Channels.FOCUS_MODE_TOGGLE),
    setSettingsVisibility: (open: boolean) =>
      ipcRenderer.invoke(Channels.SETTINGS_VISIBILITY, open),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
    set: (key: string, value: any) =>
      ipcRenderer.invoke(Channels.SETTINGS_SET, key, value),
  },
  provider: {
    list: (): Promise<Record<ProviderId, ProviderMeta>> =>
      ipcRenderer.invoke(Channels.PROVIDER_LIST),
    update: (config: ProviderConfig): Promise<ProviderUpdateResult> =>
      ipcRenderer.invoke(Channels.PROVIDER_UPDATE, config),
    fetchModels: (config: ProviderConfig): Promise<ProviderModelsResult> =>
      ipcRenderer.invoke(Channels.PROVIDER_FETCH_MODELS, config),
  },
  window: {
    minimize: () => ipcRenderer.invoke(Channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(Channels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(Channels.WINDOW_CLOSE),
  },
};

contextBridge.exposeInMainWorld("vessel", api);

export type VesselAPI = typeof api;
