import assert from "node:assert/strict";
import test from "node:test";

import {
  AIChannels,
  AutofillChannels,
  AutomationChannels,
  BookmarkChannels,
  BrowsingDataChannels,
  Channels,
  CodexChannels,
  ContentChannels,
  DevToolsChannels,
  DownloadChannels,
  HighlightChannels,
  HistoryChannels,
  HumanVaultChannels,
  McpChannels,
  OpenRouterChannels,
  PermissionChannels,
  PremiumChannels,
  ResearchChannels,
  SecurityChannels,
  SessionChannels,
  SettingsChannels,
  SupportChannels,
  TabChannels,
  UIChannels,
  UpdateChannels,
  VaultChannels,
  WindowControlChannels,
} from "../src/shared/channels";

const channelDomains = [
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
  McpChannels,
  OpenRouterChannels,
  PermissionChannels,
  PremiumChannels,
  ResearchChannels,
  SecurityChannels,
  SessionChannels,
  SettingsChannels,
  SupportChannels,
  TabChannels,
  UIChannels,
  UpdateChannels,
  VaultChannels,
  WindowControlChannels,
] as const;

test("IPC channel values are unique across domain modules", () => {
  const ownersByValue = new Map<string, string[]>();

  for (const domain of channelDomains) {
    for (const [name, value] of Object.entries(domain)) {
      ownersByValue.set(value, [...(ownersByValue.get(value) ?? []), name]);
    }
  }

  const duplicates = [...ownersByValue.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([value, owners]) => `${value}: ${owners.join(", ")}`);

  assert.deepEqual(duplicates, []);
});

test("flat Channels export contains every domain channel", () => {
  const domainValues = channelDomains.flatMap((domain) => Object.values(domain));
  assert.deepEqual(new Set(Object.values(Channels)), new Set(domainValues));
});
