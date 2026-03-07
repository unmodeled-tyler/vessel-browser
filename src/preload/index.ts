import { contextBridge, ipcRenderer } from 'electron';
import { Channels } from '../shared/channels';

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
    onStreamChunk: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: any, chunk: string) => cb(chunk);
      ipcRenderer.on(Channels.AI_STREAM_CHUNK, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_CHUNK, handler);
    },
    onStreamEnd: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_END, handler);
      return () =>
        ipcRenderer.removeListener(Channels.AI_STREAM_END, handler);
    },
    cancel: () => ipcRenderer.invoke(Channels.AI_CANCEL),
  },
  content: {
    extract: () => ipcRenderer.invoke(Channels.CONTENT_EXTRACT),
    toggleReader: () => ipcRenderer.invoke(Channels.READER_MODE_TOGGLE),
  },
  ui: {
    toggleSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_TOGGLE),
    toggleFocusMode: () => ipcRenderer.invoke(Channels.FOCUS_MODE_TOGGLE),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
    set: (key: string, value: any) =>
      ipcRenderer.invoke(Channels.SETTINGS_SET, key, value),
  },
  window: {
    minimize: () => ipcRenderer.invoke(Channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(Channels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(Channels.WINDOW_CLOSE),
  },
};

contextBridge.exposeInMainWorld('vessel', api);

export type VesselAPI = typeof api;
