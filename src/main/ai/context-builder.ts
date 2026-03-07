import type { PageContent } from '../../shared/types';

const MAX_CONTENT_LENGTH = 60000; // ~15k tokens rough estimate

function truncateContent(content: string): string {
  if (content.length <= MAX_CONTENT_LENGTH) return content;
  return (
    content.slice(0, MAX_CONTENT_LENGTH) +
    '\n\n[Content truncated for length...]'
  );
}

export function buildSummarizePrompt(page: PageContent): {
  system: string;
  user: string;
} {
  return {
    system:
      'You are Vessel, an AI browsing assistant. Provide concise, well-structured summaries. Use bullet points for key takeaways. Be direct and informative.',
    user: `Summarize this web page:\n\nTitle: ${page.title}\nURL: ${page.url}\n\nContent:\n${truncateContent(page.content)}`,
  };
}

export function buildQuestionPrompt(
  page: PageContent,
  question: string,
): { system: string; user: string } {
  return {
    system:
      'You are Vessel, an AI browsing assistant. Answer questions about web page content accurately and concisely. If the answer is not in the content, say so.',
    user: `Based on this web page:\n\nTitle: ${page.title}\nURL: ${page.url}\n\nContent:\n${truncateContent(page.content)}\n\nQuestion: ${question}`,
  };
}

export function buildGeneralPrompt(query: string): {
  system: string;
  user: string;
} {
  return {
    system:
      'You are Vessel, an AI browsing assistant. Help the user with their browsing needs. Be concise and helpful.',
    user: query,
  };
}
