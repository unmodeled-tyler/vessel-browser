import { ipcMain } from "electron";
import { z } from "zod";
import type { AutofillProfile } from "../../shared/autofill-types";
import { Channels } from "../../shared/channels";
import { extractContent } from "../content/extractor";
import { fillFormFields } from "../ai/page-actions";
import * as autofillManager from "../autofill/manager";
import { matchFields } from "../autofill/matcher";
import type { WindowState } from "../window";
import { assertTrustedIpcSender, parseIpc } from "./common";

const IdSchema = z.string().min(1);

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

const AutofillProfileSchema = z.object(
  Object.fromEntries(AUTOFILL_PROFILE_FIELDS.map((field) => [field, z.string()]))
).refine((data) => data.label.trim().length > 0, { message: "Label is required" });

const AutofillUpdateSchema = z.object(
  Object.fromEntries(AUTOFILL_PROFILE_FIELDS.map((field) => [field, z.string().optional()]))
).refine(
  (data) => data.label === undefined || data.label.trim().length > 0,
  { message: "Label is required" }
);

export function registerAutofillHandlers(windowState: WindowState): void {
  ipcMain.handle(Channels.AUTOFILL_LIST, (event) => {
    assertTrustedIpcSender(event);
    return autofillManager.listProfiles();
  });

  ipcMain.handle(
    Channels.AUTOFILL_ADD,
    (event, profile: unknown) => {
      assertTrustedIpcSender(event);
      const validated = parseIpc(AutofillProfileSchema, profile, "profile");
      return autofillManager.addProfile(validated as EditableAutofillProfile);
    },
  );

  ipcMain.handle(Channels.AUTOFILL_UPDATE, (event, id: unknown, updates: unknown) => {
    assertTrustedIpcSender(event);
    const validatedId = parseIpc(IdSchema, id, "id");
    const validatedUpdates = parseIpc(AutofillUpdateSchema, updates ?? {}, "updates");
    return autofillManager.updateProfile(validatedId, validatedUpdates as Partial<EditableAutofillProfile>);
  });

  ipcMain.handle(Channels.AUTOFILL_DELETE, (event, id: unknown) => {
    assertTrustedIpcSender(event);
    const validatedId = parseIpc(IdSchema, id, "id");
    return autofillManager.deleteProfile(validatedId);
  });

  ipcMain.handle(Channels.AUTOFILL_FILL, async (event, profileId: unknown) => {
    assertTrustedIpcSender(event);
    const validatedProfileId = parseIpc(IdSchema, profileId, "profileId");
    const profile = autofillManager.getProfile(validatedProfileId);
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
