// Slothy: Slow down. Get the gist.
// Streaming AI, Visual Mind Maps, Summary Caching & Local Ollama Integration.

const DEFAULTS = {
  model: "gemma3:4b",
  ollamaUrl: "http://localhost:11434"
};

const MIN_CHARS = 180;
const CACHE_KEY = "slothy_cache";
const LOG_KEY = "slothy_log";
const MAX_CACHE_ENTRIES = 30;

const $ = (id) => document.getElementById(id);
const app = $("app");
const hasChrome = typeof chrome !== "undefined" && Boolean(chrome.tabs);
const hasStorage = typeof chrome !== "undefined" && Boolean(chrome.storage?.local);

let settings = { ...DEFAULTS };
let currentTab = null;
let lastResult = null;
let currentAbortController = null;
let loadingInterval = null;

// Pan & Zoom state for Visual Mind Map
let mapZoom = 1;
let mapPan = { x: 0, y: 0 };
let isPanning = false;
let startPan = { x: 0, y: 0 };

// Brand-appropriate calm progress messages
const PROGRESS_MESSAGES = [
  "Finding the main idea…",
  "Untangling the important bits…",
  "Connecting the dots…",
  "Mapping core concepts…",
  "Taking the slow lane…"
];

// Normalize URL for caching (strip fragment/hash)
function canonicalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url || "";
  }
}

// Clean deadline values: models sometimes output "null", "none", "N/A", "false"
function sanitizeDeadline(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (/^(null|none|n\/?a|undefined|false|no deadline)$/i.test(s)) return null;
  return s.length > 0 ? s : null;
}

// Visual Data Contract Validator
function validateVisualData(visual, fallbackTitle) {
  if (!visual || typeof visual !== "object") return null;

  const validTypes = ["mindmap", "flowchart", "conceptmap"];
  const type = validTypes.includes(visual.type) ? visual.type : "mindmap";
  const central_topic = String(visual.central_topic || fallbackTitle || "Main Subject").slice(0, 60);

  if (!Array.isArray(visual.nodes) || visual.nodes.length < 2) {
    return null;
  }

  // Sanitize nodes (limit between 2 and 10 for optimal popup view)
  const sanitizedNodes = [];
  const nodeIds = new Set();

  for (const n of visual.nodes.slice(0, 9)) {
    const id = String(n.id || `node-${sanitizedNodes.length + 1}`).trim();
    const label = String(n.label || "").trim().slice(0, 48);
    const desc = n.description ? String(n.description).trim().slice(0, 200) : "";
    if (label && !nodeIds.has(id)) {
      nodeIds.add(id);
      sanitizedNodes.push({
        id,
        label,
        parent_id: n.parent_id && nodeIds.has(String(n.parent_id)) ? String(n.parent_id) : null,
        description: desc
      });
    }
  }

  if (sanitizedNodes.length < 2) return null;

  // Sanitize edges
  const sanitizedEdges = [];
  if (Array.isArray(visual.edges)) {
    for (const e of visual.edges.slice(0, 14)) {
      const source = String(e.source || "").trim();
      const target = String(e.target || "").trim();
      const relationship = e.relationship ? String(e.relationship).trim().slice(0, 25) : "";
      if (nodeIds.has(source) && nodeIds.has(target) && source !== target) {
        sanitizedEdges.push({ source, target, relationship });
      }
    }
  }

  return {
    type,
    central_topic,
    nodes: sanitizedNodes,
    edges: sanitizedEdges
  };
}

// Multi-stage resilient JSON parser
function parseModelJson(raw, pageTitle) {
  let cleaned = String(raw || "").trim();

  // Strip markdown fences
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Find outermost JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    const summary = String(parsed.summary || "").trim();
    const takeaways = Array.isArray(parsed.takeaways)
      ? parsed.takeaways.map((t) => String(t || "").trim()).filter(Boolean)
      : [];
    const action_items = Array.isArray(parsed.action_items)
      ? parsed.action_items
        .map((item) => ({
          task: String(item?.task || item?.action || "").trim(),
          due: sanitizeDeadline(item?.due || item?.deadline)
        }))
        .filter((item) => item.task.length > 0)
      : [];

    const visual = validateVisualData(parsed.visual, pageTitle);

    return {
      summary: summary || "No explicit summary text was provided.",
      takeaways,
      action_items,
      visual,
      fallbackUsed: false
    };
  } catch (err) {
    console.warn("JSON.parse failed on model output; applying fallback parser", err);
    return fallbackTextParse(raw, pageTitle);
  }
}

