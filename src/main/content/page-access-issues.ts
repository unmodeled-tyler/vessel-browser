import type { PageContent, PageIssue, PageIssueKind } from "../../shared/types";

type IssuePatternSet = {
  kind: PageIssueKind;
  severity: PageIssue["severity"];
  summary: string;
  detail: string;
  recommendation: string;
  titlePatterns: RegExp[];
  bodyPatterns: RegExp[];
  urlPatterns?: RegExp[];
  minimumScore: number;
};

const SEARCH_ENGINE_HOSTS = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "search.brave.com",
];

const ISSUE_PATTERNS: IssuePatternSet[] = [
  {
    kind: "rate-limit",
    severity: "error",
    summary: "Rate limit or automated-traffic page detected.",
    detail:
      "The page appears to be throttling or blocking automated requests instead of showing normal results.",
    recommendation:
      "Stop using this page. Prefer direct sources, venue directories, site-specific search, or another provider instead of retrying the same blocked page.",
    titlePatterns: [
      /\b429\b/i,
      /too many requests/i,
      /unusual traffic/i,
      /rate limit/i,
    ],
    bodyPatterns: [
      /\b429\b/i,
      /too many requests/i,
      /rate limit(?:ed|ing)?/i,
      /unusual traffic/i,
      /automated queries/i,
      /we have detected unusual traffic/i,
      /temporarily blocked/i,
      /request limit/i,
      /service unavailable/i,
    ],
    urlPatterns: [/\/sorry\//i, /[?&]status=429\b/i],
    minimumScore: 3,
  },
  {
    kind: "bot-check",
    severity: "error",
    summary: "Human verification or anti-bot page detected.",
    detail:
      "The page is asking for a CAPTCHA, browser challenge, or other human verification instead of usable content.",
    recommendation:
      "Do not continue interacting with this page as normal content. Switch to a direct source, a site-specific search page, or another service that exposes the needed information without a bot wall.",
    titlePatterns: [
      /captcha/i,
      /security check/i,
      /verify (you(?:'|’)re|you are) human/i,
      /attention required/i,
      /checking your browser/i,
    ],
    bodyPatterns: [
      /captcha/i,
      /\brecaptcha\b/i,
      /\bhcaptcha\b/i,
      /i am not a robot/i,
      /not a robot/i,
      /verify (you(?:'|’)re|you are) human/i,
      /prove (you(?:'|’)re|you are) human/i,
      /human verification/i,
      /security check/i,
      /checking your browser/i,
      /please enable javascript and cookies to continue/i,
      /attention required/i,
      /one more step/i,
      /press (&|and) hold/i,
      /challenge-platform/i,
    ],
    urlPatterns: [/captcha/i, /challenge/i, /cdn-cgi/i],
    minimumScore: 3,
  },
  {
    kind: "access-denied",
    severity: "error",
    summary: "Access denied page detected.",
    detail:
      "The site is denying access instead of serving the requested page or search results.",
    recommendation:
      "Back out and try a different source. Do not keep treating this page like normal content.",
    titlePatterns: [/access denied/i, /\bforbidden\b/i, /request blocked/i],
    bodyPatterns: [
      /access denied/i,
      /\bforbidden\b/i,
      /request blocked/i,
      /you do not have permission/i,
      /you don't have permission/i,
      /permission to access/i,
      /blocked due to unusual activity/i,
    ],
    urlPatterns: [/access[-_]denied/i, /forbidden/i],
    minimumScore: 3,
  },
  {
    kind: "not-found",
    severity: "warning",
    summary: "Missing or removed page detected.",
    detail:
      "The page appears to be a 404 or not-found response rather than the intended destination.",
    recommendation:
      "Navigate back and try a different result or source. This destination may be stale or removed.",
    titlePatterns: [
      /\b404\b/i,
      /\bnot found\b/i,
      /page not found/i,
      /we couldn(?:'|’)t find/i,
    ],
    bodyPatterns: [
      /\b404\b/i,
      /\bnot found\b/i,
      /page not found/i,
      /sorry[, ]+we can(?:'|’)t find/i,
      /the page you(?:'|’)re looking for/i,
      /this page is unavailable/i,
      /the requested url was not found/i,
      /doesn(?:'|’)t exist/i,
      /could not be found/i,
    ],
    urlPatterns: [/\/404\b/i, /not[-_]found/i],
    minimumScore: 3,
  },
];

function normalizeText(value: string): string {
  return value.toLowerCase();
}

function countPatternMatches(value: string, patterns: RegExp[]): number {
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.test(value)) {
      seen.add(pattern.source);
    }
  }

  return seen.size;
}

function hostSpecificRecommendation(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (SEARCH_ENGINE_HOSTS.some((entry) => host.includes(entry))) {
      return "Prefer direct sources, official sites, venue calendars, directories, or site-specific search instead of a generic search engine that is blocking automation.";
    }
  } catch {
    // Ignore malformed URLs
  }

  return fallback;
}

export function detectPageIssues(page: Pick<
  PageContent,
  "url" | "title" | "content" | "excerpt" | "headings" | "metaTags"
>): PageIssue[] {
  const title = page.title.trim();
  const body = [
    page.title,
    page.excerpt,
    page.headings.map((heading) => heading.text).join("\n"),
    page.metaTags?.description ?? "",
    page.metaTags?.["og:description"] ?? "",
    page.content.slice(0, 6000),
  ]
    .filter(Boolean)
    .join("\n");

  const normalizedTitle = normalizeText(title);
  const normalizedBody = normalizeText(body);
  const normalizedUrl = normalizeText(page.url);

  const issues = ISSUE_PATTERNS.map((issue) => {
    const titleMatches = countPatternMatches(
      normalizedTitle,
      issue.titlePatterns,
    );
    const bodyMatches = countPatternMatches(normalizedBody, issue.bodyPatterns);
    const urlMatches = issue.urlPatterns
      ? countPatternMatches(normalizedUrl, issue.urlPatterns)
      : 0;
    const score = titleMatches * 2 + bodyMatches + urlMatches;

    return {
      issue,
      score,
    };
  })
    .filter(({ score, issue }) => score >= issue.minimumScore)
    .sort((left, right) => right.score - left.score)
    .map(({ issue }) => ({
      kind: issue.kind,
      severity: issue.severity,
      summary: issue.summary,
      detail: issue.detail,
      recommendation: hostSpecificRecommendation(
        page.url,
        issue.recommendation,
      ),
    }));

  return issues.slice(0, 2);
}

export function getRecoverableAccessIssue(
  page: Pick<PageContent, "pageIssues">,
): PageIssue | null {
  return (
    page.pageIssues?.find(
      (issue) => issue.kind === "rate-limit" || issue.kind === "bot-check",
    ) ?? null
  );
}
