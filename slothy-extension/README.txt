Slothy Chrome Extension
=======================
This folder is a load-unpacked Manifest V3 extension.

Files:
- manifest.json, popup.html, popup.css, popup.js
- assets/logo.png and assets/banner.png (provided brand art)
- assets/slothy-face.png, assets/notes.png, assets/action-items.png
- icons/icon16.png, icon32.png, icon48.png, icon128.png

Install:
1. Open chrome://extensions and enable Developer mode.
2. Click Load unpacked and select this folder.
3. Start Ollama locally and pull the model configured in Settings (default gemma3:4b).
4. If Chrome cannot reach Ollama, configure OLLAMA_ORIGINS for this extension origin and restart Ollama.

The page text is sent to the configured local Ollama endpoint. The MVP extracts document.body.innerText; a bundled Readability parser can be added later for cleaner article extraction.