// Fallback parser if raw response isn't strict JSON
function fallbackTextParse(raw, pageTitle) {
  const text = String(raw || "").trim();
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let summary = "";
  const takeaways = [];
  const action_items = [];

  for (const line of lines) {
    if (/^[•\-\*]\s*\[?\s*\]?\s*/.test(line)) {
      const item = line.replace(/^[•\-\*]\s*(\[[ xX]?\]\s*)?/, "").trim();
      if (/due|by|before|deadline/i.test(item)) {
        action_items.push({ task: item, due: null });
      } else {
        takeaways.push(item);
      }
    } else if (!summary && line.length > 30 && !/^#/.test(line)) {
      summary = line;
    }
  }

  // Construct a minimal visual outline fallback from takeaways
  const fallbackNodes = takeaways.slice(0, 4).map((t, idx) => ({
    id: `concept-${idx + 1}`,
    label: t.slice(0, 35),
    parent_id: null,
    description: t
  }));

  const visual = fallbackNodes.length >= 2 ? {
    type: "mindmap",
    central_topic: pageTitle || "Overview",
    nodes: fallbackNodes,
    edges: []
  } : null;

  return {
    summary: summary || text.slice(0, 400),
    takeaways: takeaways.slice(0, 5),
    action_items: action_items.slice(0, 5),
    visual,
    fallbackUsed: true
  };
}

// Settings Persistence
async function loadSettings() {
  if (!hasStorage) return;
  try {
    const saved = await chrome.storage.local.get(["model", "ollamaUrl"]);
    settings = {
      model: saved.model || DEFAULTS.model,
      ollamaUrl: saved.ollamaUrl || DEFAULTS.ollamaUrl
    };
  } catch (e) {
    console.warn("Failed to load settings:", e);
  }
}

// Cache Management (chrome.storage.local)
async function getCachedSummary(url) {
  if (!hasStorage || !url) return null;
  try {
    const key = canonicalizeUrl(url);
    const store = await chrome.storage.local.get(CACHE_KEY);
    const cache = store[CACHE_KEY] || {};
    const entry = cache[key];
    if (entry && entry.result && entry.data) {
      return entry;
    }
  } catch (e) {
    console.warn("Cache lookup error:", e);
  }
  return null;
}

async function saveCachedSummary(url, page, result) {
  if (!hasStorage || !url || !result || result.fallbackUsed) return;
  try {
    const key = canonicalizeUrl(url);
    const store = await chrome.storage.local.get(CACHE_KEY);
    const cache = store[CACHE_KEY] || {};

    cache[key] = {
      url: key,
      title: page.title,
      model: settings.model,
      timestamp: Date.now(),
      page: { title: page.title, url: page.url, byline: page.byline, truncated: page.truncated },
      data: result.data,
      metrics: result.metrics
    };

    // Bound cache size (LRU eviction of oldest entries)
    const keys = Object.keys(cache);
    if (keys.length > MAX_CACHE_ENTRIES) {
      keys.sort((a, b) => (cache[a].timestamp || 0) - (cache[b].timestamp || 0));
      while (keys.length > MAX_CACHE_ENTRIES) {
        delete cache[keys.shift()];
      }
    }

    await chrome.storage.local.set({ [CACHE_KEY]: cache });
  } catch (e) {
    console.warn("Could not save to cache:", e);
  }
}

async function clearCache() {
  const msgEl = $("settingsMsg");
  if (!hasStorage) return;
  try {
    await chrome.storage.local.remove(CACHE_KEY);
    $("cachedPill").hidden = true;
    msgEl.className = "settings-msg";
    msgEl.textContent = "Cache cleared!";
    msgEl.hidden = false;
    setTimeout(() => { msgEl.hidden = true; }, 2000);
  } catch (e) {
    msgEl.className = "settings-msg err";
    msgEl.textContent = "Could not clear cache.";
    msgEl.hidden = false;
  }
}

async function logRun(entry) {
  if (!hasStorage) return;
  try {
    const saved = await chrome.storage.local.get(LOG_KEY);
    const logs = Array.isArray(saved[LOG_KEY]) ? saved[LOG_KEY] : [];
    logs.push(entry);
    await chrome.storage.local.set({ [LOG_KEY]: logs.slice(-100) });
  } catch (e) {
    console.warn("Could not save benchmark metric:", e);
  }
}

// UI State Management
function setState(state) {
  app.dataset.state = state;
  $("idleView").hidden = state !== "idle";
  $("loadingView").hidden = state !== "loading";
  $("errorView").hidden = state !== "error";
  $("resultView").hidden = state !== "result";

  const btn = $("summarizeBtn");
  const btnText = $("summarizeBtnText");

  if (state === "loading") {
    btn.disabled = true;
    btnText.textContent = "Thinking slowly…";
    startRotatingLoadingText();
  } else {
    btn.disabled = false;
    stopRotatingLoadingText();
    if (state === "result") {
      btnText.textContent = "Get the gist again";
    } else {
      btnText.textContent = "Get the gist";
    }
  }
}

function startRotatingLoadingText() {
  stopRotatingLoadingText();
  let idx = 0;
  const el = $("loadingText");
  el.textContent = PROGRESS_MESSAGES[0];
  loadingInterval = setInterval(() => {
    idx = (idx + 1) % PROGRESS_MESSAGES.length;
    el.textContent = PROGRESS_MESSAGES[idx];
  }, 2200);
}

