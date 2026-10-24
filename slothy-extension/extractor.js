// Slothy Intelligent Article Extractor
// Clean, robust content extraction for Chrome extension scripting.
// Extracts clean article text, preserves headings/lists, and implements section-aware sampling for long pages.

function extractPageContent() {
  const url = window.location.href;
  const title = (document.title || "").trim();
  const hostname = window.location.hostname;

  if (!document.body) {
    return { title, url, text: "", originalChars: 0, byline: "", truncated: false };
  }

  // 1. Identify best article container in the live document
  const articleCandidates = [
    document.querySelector("article"),
    document.querySelector("[role='main']"),
    document.querySelector("main"),
    document.querySelector("#content"), // Wikipedia, docs
    document.querySelector("#mw-content-text"), // Wikipedia article body
    document.querySelector(".article-content"),
    document.querySelector(".post-content"),
    document.querySelector(".entry-content"),
    document.body
  ];

  const mainContainer = articleCandidates.find(
    (el) => el && el.textContent && el.textContent.trim().length > 300
  ) || document.body;

  // 2. Walk elements and collect structured blocks using textContent
  const ignoredTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "HEADER", "FOOTER", "ASIDE", "IFRAME", "SVG", "CANVAS"]);
  const blocks = [];

  function traverse(node) {
    if (!node) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toUpperCase();
      if (ignoredTags.has(tag)) return;

      const cls = typeof node.className === "string" ? node.className : "";
      const id = typeof node.id === "string" ? node.id : "";

      // Skip obvious navigation / ad containers unless inside the main article body
      if (/cookie|banner|advertisement|ad-container|comments|social-share/i.test(`${cls} ${id}`)) {
        return;
      }

      if (/^H[1-6]$/.test(tag)) {
        const hText = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (hText.length > 2 && hText.length < 160) {
          blocks.push({ type: "heading", text: `### ${hText}` });
        }
        return; // Don't traverse deeper into headings
      }

      if (tag === "LI") {
        const liText = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (liText.length > 3) {
          blocks.push({ type: "list", text: `• ${liText}` });
        }
        return;
      }

      if (tag === "P") {
        const pText = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (pText.length > 25) {
          blocks.push({ type: "para", text: pText });
        }
        return;
      }

      // Continue traversing child nodes for container divs/sections
      for (let child = node.firstChild; child; child = child.nextSibling) {
        traverse(child);
      }
    } else if (node.nodeType === Node.TEXT_NODE) {
      const parentTag = node.parentElement?.tagName?.toUpperCase();
      if (!parentTag || ignoredTags.has(parentTag)) return;

      const text = (node.nodeValue || "").replace(/\s+/g, " ").trim();
      if (text.length > 40) {
        blocks.push({ type: "text", text });
      }
    }
  }

  traverse(mainContainer);

  const rawFullText = blocks.map((b) => b.text).join("\n\n").trim();
  const totalChars = rawFullText.length;
  const CONTEXT_BUDGET = 12000;

  let finalText = "";
  let isTruncated = false;
  let truncatedReason = "";

  if (totalChars <= CONTEXT_BUDGET) {
    finalText = rawFullText;
  } else {
    // Section-aware budget allocation:
    // Take early overview (30%), distributed section headings & key points (50%), and conclusion (20%)
    isTruncated = true;
    truncatedReason = `Long page (${(totalChars / 1000).toFixed(1)}k chars): sampled introduction, key sections, and conclusion.`;

    const introBudget = 3500;
    const outroBudget = 2500;
    const bodyBudget = CONTEXT_BUDGET - introBudget - outroBudget;

    let accumulatedIntro = "";
    let introIndex = 0;
    while (introIndex < blocks.length && accumulatedIntro.length < introBudget) {
      accumulatedIntro += blocks[introIndex].text + "\n\n";
      introIndex++;
    }

    let accumulatedOutro = "";
    let outroIndex = blocks.length - 1;
    while (outroIndex > introIndex && accumulatedOutro.length < outroBudget) {
      accumulatedOutro = blocks[outroIndex].text + "\n\n" + accumulatedOutro;
      outroIndex--;
    }

    // From the remaining middle blocks, prioritize headings and first paragraphs after headings
    let middleText = "\n[... Section-aware sampling ...]\n\n";
    let middleBudgetRemaining = bodyBudget;
    for (let i = introIndex; i <= outroIndex && middleBudgetRemaining > 0; i++) {
      const b = blocks[i];
      if (b.type === "heading" || (i > 0 && blocks[i - 1].type === "heading")) {
        middleText += b.text + "\n\n";
        middleBudgetRemaining -= b.text.length;
      }
    }

    finalText = (accumulatedIntro + middleText + "\n[... Conclusion ...]\n\n" + accumulatedOutro).trim();
  }

  // Fallback to body textContent if walker extracted too little
  if (finalText.length < 200) {
    const fallback = (mainContainer.innerText || mainContainer.textContent || "")
      .replace(/\r?\n|\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    finalText = fallback.slice(0, CONTEXT_BUDGET);
  }

  // Extract author/byline if available
  const bylineEl = document.querySelector("meta[name='author'], .byline, .author, [rel='author']");
  const byline = bylineEl?.getAttribute?.("content") || bylineEl?.textContent?.trim() || "";

  return {
    title: title || hostname,
    url,
    byline,
    text: finalText,
    originalChars: totalChars,
    charsSent: finalText.length,
    truncated: isTruncated,
    truncatedReason
  };
}
