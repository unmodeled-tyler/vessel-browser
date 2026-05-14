import {
  For,
  Show,
  Switch,
  Match,
  createMemo,
  createSignal,
  type Component,
} from "solid-js";
import type { AIMessage } from "../../../../shared/types";
import type { ResearchClarification } from "../../../../shared/research-types";
import { useAI } from "../../stores/ai";
import { useResearch } from "../../stores/research";
import { renderMarkdown } from "../../lib/markdown";

interface QuickReplyOption {
  label: string;
  response: string;
}

const ResearchBriefMarkdown = (props: { content: string }) => {
  const html = createMemo(() => renderMarkdown(props.content));

  return <div class="markdown-content" innerHTML={html()} />;
};

const ResearchBriefMessage = (props: {
  role: AIMessage["role"];
  content: string;
}) => (
  <div class={`research-brief-message ${props.role}`}>
    <Show when={props.role === "assistant"} fallback={props.content}>
      <ResearchBriefMarkdown content={props.content} />
    </Show>
  </div>
);

function uniqueQuickReplies(options: QuickReplyOption[]): QuickReplyOption[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const YES_NO_QUESTION_PATTERN =
  /^\s*(?:do you want|should (?:i|we|vessel)|would you like|is it okay|okay to|shall (?:i|we))\b/i;
const PROCEED_QUESTION_PATTERN =
  /\b(?:proceed|continue|use defaults?|make assumptions?|sensible defaults?)\b/i;

const EXPLICIT_OPTION_PREFIX = /^\s*(?:[-*+•–—]|\d+[.)]|\(\d+\)|[A-Za-z][.)]|\([A-Za-z]\)|Option\s+\d+[:：])\s+/i;
const SENTENCE_STARTER = /^(?:Here|These|They|You|I\s|We\s|This|That|If|When|Because|Also|Please|Let|Will|Would|Could|Should|Can|May|Might|Must|Shall)\b/i;
const MAX_QUICK_REPLY_LABEL_LENGTH = 180;

export function makeQuickReply(label: string): QuickReplyOption | null {
  const cleaned = label
    .replace(EXPLICIT_OPTION_PREFIX, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!:]$/, "");

  if (cleaned.length < 2 || cleaned.length > MAX_QUICK_REPLY_LABEL_LENGTH) {
    return null;
  }

  return {
    label: cleaned,
    response: `Let's use: ${cleaned}.`,
  };
}

function isExplicitOptionLine(line: string): boolean {
  if (!EXPLICIT_OPTION_PREFIX.test(line)) return false;

  const cleaned = line.replace(EXPLICIT_OPTION_PREFIX, "").trim();

  if (!cleaned) return false;

  return !/[?]$/.test(cleaned);
}

function extractDelimitedOptions(text: string): QuickReplyOption[] {
  return text
    .split(/\s*(?:;|,|\/|\||\s+-\s+|\bor\b)\s*/i)
    .map(makeQuickReply)
    .filter((option): option is QuickReplyOption => option !== null);
}

/**
 * Look for comma/slash/or-separated options on the line(s) immediately
 * following a question line. This catches formats like:
 *   "What depth? High-level overview, deep dive, or both."
 */
function extractFollowUpOptions(prompt: string): QuickReplyOption[] {
  const lines = prompt.split("\n");
  const options: QuickReplyOption[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    if (!line.includes("?")) continue;

    // Look ahead for the next non-empty line (skip blank lines)
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    if (j >= lines.length) continue;

    const nextLine = lines[j].trim();
    // Already handled by explicit bullet extraction
    if (EXPLICIT_OPTION_PREFIX.test(nextLine)) continue;
    // Only extract if the next line looks like a list (delimiters or "or")
    if (!/[,;\/|]|\bor\b/.test(nextLine)) continue;

    options.push(...extractDelimitedOptions(nextLine));
  }

  return uniqueQuickReplies(options);
}

/**
 * Catch options that appear inline on the SAME line as the question,
 * after a colon or question mark, with clear delimiters.
 */