function stopRotatingLoadingText() {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
}

function showError(title, message, isCors = false) {
  $("errorTitle").textContent = title;
  $("errorBody").textContent = message;
  const setupCard = $("corsSetupCard");
  if (setupCard) setupCard.hidden = !isCors;
  setState("error");
}

function showCorsSetup(msg) {
  showError(
    "Ollama origin blocked (CORS)",
    msg || "Ollama is running, but requests from this Chrome extension are blocked by Ollama's origin allowlist.",
    true
  );
}

// Lightweight startup check: ONLY queries GET /api/tags (no heavy POST inference probe)
async function checkOllama() {
  const status = $("status");
  const statusText = $("statusText");
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const models = Array.isArray(payload.models) ? payload.models : [];

    // Populate model select in settings drawer
    populateModelSelect(models);

    const modelTag = settings.model.toLowerCase();
    const found = models.some((m) => {
      const name = (m.name || "").toLowerCase();
      return name === modelTag || name.startsWith(`${modelTag}:`);
    });

    if (found) {
      status.dataset.ok = "true";
      statusText.textContent = `${settings.model} ready`;
      status.title = `Model '${settings.model}' is available locally.`;
      if (app.dataset.state === "error") {
        setState("idle");
      }
    } else if (models.length > 0) {
      // Configured model missing, but other models exist
      status.dataset.ok = "false";
      statusText.textContent = "Model missing";
      status.title = `Model '${settings.model}' not found. Installed: ${models.map(m => m.name).join(", ")}`;
    } else {
      status.dataset.ok = "false";
      statusText.textContent = "No models";
      status.title = "No models installed in local Ollama.";
    }
  } catch {
    status.dataset.ok = "false";
    statusText.textContent = "Ollama offline";
    status.title = `Cannot reach ${settings.ollamaUrl}. Make sure Ollama is running.`;
  }
}

function populateModelSelect(models) {
  const select = $("modelSelect");
  if (!select) return;

  const currentVal = settings.model;
  select.innerHTML = "";

  models.forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.name;
    opt.textContent = `${m.name} (${(m.size ? (m.size / 1e9).toFixed(1) + "GB" : "installed")})`;
    if (m.name === currentVal) opt.selected = true;
    select.appendChild(opt);
  });

  const customOpt = document.createElement("option");
  customOpt.value = "custom";
  customOpt.textContent = "Custom model name…";
  select.appendChild(customOpt);

  if (!models.some(m => m.name === currentVal)) {
    customOpt.selected = true;
    $("modelInput").style.display = "block";
  } else {
    $("modelInput").style.display = "none";
  }
}

async function updateTabContext() {
  const contextTitle = $("contextTitle");
  if (!hasChrome) {
    contextTitle.textContent = "Demo environment (Load unpacked in Chrome)";
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;
    if (!tab?.url) {
      contextTitle.textContent = "No active page found";
      return;
    }

    if (/^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)) {
      contextTitle.textContent = "Internal browser page (Open a regular website)";
      return;
    }

    const host = new URL(tab.url).hostname.replace(/^www\./, "");
    contextTitle.textContent = `${tab.title || host} (${host})`;

    // Check if this page is already cached locally
    const cached = await getCachedSummary(tab.url);
    if (cached) {
      $("cachedPill").hidden = false;
      render(cached.page, { data: cached.data, metrics: { ...cached.metrics, cached: true }, jsonFallback: false });
    } else {
      $("cachedPill").hidden = true;
    }
  } catch {
    contextTitle.textContent = "Current webpage";
  }
}

async function getPageText() {
  if (!hasChrome || !chrome.scripting) {
    throw new Error("Load Slothy as an unpacked extension in Chrome to read the active page.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url || "")) {
    throw new Error("Slothy can't read browser-internal pages. Open a public article, tutorial, or docs page and try again.");
  }

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractPageContent
  });

  const page = injection?.[0]?.result;
  const text = String(page?.text || "").trim();

  if (text.length < MIN_CHARS) {
    throw new Error(`There isn't enough readable text on this page to summarize (Found ${text.length} chars, requires at least 180).`);
  }

  return {
    title: page.title || tab.title || "Untitled Webpage",
    url: page.url || tab.url || "",
    byline: page.byline || "",
    text,
    truncated: Boolean(page.truncated),
    truncatedReason: page.truncatedReason || "",
    originalChars: page.originalChars || text.length,
    charsSent: page.charsSent || text.length
  };
}

const SYSTEM_PROMPT = `You are Slothy, a calm, precise visual reading assistant.
Summarize the webpage and construct a conceptual mind map / visual representation.
You MUST output valid JSON strictly adhering to this schema:
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

RULES:
1. Ground everything strictly in the text. Never hallucinate facts, deadlines, or tasks.
2. If there are no action items, return an empty array for action_items: [].
3. For visual.nodes, produce 4 to 8 high-signal concept nodes.
4. "due" MUST be null (not string "null") unless explicitly stated in the source text.
5. Return valid JSON only.`;

