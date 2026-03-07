import Store from 'electron-store';
import type { VesselSettings } from '../../shared/types';

const defaults: VesselSettings = {
  apiKey: '',
  defaultUrl: 'https://start.duckduckgo.com',
  theme: 'dark',
};

let store: Store<VesselSettings>;

export function getStore(): Store<VesselSettings> {
  if (!store) {
    store = new Store<VesselSettings>({ defaults });
  }
  return store;
}

export function loadSettings(): VesselSettings {
  const s = getStore();
  return {
    apiKey: s.get('apiKey'),
    defaultUrl: s.get('defaultUrl'),
    theme: s.get('theme'),
  };
}

export function setSetting<K extends keyof VesselSettings>(
  key: K,
  value: VesselSettings[K],
): void {
  getStore().set(key, value);
}