function extractInlineOptions(prompt: string): QuickReplyOption[] {
  const options: QuickReplyOption[] = [];

  for (const line of prompt.split("\n")) {
    const trimmed = line.trim();
    if (!/\?/.test(trimmed)) continue;

    const afterQuestion = trimmed.slice(trimmed.lastIndexOf("?") + 1).trim();
    if (!afterQuestion) continue;

    // Skip text that will be handled by specialized extractors (labels or
    // quoted examples) so we don't emit duplicate/prefixed options.
    if (
      /\b(?:options?|choices?|examples?|example answers?|examples? include|sample answers?|sample responses?)\b.*[:：]/i.test(
        afterQuestion,
      )
    ) {
      continue;
    }

    const hasDelimiters = /[,;\/|]|\bor\b/.test(afterQuestion);
    const hasDashList = /\s+-\s+/.test(afterQuestion);

    if (!hasDelimiters && !hasDashList) continue;

    if (hasDelimiters) {
      options.push(...extractDelimitedOptions(afterQuestion));
    }
    if (hasDashList) {
      const parts = afterQuestion.split(/\s+-\s+/);
      for (const part of parts) {
        const option = makeQuickReply(part);
        if (option) options.push(option);
      }
    }
  }

  return uniqueQuickReplies(options);
}

/**
 * Detect plain lines after the last question that look like options.
 * Models often output options as short plain lines without any prefix.
 */
function extractImplicitOptions(prompt: string): QuickReplyOption[] {
  const lines = prompt.split("\n");
  const options: QuickReplyOption[] = [];

  // Find the last line containing a question mark
  let questionIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes("?")) {
      questionIdx = i;
      break;
    }
  }
  if (questionIdx < 0) return [];

  // Scan forward from the question, skipping empty/preamble lines
  let i = questionIdx + 1;
  while (i < lines.length && !lines[i].trim()) i++;

  // Collect up to 6 consecutive short non-empty lines that look like options
  const candidates: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break;
    // Skip lines that already have explicit prefixes (handled elsewhere)
    if (EXPLICIT_OPTION_PREFIX.test(line)) break;
    // Skip lines that look like the start of a new sentence/preamble
    if (SENTENCE_STARTER.test(line)) break;
    // Skip overly long lines (likely a paragraph, not an option),
    // unless they contain clear option delimiters.
    const hasDelimiters = /[,;\/|]|\bor\b/.test(line);
    if (line.length > 80 && !hasDelimiters) break;

    candidates.push(line);
  }

  if (candidates.length >= 2 && candidates.length <= 6) {
    for (const candidate of candidates) {
      const option = makeQuickReply(candidate);
      if (option) options.push(option);
    }
  }

  return uniqueQuickReplies(options);
}

function extractExampleQuickReplies(prompt: string): QuickReplyOption[] {
  const options: QuickReplyOption[] = [];

  for (const line of prompt.split("\n")) {
    if (
      !/\b(?:examples?|sample (?:answers?|responses?)|e\.g\.|for instance|you (?:could|might) (?:say|answer|reply))\b/i.test(
        line,
      )
    ) {
      continue;
    }

    const quoted = Array.from(
      line.matchAll(/["“”']([^"“”']{2,140})["“”']/g),
      (match) => match[1],
    )
      .map(makeQuickReply)
      .filter((option): option is QuickReplyOption => option !== null);
    options.push(...quoted);

    if (quoted.length === 0) {
      const exampleText = line
        .replace(
          /^.*?\b(?:examples? include|example answers?|examples?|sample answers?|sample responses?|e\.g\.|for instance|you might (?:say|answer|reply)|you could (?:say|answer|reply))[:：]?\s*/i,
          "",
        )
        .replace(/^(?:include|answers?|responses?)[:：]\s*/i, "")
        .trim();
      options.push(...extractDelimitedOptions(exampleText));
    }
  }

  return uniqueQuickReplies(options);
}

export function extractExplicitQuickReplies(prompt: string): QuickReplyOption[] {
  const options: QuickReplyOption[] = [];

  for (const line of prompt.split("\n")) {
    const option = makeQuickReply(line);
    if (isExplicitOptionLine(line) && option) {
      options.push(option);
    }
  }

  const inlineMatch = prompt.match(
    /(?:choose|pick|select|prefer|between|among)\s+(.+?)(?:\?|$)/i,
  );
  if (inlineMatch) {
    options.push(...extractDelimitedOptions(inlineMatch[1]));
  }

  // Catch inline options on the same line as the question
  options.push(...extractInlineOptions(prompt));

  // Catch multi-line option lists after "Options:" / "Choices:" labels.
  // We scan line-by-line so we can capture options that span multiple lines.
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(?:options?|choices?)\s*[:：]/i.test(lines[i])) continue;

    // Anything after the label on the SAME line
    const restOfLine = lines[i]
      .replace(/^.*?\b(?:options?|choices?)\s*[:：]\s*/i, "")
      .trim();
    if (restOfLine) {
      options.push(...extractDelimitedOptions(restOfLine));
    }

    // Scan subsequent lines for more options (until a blank line)
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    for (; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line) break;
      const option = makeQuickReply(line);
      if (option) options.push(option);
    }
  }

  options.push(...extractExampleQuickReplies(prompt));
  options.push(...extractFollowUpOptions(prompt));

  return uniqueQuickReplies(options);
}

