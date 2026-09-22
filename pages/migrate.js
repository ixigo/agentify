// Commands remain selectable when JavaScript or clipboard access is unavailable.
const status = document.getElementById("copy-status");
for (const button of document.querySelectorAll("button[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const block = document.getElementById(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(block.textContent);
      status.textContent = "Command copied.";
    } catch {
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = "Clipboard unavailable. Text selected — press ⌘C or Ctrl+C to copy.";
    }
  });
}
