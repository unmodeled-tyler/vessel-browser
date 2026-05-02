# Research Desk — Design Spec

**Date:** 2026-05-01
**Status:** Design approved, awaiting implementation plan

## Overview

Research Desk is a Premium feature that turns Vessel into a deep-research engine powered by sub-agent orchestration. A "captain" orchestrator model interviews the user, produces structured Research Objectives, spawns parallel sub-agents to investigate independent threads, and synthesizes their findings into a source-anchored Research Report.

## Motivation

- **User need:** Deep, multi-source research that produces a structured, citable report — without hallucination or wasted tokens
- **Differentiation:** Sub-agent parallelism and source-anchoring are not available in any other AI browser
- **Monetization:** Premium-gated feature with a natural "try the brief, pay for the execution" conversion path

## Anti-Hallucination Guardrails

Every claim in the final report must carry a `(source URL, extracted quote)` tuple. The orchestrator cannot invent claims — it can only synthesize what sub-agents actually extracted. Claims without citations are rejected during synthesis.

Additionally, the Brief phase acts as a hard gate: no browsing can occur until the user has confirmed they provided enough context, preventing the "missed context → hallucinated report" failure mode.

## Workflow (6 Phases)

### Phase 1: Brief

The orchestrator interviews the user to refine the research question. This is pure dialogue — no browsing, no tools beyond chat.

**Behavior:**
- Asks clarifying questions one at a time (scope, audience, constraints, success criteria)
- Detects vague questions and switches into "exploration mode," proactively suggesting 2–3 research angles
- Acts as a "curiosity engine" — helps users discover what they actually want to know
- Summarizes understanding and asks for confirmation before proceeding

**Hard gate:** The orchestrator cannot navigate or spawn sub-agents until the brief is confirmed.

### Phase 2: Research Objectives

The orchestrator produces a structured Research Objectives document:

- **Research question** — refined from the brief
- **Threads** — 2–5 independent research angles, each assigned to one sub-agent
- **Per thread:** specific question, suggested search queries, preferred/avoided domains
- **Source budget** — target number of sources per thread
- **Report outline** — skeleton of expected report sections

### Phase 3: Approval Gate

The Research Objectives render as a structured card in the Chat tab. The human can:
- Approve as-is
- Edit any field (add threads, narrow questions, block domains)
- Send back with feedback
- Cancel entirely

**Decisions made here:**
- **Supervision mode:** "Walk Away" (notified when done) or "Interactive" (real-time sub-agent monitoring), hotswappable mid-task
- **Trace inclusion:** toggle "Include agent traces with report" (default: off)

### Phase 4: Sub-Agent Execution

**Mechanics:**
- Each thread spawns a sub-agent with its own browser tab
- Sub-agents run in parallel, full tool belt access (navigate, click, extract, read_page, etc.)
- Sub-agents are isolated — no cross-tab visibility
- Each sub-agent produces a **Thread Findings** artifact: sourced claims with `(URL, extracted quote, relevance note)`
- Sub-agents cannot exceed their source budget or wander beyond their assigned question

**Orchestrator as "captain":**
- Monitors sub-agent progress via incremental findings
- Rebalances if a thread stalls — reassigns or respawns
- In interactive mode: flags contradictions or asks for guidance
- In walk-away mode: makes judgment calls within approved Objectives
- Reviews sub-agent output critically — pushes back on thin findings, demands more

**System prompt framing:** The orchestrator is positioned as the captain accountable for the deliverable. "The report has your name on it." It reviews, challenges, and synthesizes — it does not blindly concatenate sub-agent output.

### Phase 5: Synthesis

The orchestrator produces the final Research Report:

- **Title & executive summary** — 2–3 paragraph answer
- **Findings by thread** — one section per thread with sourced claims
- **Contradictions & gaps** — explicitly flagged (builds trust)
- **Source index** — numbered list with URLs, page titles, access timestamps, and supporting quotes
- **Agent trace appendix** (if enabled) — condensed execution logs from sub-agents

**Citation format:** Inline anchors `[1]` linking to the source index. Every factual claim carries at least one citation.

**Quality gate:** Before finalizing, the orchestrator self-audits: "Do I have enough? Am I confident in every claim?"

### Phase 6: Deliver

The report renders in the Chat/Sidebar. Exportable as markdown. Raw data (Objectives, Thread Findings, Report, optional traces) persists in the session for later review.

## Premium Gating

The Research Desk is Premium-only. The Brief phase is accessible to all users (it's just chat), giving free-tier users a taste of the workflow. The gate triggers when the user attempts to proceed to Research Objectives generation.

Upsell message is contextual: "Deep Research with sub-agents is a Premium feature."

## Human-in-the-Loop Modes

| Mode | Behavior | Best for |
|------|----------|----------|
| Walk Away | Human approves Objectives, gets notified when report is ready | Confident users, well-scoped questions |
| Interactive | Human sees sub-agent progress live, can redirect mid-task | Exploratory research, high-stakes work |

**Hotswap:** The user can switch modes at any time during execution. Walk Away → Interactive pulls them into the live view. Interactive → Walk Away dismisses them until completion.

## Technical Sketch

### New Components

- **`src/main/agent/research/`** — orchestrator logic, sub-agent spawn/coordination, Thread Findings merge, report synthesis
- **Research Objectives schema** — `src/shared/research-types.ts`
- **Research Report schema** — same file, exported for renderer consumption

### Extended Components

- **`src/main/agent/`** — orchestrator system prompt template with captain framing, brief-phase instructions, and exploration-mode triggers
- **`src/main/premium/`** — feature gate for Research Desk
- **`src/main/ai/`** — orchestrator routes in Chat provider

### Existing Infrastructure Reused

- Tab management (sub-agents are standard tabs)
- Tool definitions (sub-agents use the same tool belt)
- Chat Assistant (brief dialogue uses existing chat infrastructure)
- Premium gating (existing gate check pattern)
- Sidebar rendering (report display in Supervisor/Chat tabs)

## Configuration

- **`includeAgentTraces`** — boolean, per-research-task, default `false`
- **`supervisionMode`** — `"walk-away"` | `"interactive"`, per-research-task, default `"interactive"`

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| High token cost (parallel models) | Source budgets per thread, thread count cap, user approves plan first |
| Sub-agent gets stuck in infinite loop | Step budget per sub-agent, orchestrator timeout kills stale threads |
| Orchestrator hallucinates during synthesis | Source-anchoring constraint, no-citation-no-claim rule |
| User provides insufficient brief | Hard gate — no browsing until brief confirmed. Orchestrator trained to probe for gaps |