export function buildQuickReplies(prompt: string): QuickReplyOption[] {
  const explicitOptions = extractExplicitQuickReplies(prompt);
  if (explicitOptions.length > 0) {
    return explicitOptions.slice(0, 6);
  }

  // Second pass: detect plain lines after the last question that look like options
  const implicitOptions = extractImplicitOptions(prompt);
  if (implicitOptions.length > 0) {
    return implicitOptions.slice(0, 6);
  }

  if (YES_NO_QUESTION_PATTERN.test(prompt)) {
    return [
      { label: "Yes", response: "Yes." },
      { label: "No", response: "No." },
    ];
  }

  if (PROCEED_QUESTION_PATTERN.test(prompt)) {
    return [
      {
        label: "Use defaults",
        response: "Use sensible defaults and proceed. If a choice materially affects the report, call it out in the assumptions.",
      },
    ];
  }

  if (prompt.includes("?")) {
    return [
      {
        label: "Use defaults",
        response:
          "Use sensible defaults and proceed. If any assumption materially affects the report, call it out clearly.",
      },
    ];
  }

  return [];
}

function isDefaultQuickReply(option: QuickReplyOption): boolean {
  return option.label.toLowerCase() === "use defaults";
}

export function pickResearchClarificationQuickReplies(
  clarification: ResearchClarification,
): QuickReplyOption[] {
  const parsedQuestionOptions = extractExplicitQuickReplies(clarification.question);
  const structuredOptions = clarification.options.map((option) => ({
    label: option.label,
    response: option.response,
  }));

  if (
    parsedQuestionOptions.length > 0 &&
    (structuredOptions.length === 0 ||
      structuredOptions.every(isDefaultQuickReply))
  ) {
    return parsedQuestionOptions;
  }

  if (parsedQuestionOptions.length > structuredOptions.length) {
    return uniqueQuickReplies([...structuredOptions, ...parsedQuestionOptions])
      .slice(0, 6);
  }

  return uniqueQuickReplies(structuredOptions).slice(0, 6);
}

export function findLatestAssistantQuickReplyTarget(messages: AIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const content = message.content.trim();
    if (!content) continue;
    if (message.role !== "assistant") return "";

    if (content && buildQuickReplies(content).length > 0) {
      return content;
    }
    return "";
  }

  return "";
}

export function findLatestResearchClarification(
  messages: AIMessage[],
  clarifications: ResearchClarification[],
): ResearchClarification | null {
  let latestAssistantContent = "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const content = message.content.trim();
    if (!content) continue;

    if (message.role !== "assistant") {
      return null;
    }

    latestAssistantContent = content;
    break;
  }

  if (!latestAssistantContent) return null;

  for (let i = clarifications.length - 1; i >= 0; i -= 1) {
    const clarification = clarifications[i];
    if (clarification.question.trim() === latestAssistantContent) {
      return clarification;
    }
  }

  return null;
}

