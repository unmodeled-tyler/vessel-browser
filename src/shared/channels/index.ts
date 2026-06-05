import { AIChannels } from "./ai-channels";
import { AutofillChannels } from "./autofill-channels";
import { AutomationChannels } from "./automation-channels";
import { BookmarkChannels } from "./bookmark-channels";
import { BrowsingDataChannels } from "./browsing-data-channels";
import { CodexChannels } from "./codex-channels";
import { ContentChannels } from "./content-channels";
import { DevToolsChannels } from "./devtools-channels";
import { DownloadChannels } from "./download-channels";
import { HighlightChannels } from "./highlight-channels";
import { HistoryChannels } from "./history-channels";
import { HumanVaultChannels } from "./human-vault-channels";
import { OpenRouterChannels } from "./openrouter-channels";
import { PermissionChannels } from "./permission-channels";
import { PremiumChannels } from "./premium-channels";
import { ResearchChannels } from "./research-channels";
import { SecurityChannels } from "./security-channels";
import { SessionChannels } from "./session-channels";
import { SettingsChannels } from "./settings-channels";
import { TabChannels } from "./tab-channels";
import { UIChannels } from "./ui-channels";
import { UpdateChannels } from "./update-channels";
import { VaultChannels } from "./vault-channels";
import { WindowControlChannels } from "./window-control-channels";

/**
 * All IPC channel names used between main and renderer processes.
 *
 * Organized by domain to improve discoverability and prevent naming collisions.
 * The flat `Channels` export is kept for backward compatibility.
 */
export const Channels = {
  ...AIChannels,
  ...AutofillChannels,
  ...AutomationChannels,
  ...BookmarkChannels,
  ...BrowsingDataChannels,
  ...CodexChannels,
  ...ContentChannels,
  ...DevToolsChannels,
  ...DownloadChannels,
  ...HighlightChannels,
  ...HistoryChannels,
  ...HumanVaultChannels,
  ...OpenRouterChannels,
  ...PermissionChannels,
  ...PremiumChannels,
  ...ResearchChannels,
  ...SecurityChannels,
  ...SessionChannels,
  ...SettingsChannels,
  ...TabChannels,
  ...UIChannels,
  ...UpdateChannels,
  ...VaultChannels,
  ...WindowControlChannels,
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

export {
  AIChannels,
  AutofillChannels,
  AutomationChannels,
  BookmarkChannels,
  BrowsingDataChannels,
  CodexChannels,
  ContentChannels,
  DevToolsChannels,
  DownloadChannels,
  HighlightChannels,
  HistoryChannels,
  HumanVaultChannels,
  OpenRouterChannels,
  PermissionChannels,
  PremiumChannels,
  ResearchChannels,
  SecurityChannels,
  SessionChannels,
  SettingsChannels,
  TabChannels,
  UIChannels,
  UpdateChannels,
  VaultChannels,
  WindowControlChannels,
};