// Streaming Ollama Generation with AbortController
async function askOllamaStreaming(page, onTokenUpdate, useJson = true) {
  const started = performance.now();
  currentAbortController = new AbortController();

  let response;
  try {
    response = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        model: settings.model,
        stream: true,
        format: "json",
        options: {
          temperature: 0.15,
          num_ctx: 8192
        },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
content: (() => {
            const maxChars = Math.floor((8192 - 1500) * 3);
            const txt = page.text;
            if (txt.length <= maxChars) return `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${txt}`;
            const part = Math.floor(maxChars / 3);
            const head = txt.slice(0, part);
            const tail = txt.slice(-part);
            const middleStart = Math.floor((txt.length - part) / 2);
            const middle = txt.slice(middleStart, middleStart + part);
            return `Title: ${page.title}\nURL: ${page.url}\n\nContent:\n${head}\n...\n${middle}\n...\n${tail}`;
          })()          }
        ]
      })
    });
  } catch (netErr) {
    if (netErr.name === "AbortError" || currentAbortController?.signal.aborted) {
      throw netErr;
    }
    console.error("Fetch to Ollama failed:", netErr);
    const err = new Error("Failed to connect to Ollama. Check if the server is running.");
    err.isCors = true;
    err.status = 403;
    throw err;
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const err = new Error(bodyText ? `HTTP ${response.status}: ${bodyText}` : `Ollama returned HTTP ${response.status}`);
    err.status = response.status;
    err.bodyText = bodyText;
    throw err;
  }

  // Stream reader with NDJSON buffer handling
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let accumulatedRaw = "";
  let evalCount = 0;
  let totalDuration = 0;
  let evalDuration = 0;
  let promptEvalCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep trailing incomplete fragment in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const chunk = JSON.parse(trimmed);
          if (chunk.message?.content) {
            accumulatedRaw += chunk.message.content;
            evalCount = chunk.eval_count || (evalCount + 1);
            if (onTokenUpdate) onTokenUpdate(evalCount);
          }
          if (chunk.done) {
            totalDuration = chunk.total_duration ? chunk.total_duration / 1e9 : 0;
            evalDuration = chunk.eval_duration ? chunk.eval_duration / 1e9 : 0;
            evalCount = chunk.eval_count || evalCount;
            promptEvalCount = chunk.prompt_eval_count || 0;
          }
        } catch {
          // ignore malformed NDJSON lines
        }
      }
    }

    // Flush any remaining line
    if (buffer.trim()) {
      try {
        const chunk = JSON.parse(buffer.trim());
        if (chunk.message?.content) accumulatedRaw += chunk.message.content;
      } catch { }
    }
  } catch (streamErr) {
    if (streamErr.name === "AbortError" || currentAbortController?.signal.aborted) {
      throw streamErr;
    }
    throw streamErr;
  } finally {
    currentAbortController = null;
  }

  const durationSec = totalDuration || (performance.now() - started) / 1000;
  const metrics = {
    seconds: durationSec,
    promptTokens: promptEvalCount,
    outputTokens: evalCount,
    tokensPerSec: evalDuration > 0 && evalCount > 0 ? evalCount / evalDuration : (evalCount / durationSec)
  };
  // Log request details
  console.log(`[Ollama] prompt_eval=${promptEvalCount} eval=${evalCount} num_ctx=8192 json=${useJson}`);
    if (!accumulatedRaw.trim()) {
    const err = new Error("Ollama returned an empty response. Try a shorter article or another model.");
    err.emptyOutput = true;
    throw err;
  }

  const parsed = parseModelJson(accumulatedRaw, page.title);
  // Check for empty/insufficient summary
  if (
    evalCount < 30 ||
    !parsed.summary ||
    !parsed.summary.trim() ||
    parsed.summary === "No explicit summary text was provided."
  ) {
    if (useJson) {
      // Retry without JSON format
      return await askOllamaStreaming(page, onTokenUpdate, false);
    } else {
      const err = new Error("The model returned an empty answer. Try again or use a shorter page.");
      err.emptyOutput = true;
      throw err;
    }
  }

  return {
    data: parsed,
    metrics,
    jsonFallback: parsed.fallbackUsed
  };

  contentGroup.innerHTML = "";
  outlineList.innerHTML = "";

  if (!visual || !visual.nodes || visual.nodes.length < 2) {
    svg.style.display = "none";
    fallbackBox.hidden = false;
    return;
  }

  svg.style.display = "block";
  fallbackBox.hidden = true;

  // Set visual type chip
  $("mapTypeChip").textContent = visual.type === "flowchart" ? "Flowchart" : (visual.type === "conceptmap" ? "Concept Map" : "Mind Map");

  // Center coordinate
  const cx = 260;
  const cy = 150;
  const centralTitle = visual.central_topic || centralFallback || "Central Idea";
  $("mapCentralHint").textContent = centralTitle;

  // 1. Arrange nodes radially around the center
  const nodes = visual.nodes;
  const total = nodes.length;
  const rx = 180;
  const ry = 100;

  const positions = {};

  nodes.forEach((node, idx) => {
    // Distribute angles evenly, offsetting slightly for aesthetic balance
    const angle = (idx / total) * 2 * Math.PI - Math.PI / 2;
    const x = Math.round(cx + rx * Math.cos(angle));
    const y = Math.round(cy + ry * Math.sin(angle));
    positions[node.id] = { x, y, node };

    // Build accessibility outline
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = node.label;
    li.appendChild(strong);
    if (node.description) {
      const span = document.createElement("span");
      span.textContent = node.description;
      li.appendChild(span);
    }
    outlineList.appendChild(li);
  });

  // 2. Draw Edges
  // A. Connect Central Topic to root nodes (or all top-level nodes)
  nodes.forEach((node) => {
    const pos = positions[node.id];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // Curved Bezier from center to node
    const mx = (cx + pos.x) / 2;
    const my = (cy + pos.y) / 2;
    path.setAttribute("d", `M ${cx} ${cy} Q ${mx} ${my - 10} ${pos.x} ${pos.y}`);
    path.setAttribute("class", "svg-edge");
    contentGroup.appendChild(path);
  });

  // B. Draw declared relationship edges
  if (Array.isArray(visual.edges)) {
    visual.edges.forEach((edge) => {
      const p1 = positions[edge.source];
      const p2 = positions[edge.target];
      if (p1 && p2) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;
        path.setAttribute("d", `M ${p1.x} ${p1.y} Q ${mx + 10} ${my - 15} ${p2.x} ${p2.y}`);
        path.setAttribute("class", "svg-edge");
        path.setAttribute("marker-end", "url(#arrow)");
        contentGroup.appendChild(path);

        if (edge.relationship) {
          const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
          txt.setAttribute("x", mx);
          txt.setAttribute("y", my - 8);
          txt.setAttribute("class", "svg-edge-label");
          txt.textContent = edge.relationship;
          contentGroup.appendChild(txt);
        }
      }
    });
  }

  // 3. Draw Central Node
  const centralG = document.createElementNS("http://www.w3.org/2000/svg", "g");
  centralG.setAttribute("class", "svg-node central");

  const cWidth = Math.min(180, Math.max(110, centralTitle.length * 8));
  const cHeight = 36;
  const cRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  cRect.setAttribute("x", cx - cWidth / 2);
  cRect.setAttribute("y", cy - cHeight / 2);
  cRect.setAttribute("width", cWidth);
  cRect.setAttribute("height", cHeight);
  centralG.appendChild(cRect);

  const cText = document.createElementNS("http://www.w3.org/2000/svg", "text");
  cText.setAttribute("x", cx);
  cText.setAttribute("y", cy);
  cText.textContent = centralTitle.length > 24 ? centralTitle.slice(0, 22) + "…" : centralTitle;
  centralG.appendChild(cText);

  centralG.addEventListener("click", () => {
    inspectNode(centralTitle, "Central topic of this article summary.");
  });

  contentGroup.appendChild(centralG);

  // 4. Draw Concept Nodes
  nodes.forEach((node) => {
    const pos = positions[node.id];
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "svg-node");
    g.setAttribute("data-id", node.id);

    const nWidth = Math.min(130, Math.max(75, node.label.length * 7.2));
    const nHeight = 28;

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", pos.x - nWidth / 2);
    rect.setAttribute("y", pos.y - nHeight / 2);
    rect.setAttribute("width", nWidth);
    rect.setAttribute("height", nHeight);
    g.appendChild(rect);

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", pos.x);
    text.setAttribute("y", pos.y);
    text.textContent = node.label.length > 18 ? node.label.slice(0, 16) + "…" : node.label;
    g.appendChild(text);

    g.addEventListener("click", () => {
      document.querySelectorAll(".svg-node").forEach((el) => el.classList.remove("selected"));
      g.classList.add("selected");
      inspectNode(node.label, node.description || "Key supporting concept.");
    });

    contentGroup.appendChild(g);
  });

  applySvgTransform();
}

