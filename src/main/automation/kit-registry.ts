import fs from "node:fs";
import path from "node:path";
import { app, dialog } from "electron";
import {
  BUNDLED_KIT_IDS,
  isSafeAutomationKitId,
  VALID_KIT_CATEGORIES,
} from "../../shared/automation-kit-constants";
import type { AutomationKit, KitCategory } from "../../shared/types";
import { createLogger } from "../../shared/logger";
import { errorResult, okResult, type Result } from "../../shared/result";

const logger = createLogger("KitRegistry");

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
        logger.warn(`Skipping invalid kit file: ${file}`);
      }
    } catch (err) {
      logger.warn(`Failed to read kit file: ${file}`, err);
    }
  }
  return kits;
}

export async function installKitFromFile(): Promise<Result<{ kit: AutomationKit }>> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Install Automation Kit",
    filters: [{ name: "Automation Kit", extensions: ["kit.json", "json"] }],
    properties: ["openFile"],
  });

  if (canceled || filePaths.length === 0) {
    return errorResult("canceled");
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePaths[0], "utf-8");
  } catch {
    return errorResult("Could not read the selected file.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResult("File is not valid JSON.");
  }

  if (!isValidKit(parsed)) {
    return errorResult(
      "File is not a valid automation kit. Required fields: id, name, description, icon, inputs, promptTemplate.",
    );
  }

  if (BUNDLED_KIT_IDS.has(parsed.id)) {
    return errorResult(
      `Kit id "${parsed.id}" conflicts with a built-in kit and cannot be overwritten.`,
    );
  }

  ensureKitsDir();
  const dest = getKitFilePath(parsed.id);
  if (!dest) {
    return errorResult("Kit id contains unsupported characters.");
  }
  try {
    fs.writeFileSync(dest, JSON.stringify(parsed, null, 2), "utf-8");
  } catch {
    return errorResult("Failed to save the kit file.");
  }

  return okResult({ kit: parsed });
}

export function uninstallKit(
  id: string,
  scheduledKitIds?: ReadonlySet<string>,
): Result {
  if (BUNDLED_KIT_IDS.has(id)) {
    return errorResult("Built-in kits cannot be removed.");
  }

  if (scheduledKitIds?.has(id)) {
    return errorResult(
      "This kit has active scheduled jobs. Delete or reassign them first.",
    );
  }

  ensureKitsDir();
  const target = getKitFilePath(id);
  if (!target) {
    return errorResult("Kit id contains unsupported characters.");
  }
  if (!fs.existsSync(target)) {
    return errorResult("Kit not found.");
  }

  try {
    fs.unlinkSync(target);
    return okResult();
  } catch {
    return errorResult("Failed to remove the kit file.");
  }
}
