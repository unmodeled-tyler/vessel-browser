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
const { access, mkdir, readFile, readdir, unlink, writeFile } = fs.promises;

function getUserKitsDir(): string {
  return path.join(app.getPath("userData"), "kits");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureKitsDir(): Promise<void> {
  await mkdir(getUserKitsDir(), { recursive: true });
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

export async function getInstalledKits(): Promise<AutomationKit[]> {
  await ensureKitsDir();
  const dir = getUserKitsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".kit.json"));
  } catch (err) {
    logger.warn("Failed to read kit directory:", err);
    return [];
  }

  const kits: AutomationKit[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(dir, file), "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (isValidKit(parsed)) {
        kits.push(parsed);
      } else {
        logger.warn(`Skipping invalid skill file: ${file}`);
      }
    } catch (err) {
      logger.warn(`Failed to read skill file: ${file}`, err);
    }
  }
  return kits;
}

export async function installKitFromFile(): Promise<Result<{ kit: AutomationKit }>> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: "Import Skill",
    filters: [{ name: "Skills", extensions: ["skill.json", "json"] }],
    properties: ["openFile"],
  });

  if (canceled || filePaths.length === 0) {
    return errorResult("canceled");
  }

  let raw: string;
  try {
    raw = await readFile(filePaths[0], "utf-8");
  } catch (err) {
    logger.warn("Failed to read selected skill file:", err);
    return errorResult("Could not read the selected file.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn("Selected skill file is not valid JSON:", err);
    return errorResult("File is not valid JSON.");
  }

  if (!isValidKit(parsed)) {
    return errorResult(
      "File is not a valid skill. Required fields: id, name, description, icon, inputs, promptTemplate.",
    );
  }

  if (BUNDLED_KIT_IDS.has(parsed.id)) {
    return errorResult(
      `Skill id "${parsed.id}" conflicts with a built-in skill and cannot be overwritten.`,
    );
  }

  await ensureKitsDir();
  const dest = getKitFilePath(parsed.id);
  if (!dest) {
    return errorResult("Skill id contains unsupported characters.");
  }
  try {
    await writeFile(dest, JSON.stringify(parsed, null, 2), "utf-8");
  } catch (err) {
    logger.warn("Failed to save skill file:", err);
    return errorResult("Failed to save the skill file.");
  }

  return okResult({ kit: parsed });
}

export async function createKitFromText(
  source: string,
): Promise<Result<{ kit: AutomationKit }>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    logger.warn("Created skill text is not valid JSON:", err);
    return errorResult("Skill text is not valid JSON.");
  }

  if (!isValidKit(parsed)) {
    return errorResult(
      "Text is not a valid skill. Required fields: id, name, description, icon, inputs, promptTemplate.",
    );
  }

  if (BUNDLED_KIT_IDS.has(parsed.id)) {
    return errorResult(
      `Skill id "${parsed.id}" conflicts with a built-in skill and cannot be overwritten.`,
    );
  }

  await ensureKitsDir();
  const dest = getKitFilePath(parsed.id);
  if (!dest) {
    return errorResult("Skill id contains unsupported characters.");
  }

  try {
    await writeFile(dest, JSON.stringify(parsed, null, 2), "utf-8");
  } catch (err) {
    logger.warn("Failed to save created skill:", err);
    return errorResult("Failed to save the skill.");
  }

  return okResult({ kit: parsed });
}

export async function updateKitFromText(
  id: string,
  source: string,
): Promise<Result<{ kit: AutomationKit }>> {
  if (BUNDLED_KIT_IDS.has(id)) {
    return errorResult("Built-in skills cannot be edited.");
  }

  const target = getKitFilePath(id);
  if (!target) {
    return errorResult("Skill id contains unsupported characters.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    logger.warn("Updated skill text is not valid JSON:", err);
    return errorResult("Skill text is not valid JSON.");
  }

  if (!isValidKit(parsed)) {
    return errorResult(
      "Text is not a valid skill. Required fields: id, name, description, icon, inputs, promptTemplate.",
    );
  }

  if (parsed.id !== id) {
    return errorResult("Skill id cannot be changed while editing.");
  }

  await ensureKitsDir();
  if (!(await pathExists(target))) {
    return errorResult("Skill not found.");
  }

  try {
    await writeFile(target, JSON.stringify(parsed, null, 2), "utf-8");
  } catch (err) {
    logger.warn("Failed to update skill:", err);
    return errorResult("Failed to update the skill.");
  }

  return okResult({ kit: parsed });
}

export async function uninstallKit(
  id: string,
  scheduledKitIds?: ReadonlySet<string>,
): Promise<Result> {
  if (BUNDLED_KIT_IDS.has(id)) {
    return errorResult("Built-in skills cannot be removed.");
  }

  if (scheduledKitIds?.has(id)) {
    return errorResult(
      "This skill has active scheduled jobs. Delete or reassign them first.",
    );
  }

  await ensureKitsDir();
  const target = getKitFilePath(id);
  if (!target) {
    return errorResult("Skill id contains unsupported characters.");
  }
  if (!(await pathExists(target))) {
    return errorResult("Skill not found.");
  }

  try {
    await unlink(target);
    return okResult();
  } catch (err) {
    logger.warn("Failed to remove skill file:", err);
    return errorResult("Failed to remove the skill file.");
  }
}
