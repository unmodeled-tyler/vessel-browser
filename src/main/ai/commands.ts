import type { AIProvider } from "./provider";
import {
  buildSummarizePrompt,
  buildQuestionPrompt,
  buildGeneralPrompt,
} from "./context-builder";
import { extractContent } from "../content/extractor";
import type { WebContents } from "electron";

function shouldUsePageContext(query: string): boolean {
  const pageSpecificPatterns = [
    /\bthis (page|article|site|post|tab|thread|document)\b/,
    /\b(current|open) (page|article|site|tab)\b/,
    /\b(on|from|in|about) this\b/,
    /\baccording to (this|the) (page|article|site)\b/,
    /\bwhat('?s| is) this\b/,
    /\bwhat('?s| is) this about\b/,
    /\bwhat does (this|the) (page|article|site) say\b/,
    /\bwho wrote this\b/,
    /\b(reader|reading) mode\b/,
    /\b(key points|takeaways|main point|main points)\b/,
  ];

  return pageSpecificPatterns.some((pattern) => pattern.test(query));
}

export async function handleAIQuery(
  query: string,
  provider: AIProvider,
  activeWebContents: WebContents | undefined,
  onChunk: (text: string) => void,
  onEnd: () => void,
): Promise<void> {
  const lowerQuery = query.toLowerCase().trim();

  const isSummarize =
    lowerQuery.startsWith("summarize") ||
    lowerQuery.startsWith("tldr") ||
    lowerQuery === "summary";

  const needsPageContext = isSummarize || shouldUsePageContext(lowerQuery);

  let prompt: { system: string; user: string };

  if (needsPageContext && activeWebContents) {
    try {
      const pageContent = await extractContent(activeWebContents);

      if (isSummarize) {
        prompt = buildSummarizePrompt(pageContent);
      } else {
        prompt = buildQuestionPrompt(pageContent, query);
      }
    } catch {
      prompt = buildGeneralPrompt(query);
    }
  } else {
    prompt = buildGeneralPrompt(query);
  }

  await provider.streamQuery(prompt.system, prompt.user, onChunk, onEnd);
}
