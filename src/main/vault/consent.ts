import { dialog, BrowserWindow } from "electron";

export interface ConsentRequest {
  credentialLabel: string;
  username: string;
  domain: string;
}

export interface ConsentResult {
  approved: boolean;
  trustForSession: boolean;
}

// Domains trusted for the current session (cleared on app restart)
const sessionTrustedDomains = new Set<string>();

export function isDomainTrustedForSession(domain: string): boolean {
  return sessionTrustedDomains.has(domain.toLowerCase());
}

/**
 * Show a consent dialog before the agent uses stored credentials.
 * Returns whether the user approved, and whether to trust this domain for the session.
 */
export async function requestConsent(
  request: ConsentRequest,
): Promise<ConsentResult> {
  const domain = request.domain.toLowerCase();

  // Skip dialog if domain is trusted for this session
  if (sessionTrustedDomains.has(domain)) {
    return { approved: true, trustForSession: true };
  }

  const focusedWindow = BrowserWindow.getFocusedWindow();

  const { response } = await dialog.showMessageBox(
    focusedWindow ?? (BrowserWindow.getAllWindows()[0] || null)!,
    {
      type: "question",
      title: "Agent Credential Access",
      message: `Agent wants to sign in to ${request.domain}`,
      detail: [
        `Credential: ${request.credentialLabel}`,
        `Username: ${request.username}`,
        "",
        "The agent is requesting to fill a login form with stored credentials.",
        "Credential values will NOT be sent to the AI provider.",
      ].join("\n"),
      buttons: ["Deny", "Allow Once", "Allow for Session"],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    },
  );

  if (response === 0) {
    return { approved: false, trustForSession: false };
  }

  const trustForSession = response === 2;
  if (trustForSession) {
    sessionTrustedDomains.add(domain);
  }

  return { approved: true, trustForSession };
}