export const ResearchDesk: Component = () => {
  const research = useResearch();
  const {
    query: sendChatQuery,
    messages,
    streamingText,
    isStreaming,
    pendingQueryCount,
    researchClarifications,
  } = useAI();
  const state = research.state;
  const [topicInput, setTopicInput] = createSignal("");
  const [briefInput, setBriefInput] = createSignal("");
  const [startError, setStartError] = createSignal("");

  const transcriptMessages = createMemo(() => {
    const allMessages = messages();
    const originalQuery = state().originalQuery?.trim();
    if (!originalQuery) return allMessages;

    for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const message = allMessages[i];
      if (message.role === "user" && message.content.trim() === originalQuery) {
        return allMessages.slice(i);
      }
    }

    return [];
  });

  const hasAssistantBrief = createMemo(() =>
    transcriptMessages().some((message) => message.role === "assistant"),
  );
  const latestResearchClarification = createMemo(() =>
    findLatestResearchClarification(
      transcriptMessages(),
      researchClarifications(),
    ),
  );
  const latestAssistantQuickReplyTarget = createMemo(() =>
    latestResearchClarification()?.question ??
    findLatestAssistantQuickReplyTarget(transcriptMessages()),
  );
  const quickReplies = createMemo(() => {
    const clarification = latestResearchClarification();
    if (clarification) {
      return pickResearchClarificationQuickReplies(clarification);
    }

    return latestAssistantQuickReplyTarget()
      ? buildQuickReplies(latestAssistantQuickReplyTarget())
      : [];
  });
  const shouldShowQuickRepliesForMessage = (content: string) =>
    quickReplies().length > 0 &&
    content.trim() === latestAssistantQuickReplyTarget();
  const isBriefStarting = createMemo(() =>
    state().phase === "briefing" &&
    transcriptMessages().length === 0 &&
    !streamingText() &&
    pendingQueryCount() === 0,
  );

  const sendBriefMessage = async (message: string) => {
    const trimmed = message.trim();
    if (!trimmed) return;
    setBriefInput("");
    await sendChatQuery(trimmed);
  };

  const startBrief = async () => {
    const query = topicInput().trim();
    if (!query) return;
    const result = await research.startBrief(query);
    if (result.accepted) {
      setStartError("");
      setTopicInput("");
      await sendBriefMessage(query);
    } else {
      setStartError(
        result.reason === "busy"
          ? "Research Desk is already working on a brief."
          : "Could not start the briefing. Check your chat provider settings and try again.",
      );
    }
  };

  return (
    <div class="research-desk">
      <Switch>
        <Match when={state().phase === "idle"}>
          <div class="research-idle">
            <h3>Research Desk</h3>
            <p>Start with a topic. Vessel will shape it into a focused brief, draft a research plan, and then send sub-agents after the strongest sources.</p>
            <Show when={!research.isPremium()}>
              <div class="research-premium-notice">
                <span class="premium-badge">Premium</span>
                {" "}Brief is free; full research and export require Vessel Premium.
              </div>
            </Show>
            <form
              class="research-topic-form"
              onSubmit={(event) => {
                event.preventDefault();
                void startBrief();
              }}
            >
              <textarea
                class="research-topic-input"
                rows={3}
                placeholder="What should we research?"
                value={topicInput()}
                onInput={(event) => setTopicInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void startBrief();
                  }
                }}
              />
              <button
                class="research-start-btn"
                type="submit"
                disabled={!topicInput().trim()}
              >
                Start Briefing
              </button>
            </form>
            <Show when={startError()}>
              <div class="research-brief-status">{startError()}</div>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "briefing"}>
          <div class="research-phase">
            <h3>Briefing</h3>
            <p>Work through the brief here. Once the assistant has enough context, turn it into a research plan.</p>
            <div class="research-brief-thread">
              <Show when={isBriefStarting()}>
                <div class="research-brief-loading" role="status" aria-live="polite">
                  <span class="research-spinner" aria-hidden="true" />
                  <div>
                    <div class="research-loading-title">Brief started</div>
                    <div class="research-loading-copy">
                      Preparing the first briefing question...
                    </div>
                  </div>
                </div>
              </Show>
              <For each={transcriptMessages()}>
                {(message) => (
                  <>
                    <ResearchBriefMessage
                      role={message.role}
                      content={message.content}
                    />
                    <Show when={message.role === "assistant" && shouldShowQuickRepliesForMessage(message.content)}>
                      <div class="research-quick-replies inline" aria-label="Suggested briefing responses">
                        <For each={quickReplies()}>
                          {(option) => (
                            <button
                              type="button"
                              class="research-quick-reply"
                              onClick={() => void sendBriefMessage(option.response)}
                            >
                              {option.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </>
                )}
              </For>
              <Show when={isStreaming() && streamingText()}>
                <ResearchBriefMessage role="assistant" content={streamingText()} />
              </Show>
              <Show when={isStreaming() && !streamingText()}>
                <div class="research-brief-status thinking" role="status" aria-live="polite">
                  <span class="research-spinner" aria-hidden="true" />
                  <span>Thinking...</span>
                </div>
              </Show>
              <Show when={pendingQueryCount() > 0}>
                <div class="research-brief-status">
                  {pendingQueryCount()} queued
                </div>
              </Show>
            </div>
            <form
              class="research-brief-form"
              onSubmit={(event) => {
                event.preventDefault();
                void sendBriefMessage(briefInput());
              }}
            >
              <textarea
                class="research-brief-input"
                rows={2}
                placeholder={isStreaming() ? "Send now to queue a follow-up..." : "Please provide as much information about your research question as possible, e.g. constraints, preferred sources..."}
                value={briefInput()}
                onInput={(event) => setBriefInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendBriefMessage(briefInput());
                  }
                }}
              />
              <button type="submit" disabled={!briefInput().trim()}>
                {isStreaming() ? "Queue" : "Send"}
              </button>
            </form>
            <div class="phase-controls">
              <button
                disabled={!hasAssistantBrief() || isStreaming()}
                onClick={async () => {
                  const result = await research.confirmBrief();
                  if (result.accepted) {
                    await sendChatQuery(
                      "Build the Research Objectives from this brief now.",
                    );
                  } else if (result.reason === "premium") {
                    void window.vessel.premium.checkout();
                  }
                }}
              >
                Build Research Plan
              </button>
              <button class="secondary" onClick={() => research.cancel()}>
                Cancel
              </button>
            </div>
          </div>
        </Match>

        <Match when={state().phase === "planning"}>
          <div class="research-phase">
            <h3>Planning Research</h3>
            <p>Creating Research Objectives based on your brief...</p>
          </div>
        </Match>

        <Match when={state().phase === "awaiting_approval"}>
          <div class="research-phase">
            <h3>Research Objectives</h3>
            <Show when={state().objectives}>
              {(obj) => (
                <div class="objectives-card">
                  <section class="objectives-section">
                    <p class="objectives-label">Question</p>
                    <p class="objectives-question">{obj().researchQuestion}</p>
                  </section>

                  <section class="objectives-section">
                    <div class="objectives-section-header">
                      <p class="objectives-label">Research Threads</p>
                      <span>{obj().threads.length}</span>
                    </div>
                    <ul class="objectives-thread-list">
                      {obj().threads.map((t) => (
                        <li>
                          <span>{t.label}</span>
                          <small>{t.sourceBudget} sources</small>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section class="objectives-section objectives-settings">
                    <label class="mode-toggle">
                      <input
                        type="checkbox"
                        checked={state().supervisionMode === "walk-away"}
                        onChange={(e) =>
                          research.setMode(
                            e.currentTarget.checked
                              ? "walk-away"
                              : "interactive",
                          )
                        }
                      />
                      <span>Walk-away mode (notified when done)</span>
                    </label>

                    <label class="traces-toggle">
                      <input
                        type="checkbox"
                        checked={state().includeTraces}
                        onChange={(e) =>
                          research.setTraces(e.currentTarget.checked)
                        }
                      />
                      <span>Include agent traces with report</span>
                    </label>
                  </section>

                  <div class="phase-controls">
                    <button
                      onClick={() =>
                        research.approveObjectives({
                          supervisionMode: state().supervisionMode,
                          includeTraces: state().includeTraces,
                        })
                      }
                    >
                      Start Research
                    </button>
                    <button class="secondary" onClick={() => research.cancel()}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "executing"}>
          <div class="research-phase">
            <h3>Researching</h3>
            <Show when={state().threadFindings.length > 0}>
              <p>{state().threadFindings.length} of {state().threads.length} threads complete</p>
            </Show>
            <Show when={state().supervisionMode === "interactive"}>
              <button onClick={() => research.setMode("walk-away")}>
                Switch to Walk-Away
              </button>
            </Show>
            <Show when={state().supervisionMode === "walk-away"}>
              <button onClick={() => research.setMode("interactive")}>
                Switch to Interactive
              </button>
            </Show>
          </div>
        </Match>

        <Match when={state().phase === "synthesizing"}>
          <div class="research-phase">
            <h3>Synthesizing Report</h3>
            <p>Compiling findings into the Research Report...</p>
          </div>
        </Match>

        <Match when={state().phase === "delivered"}>
          <div class="research-phase">
            <h3>Report Ready</h3>
            <Show when={state().report}>
              {(report) => (
                <div class="report-card">
                  <h4>{report().title}</h4>
                  <p>{report().executiveSummary.slice(0, 300)}...</p>
                  <p>{report().sourceIndex.length} sources cited</p>
                  <button onClick={() => research.exportReport()}>
                    Export as Markdown
                  </button>
                  <button class="secondary" onClick={() => research.cancel()}>
                    New Research
                  </button>
                </div>
              )}
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  );
};
