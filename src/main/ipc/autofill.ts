import { ipcMain } from "electron";
import type { AutofillProfile } from "../../shared/autofill-types";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import { fillFormFields } from "../ai/page-actions";
import * as autofillManager from "../autofill/manager";
import { matchFields } from "../autofill/matcher";
import type { WindowState } from "../window";
import { assertString, assertTrustedIpcSender } from "./common";

const AUTOFILL_PROFILE_FIELDS = [
  "label",
  "firstName",
  "lastName",
  "email",
  "phone",
  "organization",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
] as const;

type EditableAutofillProfile = Omit<
  AutofillProfile,
  "id" | "createdAt" | "updatedAt"
>;

function sanitizeAutofillProfile(value: unknown): EditableAutofillProfile {
  if (!value || typeof value !== "object") throw new Error("Invalid profile");
  const raw = value as Record<string, unknown>;
  const profile = {} as EditableAutofillProfile;
  for (const field of AUTOFILL_PROFILE_FIELDS) {
    assertString(raw[field], field);
    profile[field] = raw[field] as never;
  }
  if (!profile.label.trim()) throw new Error("Label is required");
  return profile;
}

function sanitizeAutofillUpdates(
  value: unknown,
): Partial<EditableAutofillProfile> {
  if (!value || typeof value !== "object") throw new Error("Invalid updates");
  const raw = value as Record<string, unknown>;
  const updates: Partial<EditableAutofillProfile> = {};
  for (const field of AUTOFILL_PROFILE_FIELDS) {
    if (!(field in raw)) continue;
    assertString(raw[field], field);
    updates[field] = raw[field] as never;
  }
  if ("label" in updates && !updates.label?.trim()) {
    throw new Error("Label is required");
  }
  return updates;
}

export function registerAutofillHandlers(windowState: WindowState): void {
  ipcMain.handle(Channels.AUTOFILL_LIST, (event) => {
    assertTrustedIpcSender(event);
    return autofillManager.listProfiles();
  });

  ipcMain.handle(
    Channels.AUTOFILL_ADD,
    (event, profile: Omit<AutofillProfile, "id" | "createdAt" | "updatedAt">) => {
      assertTrustedIpcSender(event);
      return autofillManager.addProfile(sanitizeAutofillProfile(profile));
    },
  );

  ipcMain.handle(Channels.AUTOFILL_UPDATE, (event, id: unknown, updates: unknown) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    return autofillManager.updateProfile(id, sanitizeAutofillUpdates(updates));
  });

  ipcMain.handle(Channels.AUTOFILL_DELETE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    assertString(id, "id");
    return autofillManager.deleteProfile(id);
  });

  ipcMain.handle(Channels.AUTOFILL_FILL, async (event, profileId: unknown) => {
    assertTrustedIpcSender(event);
    assertString(profileId, "profileId");
    const profile = autofillManager.getProfile(profileId);
    if (!profile) throw new Error("Profile not found");
    const activeTab = windowState.tabManager.getActiveTab();
    const wc = activeTab?.view.webContents;
    if (!wc) throw new Error("No active tab");
    const content = await extractContent(wc);
    const elements = content.interactiveElements || [];
    const matches = matchFields(elements, profile);
    if (matches.length === 0) {
      return { filled: 0, skipped: 0, details: [] };
    }

    const fields = matches.map((match) => ({
      index: match.fieldIndex,
      selector: match.selector,
      value: match.value,
    }));
    const results = await fillFormFields(wc, fields);
    const filled = results.filter(
      (result) =>
        result.result.startsWith("Typed into:") ||
        result.result.startsWith("Selected:"),
    ).length;

    return {
      filled,
      skipped: results.length - filled,
      details: results.map((result, index) => ({
        label:
          elements.find((element) => element.index === matches[index]?.fieldIndex)
            ?.label || `Field ${index + 1}`,
        value: matches[index]?.value || "",
        matchedBy: matches[index]?.matchedBy || "unknown",
        result: result.result,
      })),
    };
  });
}
