import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import {
  BUNDLED_KIT_IDS,
  isSafeAutomationKitId,
  VALID_KIT_CATEGORIES,
} from "../../shared/automation-kit-constants";
import type { AutomationKit, KitCategory } from "../../shared/types";

function getUserKitsDir(): string {
  return path.join(app.getPath("userData"), "kits");
}

function ensureKitsDir(): void {
  const dir = getUserKitsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getKitFilePath(id: string): string | null {
  if (!isSafeAutomationKitId(id)) return null;

  const kitsDir = path.resolve(getUserKitsDir());
  const target = path.resolve(kitsDir, `${id}.kit.json`);
  return target.startsWith(`${kitsDir}${path.sep}`) ? target : null;
}

function isValidKit(value: unknown): value is AutomationKit {
  if (!value || typeof value !== "object") return false;
  const k = value as Record<string, unknown>;
  return (
    typeof k.id === "string" && isSafeAutomationKitId(k.id) &&
    typeof k.name === "string" && k.name.length > 0 &&
    typeof k.description === "string" &&
    typeof k.category === "string" && VALID_KIT_CATEGORIES.has(k.category as KitCategory) &&
    typeof k.icon === "string" &&
    typeof k.promptTemplate === "string" && k.promptTemplate.length > 0 &&
    Array.isArray(k.inputs)
  );
}

export function getInstalledKits(): AutomationKit[] {
  ensureKitsDir();
  const dir = getUserKitsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".kit.json"));
  } catch {
    return [];
  }

  const kits: AutomationKit[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isValidKit(parsed)) {
        kits.push(parsed);
      } else {
        console.warn(`[kit-registry] Skipping invalid kit file: ${file}`);
      }
    } catch {
      console.warn(`[kit-registry] Failed to read kit file: ${file}`);
    }
  }
  return kits;
}

export async function installKitFromFile(): Promise<{
  ok: boolean;
  kit?: AutomationKit;
  error?: string;
}> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Install Automation Kit",
    filters: [{ name: "Automation Kit", extensions: ["kit.json", "json"] }],
    properties: ["openFile"],
  });

  if (canceled || filePaths.length === 0) {
    return { ok: false, error: "canceled" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePaths[0], "utf-8");
  } catch {
    return { ok: false, error: "Could not read the selected file." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }

  if (!isValidKit(parsed)) {
    return {
      ok: false,
      error:
        "File is not a valid automation kit. Required fields: id, name, description, icon, inputs, promptTemplate.",
    };
  }

  if (BUNDLED_KIT_IDS.has(parsed.id)) {
    return {
      ok: false,
      error: `Kit id "${parsed.id}" conflicts with a built-in kit and cannot be overwritten.`,
    };
  }

  ensureKitsDir();
  const dest = getKitFilePath(parsed.id);
  if (!dest) {
    return { ok: false, error: "Kit id contains unsupported characters." };
  }
  try {
    fs.writeFileSync(dest, JSON.stringify(parsed, null, 2), "utf-8");
  } catch {
    return { ok: false, error: "Failed to save the kit file." };
  }

  return { ok: true, kit: parsed };
}

export function uninstallKit(
  id: string,
  scheduledKitIds?: ReadonlySet<string>,
): { ok: boolean; error?: string } {
  if (BUNDLED_KIT_IDS.has(id)) {
    return { ok: false, error: "Built-in kits cannot be removed." };
  }

  if (scheduledKitIds?.has(id)) {
    return {
      ok: false,
      error:
        "This kit has active scheduled jobs. Delete or reassign them first.",
    };
  }

  ensureKitsDir();
  const target = getKitFilePath(id);
  if (!target) {
    return { ok: false, error: "Kit id contains unsupported characters." };
  }
  if (!fs.existsSync(target)) {
    return { ok: false, error: "Kit not found." };
  }

  try {
    fs.unlinkSync(target);
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to remove the kit file." };
  }
}
