// Shared page chrome for Agentify docs pages.
// Upgrades terminals/code blocks with mac-style traffic lights + a copy button,
// matching the homepage. No dependencies; safe to include on every page.
document.addEventListener("DOMContentLoaded", function () {
  const DOTS = '<span class="tl-dots"><i></i><i></i><i></i></span>';

  const makeCopy = (getText) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "term-copy";
    b.textContent = "copy";
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(getText()); } catch (e) { /* clipboard blocked */ }
      const prev = b.textContent;
      b.textContent = "copied";
      b.classList.add("is-copied");
      setTimeout(() => { b.textContent = prev; b.classList.remove("is-copied"); }, 1200);
    });
    return b;
  };

  // 1) Existing .terminal blocks that carry a .terminal-top label row:
  //    add traffic lights at the start and a copy button at the end.
  document.querySelectorAll(".terminal").forEach((term) => {
    const top = term.querySelector(".terminal-top");
    const pre = term.querySelector("pre");
    if (!top || top.dataset.enhanced) return;
    top.dataset.enhanced = "1";
    top.insertAdjacentHTML("afterbegin", DOTS);
    if (pre) top.appendChild(makeCopy(() => pre.innerText));
  });

  // 2) Standalone <pre> blocks (not inside a .terminal): wrap in a framed
  //    terminal with a chrome bar.
  document.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".terminal") || pre.dataset.enhanced) return;
    pre.dataset.enhanced = "1";
    const frame = document.createElement("div");
    frame.className = "term-frame";
    const bar = document.createElement("div");
    bar.className = "term-bar";
    bar.innerHTML = DOTS + '<span class="term-label">' + (pre.getAttribute("data-label") || "bash") + "</span>";
    bar.appendChild(makeCopy(() => pre.innerText));
    pre.parentNode.insertBefore(frame, pre);
    frame.appendChild(bar);
    frame.appendChild(pre);
  });
});
