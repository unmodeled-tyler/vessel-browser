/// <reference types="vite/client" />

import type { VesselAPI } from '../../preload/index';

declare global {
  interface Window {
    vessel: VesselAPI;
  }
}