function inspectNode(label, description) {
  const inspector = $("nodeInspector");
  $("nodeInspLabel").textContent = label;
  $("nodeInspDesc").textContent = description;
  inspector.hidden = false;
}

function applySvgTransform() {

  if (!contentGroup) return;
  contentGroup.setAttribute(
    "transform",
    `translate(${mapPan.x}, ${mapPan.y}) scale(${mapZoom})`
  );
}

// Render Results State
function render(page, result) {
  const { data, metrics, jsonFallback } = result;

  $("pageTitle").textContent = page.title;
  const bylineEl = $("pageByline");
  if (page.byline) {
    bylineEl.textContent = `By ${page.byline}`;
    bylineEl.hidden = false;
  } else {
    bylineEl.hidden = true;
  }

  // 1. Gist Summary
  $("summary").textContent = data.summary || "No summary was generated.";

  // 2. Visual Mind Map
  renderMindmapSvg(data.visual, page.title);

  // 3. Takeaways
  const takeawaysList = $("takeaways");
  takeawaysList.replaceChildren(
    ...data.takeaways.map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    })
  );
  $("takeawaysPanel").hidden = data.takeaways.length === 0;

  // 4. Action Items
  const actionsList = $("actions");
  actionsList.replaceChildren(
    ...data.action_items.map((item, idx) => {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = `action-${idx}`;

      const label = document.createElement("label");
      label.htmlFor = cb.id;
      label.textContent = item.task;

      li.append(cb, label);

      if (item.due) {
        const dueSpan = document.createElement("span");
        dueSpan.className = "due";
        dueSpan.textContent = item.due;
        li.append(dueSpan);
      }
      return li;
    })
  );
  $("actionsNone").hidden = data.action_items.length > 0;

  // Metadata
  const metaParts = [
    settings.model,
    metrics.cached ? "⚡ cached" : `${metrics.seconds.toFixed(1)}s`
  ];
  if (metrics.outputTokens > 0) metaParts.push(`${metrics.outputTokens} tok`);
  if (metrics.tokensPerSec > 0) metaParts.push(`${metrics.tokensPerSec.toFixed(1)} tok/s`);
  if (page.truncated) metaParts.push("sampled sections");
  if (jsonFallback) metaParts.push("fallback parser");
  $("meta").textContent = metaParts.join(" · ");

  lastResult = { page, data, metrics };

  // Default to Gist tab on initial render
  activateTab("tabGist");
  setState("result");
}

