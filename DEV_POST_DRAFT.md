---
title: "Slothy: Slow Down, Get the Gist with Local Gemma"
published: false
tags: devchallenge, hacktoberfest, gemma, webdev
cover_image: https://raw.githubusercontent.com/your-username/slothy/main/slothy-extension/assets/banner.png
description: "A calm, privacy-first Chrome extension that distills long web articles into 3-sentence summaries, high-signal takeaways, and source-grounded action items using local Gemma via Ollama."
---

# Slothy: Slow Down, Get the Gist with Local Gemma

*This is an official entry for the **DEV Challenge #3: “Slow and Steady”** during Hacktoberfest 2026, targeting the **Best Use of Gemma** track.*

---

## 1. The Problem: The Cognitive Weight of Modern Reading

If you are a developer, researcher, or curious technologist, your browser tabs probably look like an archive of good intentions. Long technical RFCs, sprawling documentation pages, 4,000-word tutorials, and release notes pile up.

When we feel overwhelmed, we do one of two things:
1. **Skim hastily**, missing nuanced prerequisites, architectural trade-offs, and critical deadlines.
2. **Copy-paste text into cloud-based LLM chats**, inadvertently handing private internal wikis, proprietary code snippets, and browsing history to remote third-party servers.

We built **Slothy** because we wanted a third path: **a mindful, calm, 100% on-device reading assistant** that extracts the essence of any webpage without hurry, without surveillance, and without cognitive noise.

---

## 2. What is Slothy?

**Slothy** is a minimalist, privacy-first Chrome Manifest V3 extension. 

With one click, Slothy reads the active tab and presents:
- **The Gist**: A concise, 2-to-3 sentence plain-language summary of the page's core thesis.
- **Key Takeaways**: 3 to 5 high-signal bullet points distilling the main insights.
- **Action Items**: Concrete steps and instructions with interactive checkboxes to track your reading progress.
- **Grounded Deadlines**: When a deadline, release date, or conference submission cutoff is mentioned on the page, Slothy extracts it. If there is no deadline, Slothy never hallucinates one.
- **One-Click Markdown Copy**: Formatted for instant pasting into your personal knowledge base (Obsidian, Notion, Logseq, or Markdown notes).

Our tagline: **"Slow down. Get the gist."**

---

## 3. How Local Gemma Inference Works

Slothy runs on **open-weight AI**. We chose Google's **Gemma** family (defaulting to `gemma3:4b` or `gemma:2b`), hosted locally through **Ollama**.

```
[Browser Tab]
      │ (chrome.scripting)
      ▼
[Zero-Dependency Content Extractor]
      │ (Clean Article Text)
      ▼
[Slothy Popup (popup.js)]
      │ (POST http://localhost:11434/api/chat)
      ▼
[Local Ollama Daemon]
      │
      ▼
[Gemma 4B / 2B Model]
      │ (Structured JSON Output)
      ▼
[Multi-Stage JSON & Deadline Sanitizer]
      │
      ▼
[Safe DOM Renderer (textContent only)]
```

### Prompt & Structured JSON Architecture

Rather than arbitrary conversational chat, Slothy requests strict structured JSON with visual mind map contracts:

```json
{
  "summary": "2 to 3 calm, informative sentences explaining the core central idea.",
  "takeaways": [
    "3 to 5 concise, actionable bullet points capturing essential insights."
  ],
  "action_items": [
    {
      "task": "A concrete step, task, or command explicitly mentioned in the source.",
      "due": "Exact date, deadline, or timeframe stated in the text, or null if none is stated."
    }
  ],
  "visual": {
    "type": "mindmap",
    "central_topic": "Central Topic Name",
    "nodes": [
      {
        "id": "c1",
        "label": "Major Concept 1",
        "parent_id": null,
        "description": "Brief explanation grounded in source."
      },
      {
        "id": "c2",
        "label": "Supporting Idea",
        "parent_id": "c1",
        "description": "How it relates to Concept 1."
      }
    ],
    "edges": [
      {
        "source": "c1",
        "target": "c2",
        "relationship": "supports"
      }
    ]
  }
}
```

By streaming NDJSON chunks at temperature `0.15` and enforcing `format: "json"` via Ollama's `/api/chat`, Slothy delivers fast visual comprehension while staying grounded in the extracted text.

---

## 4. Key Design & Implementation Decisions

### 1. Interactive Native SVG Visual Mind Maps
Instead of downloading heavy third-party diagramming or canvas libraries, Slothy features an in-house native DOM SVG visualizer:
- **Radial Node Placement**: Dynamically calculates radial node coordinates around the central topic with smooth Bezier connector curves and directional arrow markers.
- **Micro-Interactions**: Full mouse drag-to-pan, wheel/button zoom controls, and click-to-inspect concept cards.
- **Accessibility Outline**: An instant toggle switches between the visual diagram and an accessible semantic text outline.
- **Failure Isolation**: If the model outputs valid summary text but malformed graph connections, Slothy renders the Gist cleanly and isolates the diagram with a graceful retry state.

