// Slothy Landing Page Interactive Simulator
document.addEventListener("DOMContentLoaded", () => {
  const demoApp = document.getElementById("demoApp");
  const pillBtns = document.querySelectorAll(".pill-btn");
  const demoTriggerBtn = document.getElementById("demoTriggerBtn");
  const demoBtnText = document.getElementById("demoBtnText");
  const demoCopyBtn = document.getElementById("demoCopyBtn");

  const views = {
    idle: document.getElementById("demoIdleView"),
    loading: document.getElementById("demoLoadingView"),
    result: document.getElementById("demoResultView"),
    error: document.getElementById("demoErrorView")
  };

  function setDemoState(state) {
    demoApp.dataset.state = state;

    Object.entries(views).forEach(([name, el]) => {
      if (el) el.hidden = name !== state;
    });

    pillBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.state === state);
    });

    if (state === "loading") {
      demoTriggerBtn.disabled = true;
      demoBtnText.textContent = "Thinking slowly…";
    } else if (state === "result") {
      demoTriggerBtn.disabled = false;
      demoBtnText.textContent = "Get the gist again";
    } else {
      demoTriggerBtn.disabled = false;
      demoBtnText.textContent = "Get the gist";
    }
  }

  pillBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      setDemoState(btn.dataset.state);
    });
  });

  demoTriggerBtn.addEventListener("click", () => {
    const current = demoApp.dataset.state;
    if (current === "idle" || current === "error") {
      setDemoState("loading");
      setTimeout(() => {
        setDemoState("result");
      }, 1600);
    } else if (current === "result") {
      setDemoState("idle");
    }
  });

  if (demoCopyBtn) {
    demoCopyBtn.addEventListener("click", () => {
      const original = demoCopyBtn.textContent;
      demoCopyBtn.textContent = "Copied to clipboard!";
      setTimeout(() => {
        demoCopyBtn.textContent = original;
      }, 1500);
    });
  }
});