function activateTab(tabId) {
  const tabs = document.querySelectorAll(".nav-tab");
  const panels = document.querySelectorAll(".tab-panel");

  tabs.forEach((tab) => {
    const isActive = tab.id === tabId;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    const targetPanelId = tab.dataset.panel;
    const panel = $(targetPanelId);
    if (panel) {
      panel.hidden = !isActive;
      panel.classList.toggle("active", isActive);
    }
  });
}

// Main Execution Workflow
async function run(bypassCache = false) {
  // If not forcing bypass, check cache first
  if (!bypassCache && currentTab?.url) {
    const cached = await getCachedSummary(currentTab.url);
    if (cached) {
      $("cachedPill").hidden = false;
      render(cached.page, { data: cached.data, metrics: { ...cached.metrics, cached: true }, jsonFallback: false });
      return;
    }
  }

  setState("loading");
  $("loadingText").textContent = "Extracting article content…";
  $("streamProgress").hidden = true;
  $("cachedPill").hidden = true;

  let page;
  try {
    page = await getPageText();
  } catch (extractError) {
    console.error("Extraction error:", extractError);
    showError("Could not read page", extractError.message || "Failed to extract readable content from this tab.");
    return;
  }

  $("streamProgress").hidden = false;
  $("streamTokens").textContent = "0";

  try {
    const result = await askOllamaStreaming(page, (tokenCount) => {
      $("streamTokens").textContent = String(tokenCount);
    });

    render(page, result);

    // Save successful execution to cache
    await saveCachedSummary(page.url, page, result);

    await logRun({
      timestamp: Date.now(),
      url: page.url,
      model: settings.model,
      seconds: result.metrics.seconds,
      promptTokens: result.metrics.promptTokens,
      outputTokens: result.metrics.outputTokens,
      tokensPerSec: result.metrics.tokensPerSec,
      truncated: page.truncated,
      charsSent: page.charsSent,
      originalChars: page.originalChars,
      jsonFallback: result.jsonFallback
    });
  } catch (ollamaError) {
    if (ollamaError.name === "AbortError") {
      console.log("Generation cancelled by user.");
      setState(lastResult ? "result" : "idle");
      return;
    }

    console.error("Ollama query error:", ollamaError);
    if (ollamaError.status === 403 || ollamaError.isCors) {
      showCorsSetup("Ollama blocked the extension's origin. Fully quit Ollama (tray icon + any ollama.exe in Task Manager), then relaunch.");
    } else if (ollamaError.status === 404) {
      showError(
        "Model not found",
        `Model '${settings.model}' is not installed.\nIn your terminal, run:\nollama pull ${settings.model}`,
        false
      );
    } else if (ollamaError.status) {
      showError(
        `Ollama HTTP ${ollamaError.status}`,
        ollamaError.bodyText || ollamaError.message || `Request failed with status ${ollamaError.status}`,
        false
      );
    } else {
      showError(
        "Ollama connection error",
        ollamaError.message || "Could not complete inference with local Ollama.",
        false
      );
    }
  }
}