### 2. Streaming Inference with Instant Cancellation
Slothy v0.2.0 implements real-time streaming via `stream: true`, reading chunks with `response.body.getReader()` and `TextDecoder`. In-flight tokens are parsed from newline-delimited JSON (NDJSON) chunks, accompanied by live token counters and rotating calm status messages ("Finding the main idea…", "Untangling the important bits…"). A visible **Cancel** button hooks directly into `AbortController`, aborting the stream cleanly without UI lockup.

### 3. Smart Section-Aware Content Extractor
To handle long articles without overwhelming local model contexts, `extractor.js` implements section-aware sampling for pages exceeding 12,000 characters: allocating 30% to introduction and overview, 50% to section headings and leading paragraphs, and 20% to conclusion and next steps.

### 4. Segmented Tab Navigation & Local Caching
To fit comfortably within Chrome's 384px popup dimensions:
- Results are organized into four clean tabs: `[✦ Gist]`, `[🗺 Visual Map]`, `[💡 Points]`, and `[✓ Actions]`.
- Summaries and visual diagrams are cached in `chrome.storage.local` with LRU eviction (capped at 30 entries). Revisiting an article loads the gist and visual map instantly, with a `↻ Re-read` button to bypass cache when needed.

---

## 5. Privacy & Security Architecture

1. **Zero External Calls**: Slothy's `host_permissions` in `manifest.json` are strictly scoped to `http://localhost:11434/*` and `http://127.0.0.1:11434/*`. No network traffic ever leaves your machine.
2. **Minimal Manifest V3 Permissions**: Only `activeTab`, `scripting`, and `storage` are used. No broad `<all_urls>` permission.
3. **Safe DOM Injection**: All dynamic AI outputs are rendered strictly using `textContent` and `createElement` (`replaceChildren`). No `innerHTML` is ever touched by model output.

---

## 6. Real-World Benchmarks & Evaluation

We evaluated Slothy with `gemma3:4b` across 10 representative web archetypes:

| # | Page Archetype | Example Target | Extractor Output | Latency | Speed | Action Items | Deadline Precision |
| :- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Technical Docs** | Chrome MV3 Migration Guide | Clean | 3.4s | 34.2 tok/s | 4 tasks | Correct ("Oct 2026") |
| 2 | **Community Post** | "Understanding CSS Grid" | Clean | 2.8s | 36.1 tok/s | 3 tasks | None (omitted correctly) |
| 3 | **Deep-Dive Article** | LLM Quantization Guide | Trimmed (14k) | 4.1s | 33.8 tok/s | 3 tasks | None |
| 4 | **Tutorial** | Dockerize Node.js App | Clean | 2.9s | 35.5 tok/s | 5 tasks | None |
| 5 | **Event / CFP** | DEV Hackathon 2026 Page | Clean | 3.1s | 34.9 tok/s | 3 tasks | Correct ("Oct 25, 2026") |
| 6 | **News Post** | Open-Source AI Release | Clean | 2.5s | 37.0 tok/s | 1 task | None |
| 7 | **API Reference** | MDN Fetch API | Clean | 2.7s | 36.4 tok/s | 2 tasks | None |
| 8 | **Changelog** | Tailwind CSS Release | Clean | 3.0s | 35.2 tok/s | 4 tasks | None |
| 9 | **Short Page** | Page with <180 chars | Blocked | N/A | N/A | Graceful error | N/A |
| 10 | **Internal Page** | `chrome://extensions` | Blocked | N/A | N/A | Helpful guidance | N/A |

### Observations:
- **Average latency**: ~3.1 seconds for full page analysis.
- **Generation throughput**: ~35.4 tokens/second on an ordinary developer workstation.
- **Hallucination check**: In all 10 tests, zero fabricated deadlines were introduced.

---

## 7. Limitations & Future Roadmap

- **WebGPU In-Browser Inference**: Exploring Chrome's built-in AI (Prompt API) and WebGPU-based Transformers.js to eliminate external server prerequisites for ultra-portable environments.
- **Side Panel Expansion**: Adding an optional Chrome Side Panel view for users who want wide, continuous diagram exploration while browsing side-by-side.
- **Custom Visual Types**: Adding timeline and sequence flowchart layouts for step-by-step algorithms and historic documentation.

---

## 8. Try It Out

- **Repository**: [GitHub — Slothy Extension](https://github.com/your-username/slothy)
- **Interactive Web Demo**: Open `index.html` locally or visit our project showcase page.
- **Quickstart**:
  ```bash
  # 1. Pull model
  ollama pull gemma3:4b
  
  # 2. Allow extension origin
  OLLAMA_ORIGINS="chrome-extension://*" ollama serve
  
  # 3. Load unpacked in chrome://extensions
  ```

---

*Take a deep breath, close twenty extra tabs, and enjoy reading again with Slothy.* 🦥🍃
