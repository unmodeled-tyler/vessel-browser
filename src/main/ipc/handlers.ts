import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { createProvider } from "../ai/provider";
import { type WindowState } from "../window";
import {
  assertTrustedIpcSender,
  registerTrustedIpcSender,
  createWindowStateMessenger,
  type SendToRendererViews,
} from "./common";
import type { AgentRuntime } from "../agent/runtime";
import { ResearchOrchestrator } from "../agent/research/orchestrator";

import { registerTabHandlers } from "./tabs";
import { registerAIHandlers } from "./ai";
import { registerContentHandlers } from "./content";
import { registerHighlightHandlers } from "./highlights";
import { registerAgentRuntimeHandlers } from "./agent-runtime";
import { registerSettingsHandlers } from "./settings";
import { registerSystemHandlers } from "./system";
import { registerBookmarkHandlers } from "./bookmarks";
import { registerHistoryHandlers } from "./history";
import { registerPremiumHandlers } from "./premium";
import { registerSessionHandlers } from "./sessions";
import { registerSecurityHandlers } from "./security";
import { registerCodexHandlers } from "./codex";
import { registerOpenRouterHandlers } from "./openrouter";
import { registerSidebarHandlers } from "./sidebar";
import { registerVaultHandlers } from "./vault";
import { registerHumanVaultHandlers } from "./human-vault";
import { registerWindowControlHandlers } from "./window-controls";
import { registerAutofillHandlers } from "./autofill";
import { registerPageDiffHandlers } from "./page-diff";
import { registerResearchHandlers } from "./research";
import { registerScheduleHandlers } from "../automation/scheduler";

export { togglePictureInPicture } from "./picture-in-picture";

export function registerIpcHandlers(
  windowState: WindowState,
  runtime: AgentRuntime,
): void {
  const { tabManager, chromeView, sidebarView, devtoolsPanelView, mainWindow } = windowState;
  registerTrustedIpcSender(chromeView.webContents);
  registerTrustedIpcSender(sidebarView.webContents);
  registerTrustedIpcSender(devtoolsPanelView.webContents);

  const sendToRendererViews: SendToRendererViews = createWindowStateMessenger(
    chromeView,
    sidebarView,
    devtoolsPanelView,
  );

  // --- Research Desk orchestrator (shared by AI and settings) ---
  let researchOrchestrator: ResearchOrchestrator | null = null;

  const getResearchOrchestrator = (): ResearchOrchestrator => {
    if (!researchOrchestrator) {
      const settings = loadSettings();
      const provider = settings.chatProvider
        ? createProvider(settings.chatProvider)
        : null;
      researchOrchestrator = new ResearchOrchestrator(provider, tabManager, runtime);
      researchOrchestrator.setUpdateListener((state) => {
        sendToRendererViews(Channels.RESEARCH_STATE_UPDATE, state);
      });
    }
    return researchOrchestrator;
  };
  const getExistingResearchOrchestrator = (): ResearchOrchestrator | null =>
    researchOrchestrator;

  // --- Domain-specific IPC handlers ---
  registerTabHandlers(windowState, sendToRendererViews);
  registerAIHandlers(tabManager, runtime, sendToRendererViews, getResearchOrchestrator);
  registerContentHandlers(windowState);
  registerHighlightHandlers(windowState, sendToRendererViews);
  registerAgentRuntimeHandlers(
    runtime,
    chromeView.webContents,
    sidebarView.webContents,
    sendToRendererViews,
  );

  const applySettingChange = registerSettingsHandlers(
    tabManager,
    runtime,
    sendToRendererViews,
    getExistingResearchOrchestrator,
  );

  registerBookmarkHandlers();
  registerHistoryHandlers();
  registerPremiumHandlers(tabManager, sendToRendererViews);
  registerSessionHandlers(tabManager);
  registerSecurityHandlers(tabManager);
  registerCodexHandlers();
  registerOpenRouterHandlers(applySettingChange);
  registerSidebarHandlers(windowState, (event) => assertTrustedIpcSender(event));
  registerVaultHandlers();
  registerHumanVaultHandlers();
  registerWindowControlHandlers(mainWindow);
  registerAutofillHandlers(windowState);
  registerPageDiffHandlers(windowState, sendToRendererViews);
  registerResearchHandlers(() => getResearchOrchestrator());
  registerScheduleHandlers(windowState, runtime, sendToRendererViews);
  registerSystemHandlers(windowState, sendToRendererViews);
}