// Copy Handlers
async function copyResult() {
  if (!lastResult) return;
  const { page, data } = lastResult;

  const lines = [
    `# ${page.title}`,
    page.url,
    "",
    "## The Gist",
    data.summary,
    ""
  ];

  if (data.takeaways.length > 0) {
    lines.push("## Key Takeaways");
    data.takeaways.forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }

  if (data.visual && data.visual.nodes) {
    lines.push(`## Visual Map: ${data.visual.central_topic}`);
    data.visual.nodes.forEach((n) => {
      lines.push(`- **${n.label}**: ${n.description || "Core concept"}`);
    });
    lines.push("");
  }

  if (data.action_items.length > 0) {
    lines.push("## Action Items");
    data.action_items.forEach((item) => {
      const dueStr = item.due ? ` (Due: ${item.due})` : "";
      lines.push(`- [ ] ${item.task}${dueStr}`);
    });
    lines.push("");
  }

  lines.push("---");
  lines.push(`*Generated locally by Slothy with ${settings.model}*`);

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    const copyBtn = $("copyBtn");
    copyBtn.textContent = "Copied Gist!";
    setTimeout(() => { copyBtn.textContent = "Copy Gist"; }, 1500);
  } catch {
    showError("Clipboard blocked", "Could not write to clipboard. You can select and copy the text manually.");
  }
}

async function copyActionsOnly() {
  if (!lastResult || !lastResult.data.action_items.length) {
    const btn = $("copyActionsBtn");
    btn.textContent = "No actions";
    setTimeout(() => { btn.textContent = "Copy Tasks"; }, 1200);
    return;
  }

  const lines = lastResult.data.action_items.map((item) => {
    const dueStr = item.due ? ` (Due: ${item.due})` : "";
    return `- [ ] ${item.task}${dueStr}`;
  });

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    const btn = $("copyActionsBtn");
    btn.textContent = "Copied Tasks!";
    setTimeout(() => { btn.textContent = "Copy Tasks"; }, 1500);
  } catch {
    showError("Clipboard blocked", "Could not copy tasks to clipboard.");
  }
}

// Settings Saving
async function saveSettings() {
  const selectVal = $("modelSelect").value;
  const customVal = $("modelInput").value.trim();
  const modelVal = selectVal === "custom" ? (customVal || DEFAULTS.model) : (selectVal || DEFAULTS.model);
  const urlVal = $("urlInput").value.trim().replace(/\/+$/, "") || DEFAULTS.ollamaUrl;
  const msgEl = $("settingsMsg");

  if (!/^https?:\/\//i.test(urlVal)) {
    msgEl.className = "settings-msg err";
    msgEl.textContent = "URL must start with http:// or https://";
    msgEl.hidden = false;
    return;
  }

  settings = { model: modelVal, ollamaUrl: urlVal };
  if (hasStorage) {
    await chrome.storage.local.set(settings);
  }

  msgEl.className = "settings-msg";
  msgEl.textContent = `Saved! Using ${settings.model}`;
  msgEl.hidden = false;
  setTimeout(() => { msgEl.hidden = true; }, 2000);

  await checkOllama();
}

