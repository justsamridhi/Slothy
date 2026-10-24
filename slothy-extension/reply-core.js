// reply-core.js – pure functions (UMD style)
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.replyCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // Utility: simple stopword list
  const STOPWORDS = new Set(['the','and','or','but','if','a','an','of','to','in','on','for','with','by','at','from','as','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','should','can','could','may','might','must']);

  // Split text into numbered passages (sentences), preserving original order
  function splitIntoPassages(text) {
    if (!text) return [];
    // naive sentence split on punctuation followed by space and capital letter
    const raw = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
    return raw.map((t, i) => ({ id: i + 1, text: t.trim() }));
  }

  // Regex patterns for entities
  const regexes = {
    isoDate: /\b\d{4}[-/]\d{2}[-/]\d{2}\b/g,
    monthDay: /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}\b/gi,
    shortDate: /\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g,
    relative: /\b(?:next|last)\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|week|month|year)\b/gi,
    eod: /\bEOD\b/gi,
    tomorrow: /\btomorrow\b/gi,
    time: /\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/gi,
    money: /\$?\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP|\$|£|€)?/g,
    email: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    url: /https?:\/\/[^\s]+/gi,
    phone: /\b(?:\+\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?\d{3}[\s-]?\d{4}\b/g
  };

  function extractEntities(text) {
    const entities = {};
    for (const [key, re] of Object.entries(regexes)) {
      const matches = text.match(re);
      if (matches) entities[key] = Array.from(new Set(matches.map(m=>m.trim())));
    }
    return entities;
  }

  // Verification of ask against source passages
  function verifyAsk(ask, passages) {
    if (!Array.isArray(ask.source_ids) || ask.source_ids.length===0) return { ok:false, reason:'no source ids' };
    const sourceTexts = ask.source_ids.map(id=>{
      const p = passages.find(p=>p.id===id);
      return p ? p.text : '';
    }).join(' ');
    // lexical overlap check (>=2 content words)
    const words = ask.text.toLowerCase().split(/\W+/).filter(w=>w && !STOPWORDS.has(w));
    const sourceWords = sourceTexts.toLowerCase().split(/\W+/).filter(w=>w && !STOPWORDS.has(w));
    const overlap = words.filter(w=>sourceWords.includes(w)).length;
    if (overlap<2) return { ok:false, reason:'insufficient lexical overlap' };
    // number/date/entity matching (simple numeric check)
    const numberRe = /\d+/g;
    const askNums = (ask.text.match(numberRe)||[]).map(Number);
    const srcNums = (sourceTexts.match(numberRe)||[]).map(Number);
    for (const n of askNums) {
      if (!srcNums.includes(n)) return { ok:false, reason:'number mismatch' };
    }
    return { ok:true };
  }

  // Fallback ask generation based on cue words
  function fallbackAsks(text) {
    const sentences = splitIntoPassages(text);
    const cueRe = /\b(?:please|can you|could you|need|kindly|by\s+\w+|deadline|let me know|send|confirm|\?)\b/i;
    const asks = [];
    for (const s of sentences) {
      if (cueRe.test(s.text)) {
        const type = /\?$/.test(s.text) ? 'question' : 'request';
        asks.push({ text: s.text.replace(/\?+$/,'').trim(), type, source_ids:[s.id] });
        if (asks.length>=8) break;
      }
    }
    return asks;
  }

  // Coverage check of a reply against asks
  function coverageCheck(reply, asks) {
    const replyWords = reply.toLowerCase().split(/\W+/).filter(w=>w && !STOPWORDS.has(w));
    const covered = [];
    const missing = [];
    for (const ask of asks) {
      const askWords = ask.text.toLowerCase().split(/\W+/).filter(w=>w && !STOPWORDS.has(w));
      const overlap = askWords.filter(w=>replyWords.includes(w)).length;
      if (overlap>=2) covered.push(ask);
      else missing.push(ask);
    }
    // flag extra entities not present in any ask
    const extraEntities = [];
    const ents = extractEntities(reply);
    for (const [key, vals] of Object.entries(ents)) {
      for (const v of vals) {
        const inAsk = asks.some(a=>a.text.includes(v));
        if (!inAsk) extraEntities.push({type:key, value:v});
      }
    }
    return { coveredCount: covered.length, total: asks.length, missing, extraEntities };
  }

  // Simple deterministic hash (FNV‑1a) for caching
  function hashMessage(msg) {
    const str = JSON.stringify(msg);
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  // In‑memory cache (per session)
  const _cache = new Map();
  function getCached(hash) { return _cache.get(hash); }
  function setCached(hash, data) { _cache.set(hash, data); }

  return {
    splitIntoPassages,
    extractEntities,
    verifyAsk,
    fallbackAsks,
    coverageCheck,
    hashMessage,
    getCached,
    setCached
  };
}));
