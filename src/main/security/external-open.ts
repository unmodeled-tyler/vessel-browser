import { shell } from "electron";

type ExternalOpenRule = {
  schemes?: string[];
  hosts?: string[];
};

export async function openExternalAllowlisted(
  url: string,
  rule: ExternalOpenRule,
): Promise<void> {
  const parsed = new URL(url);
  const schemes = rule.schemes ?? ["https:"];
  if (!schemes.includes(parsed.protocol)) {
    throw new Error(`Blocked external URL scheme: ${parsed.protocol}`);
  }
  if (rule.hosts && !rule.hosts.includes(parsed.hostname)) {
    throw new Error(`Blocked external URL host: ${parsed.hostname}`);
  }
  await shell.openExternal(parsed.toString());
}
