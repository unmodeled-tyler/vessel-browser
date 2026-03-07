export interface TabState {
  id: string;
  title: string;
  url: string;
  favicon: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isReaderMode: boolean;
}

export interface PageContent {
  title: string;
  content: string;
  htmlContent: string;
  byline: string;
  excerpt: string;
  url: string;
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  focusMode: boolean;
}

export interface VesselSettings {
  apiKey: string;
  defaultUrl: string;
  theme: 'dark';
  sidebarWidth: number;
}