// Fallback Diagnostic Tool (runs GET and POST probes when explicitly requested)
async function testConnection() {
  const msgEl = $("settingsMsg");
  msgEl.className = "settings-msg";
  msgEl.textContent = "Testing connection to Ollama…";
  msgEl.hidden = false;

  let tagsOk = false;
  let tagsMsg = "";
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/tags`);
    if (res.ok) {
      tagsOk = true;
      tagsMsg = `HTTP ${res.status} OK`;
    } else {
      tagsMsg = `HTTP ${res.status} (${res.statusText || "Failed"})`;
    }
  } catch (e) {
    tagsMsg = e.message || "Failed to fetch";
  }

  let chatOk = false;
  let chatMsg = "";
  try {
    const res = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        messages: [{ role: "user", content: "ping" }]
      })
    });
    if (res.ok) {
      chatOk = true;
      chatMsg = `HTTP ${res.status} OK`;
    } else if (res.status === 403) {
      chatMsg = `HTTP 403 Forbidden (Origin blocked)\n  • Windows: setx OLLAMA_ORIGINS "chrome-extension://*"\n  • Fully quit Ollama (tray icon + Task Manager), then relaunch.\n  • Mac/Linux: OLLAMA_ORIGINS="chrome-extension://*" ollama serve`;
    } else {
      const bodyTxt = await res.text().catch(() => "");
      chatMsg = `HTTP ${res.status} (${res.statusText || bodyTxt || "Error"})`;
    }
  } catch (e) {
    chatMsg = `Failed to fetch (Check server / CORS)\n  • Windows: setx OLLAMA_ORIGINS "chrome-extension://*"`;
  }

  if (tagsOk && chatOk) {
    msgEl.className = "settings-msg";
    msgEl.textContent = `✅ All checks passed!\n• GET /api/tags: ${tagsMsg}\n• POST /api/chat: ${chatMsg}`;
  } else {
    msgEl.className = "settings-msg err";
    msgEl.textContent = `Diagnostic Report:\n• GET /api/tags: ${tagsOk ? "✅ " + tagsMsg : "❌ " + tagsMsg}\n• POST /api/chat: ${chatOk ? "✅ " + chatMsg : "❌ " + chatMsg}`;
  }
}

async function exportLogs() {
  const msgEl = $("settingsMsg");
  if (!hasStorage) {
    msgEl.className = "settings-msg err";
    msgEl.textContent = "Storage not available in demo mode.";
    msgEl.hidden = false;
    return;
  }

  try {
    const saved = await chrome.storage.local.get(LOG_KEY);
    const logs = saved[LOG_KEY] || [];
    const formatted = JSON.stringify(logs, null, 2);
    await navigator.clipboard.writeText(formatted);

    msgEl.className = "settings-msg";
    msgEl.textContent = `Copied ${logs.length} benchmark run(s) as JSON!`;
    msgEl.hidden = false;
    setTimeout(() => { msgEl.hidden = true; }, 2500);
  } catch (err) {
    msgEl.className = "settings-msg err";
    msgEl.textContent = "Could not copy benchmark metrics.";
    msgEl.hidden = false;
  }
}

// Pan & Zoom event handlers for Mind Map SVG
function initSvgInteractions() {
  const viewport = $("svgViewport");
  if (!viewport) return;

  viewport.addEventListener("mousedown", (e) => {
    if (e.target.closest(".svg-node")) return; // let node click handle inspection
    isPanning = true;
    startPan = { x: e.clientX - mapPan.x, y: e.clientY - mapPan.y };
  });

  window.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    mapPan = { x: e.clientX - startPan.x, y: e.clientY - startPan.y };
    applySvgTransform();
  });

  window.addEventListener("mouseup", () => {
    isPanning = false;
  });

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    mapZoom = Math.min(2.5, Math.max(0.6, mapZoom + delta));
    applySvgTransform();
  }, { passive: false });

  $("zoomInBtn")?.addEventListener("click", () => {
    mapZoom = Math.min(2.5, mapZoom + 0.2);
    applySvgTransform();
  });

  $("zoomOutBtn")?.addEventListener("click", () => {
    mapZoom = Math.max(0.6, mapZoom - 0.2);
    applySvgTransform();
  });

  $("zoomResetBtn")?.addEventListener("click", () => {
    mapZoom = 1;
    mapPan = { x: 0, y: 0 };
    applySvgTransform();
  });

  $("outlineToggleBtn")?.addEventListener("click", () => {
    const outline = $("mapOutline");
    const svg = $("mindmapSvg");
  const contentGroup = $("svgContentGroup");
  const outlineList = $("outlineList");
  const fallbackBox = $("fallbackBox");
    const isShowing = !outline.hidden;
    outline.hidden = isShowing;
    svg.style.display = isShowing ? "block" : "none";
    $("outlineToggleBtn").textContent = isShowing ? "Outline" : "Diagram";
  });

  $("nodeInspClose")?.addEventListener("click", () => {
    $("nodeInspector").hidden = true;
  });

  $("viewMapFromHintBtn")?.addEventListener("click", () => {
    activateTab("tabMap");
  });
}

// Tab navigation listeners
function initTabNavigation() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activateTab(tab.id);
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();

  $("urlInput").value = settings.ollamaUrl;
  $("modelInput").value = settings.model;

  $("modelSelect")?.addEventListener("change", (e) => {
    if (e.target.value === "custom") {
      $("modelInput").style.display = "block";
      $("modelInput").focus();
    } else {
      $("modelInput").style.display = "none";
      $("modelInput").value = e.target.value;
    }
  });

  $("summarizeBtn").addEventListener("click", () => run(false));
  $("regenBtn")?.addEventListener("click", () => run(true));
  $("cancelBtn")?.addEventListener("click", () => {
    if (currentAbortController) currentAbortController.abort();
  });

  $("copyBtn").addEventListener("click", copyResult);
  $("copyActionsBtn")?.addEventListener("click", copyActionsOnly);
  $("saveSettings").addEventListener("click", saveSettings);
  $("exportLogsBtn").addEventListener("click", exportLogs);
  $("clearCacheBtn")?.addEventListener("click", clearCache);
  $("testConnBtn")?.addEventListener("click", testConnection);

  $("retryBtn")?.addEventListener("click", async () => {
    setState("loading");
    $("loadingText").textContent = "Re-checking Ollama connection…";
    await checkOllama();
  });

  $("retryMapBtn")?.addEventListener("click", () => run(true));

  $("openWindowBtn").addEventListener("click", () => {
    if (chrome && chrome.windows && chrome.windows.create) {
      chrome.windows.create({
        url: chrome.runtime.getURL("popup.html"),
        type: "normal",
        width: 440,
        height: 580,
        focused: true
      });
    } else {
      console.warn("chrome.windows API not available – cannot open resizable window.");
    }
  });

  initTabNavigation();
  initSvgInteractions();

  setState("idle");
  updateTabContext();
  checkOllama();
});
