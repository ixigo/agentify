// Progress rendering for analyze scans. Progress always goes to stderr so
// JSON stdout stays valid; in a TTY it is a single self-overwriting line,
// and with --no-progress or a non-TTY stderr nothing is emitted at all —
// no animation, no control codes, no periodic noise in CI logs.

function formatMb(bytes) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function createProgressRenderer({ stream = process.stderr, enabled, intervalMs = 80, now = Date.now } = {}) {
  const active = enabled ?? Boolean(stream.isTTY);
  let lastRender = -Infinity;
  let lastWidth = 0;
  let done = false;

  function write(line) {
    const padded = line.padEnd(lastWidth, " ");
    lastWidth = line.length;
    stream.write(`\r${padded}`);
  }

  return {
    update(progress) {
      if (!active || done) return;
      const timestamp = now();
      const finished = progress.filesDone >= progress.filesTotal;
      if (!finished && timestamp - lastRender < intervalMs) return;
      lastRender = timestamp;
      write(`analyze: ${progress.provider} ${progress.filesDone}/${progress.filesTotal} file(s) · ${formatMb(progress.bytesDone)} · ${progress.sessions} session(s) in scope`);
    },
    finish() {
      if (!active || done) return;
      done = true;
      // Clear the line so the report starts on clean output.
      stream.write(`\r${" ".repeat(lastWidth)}\r`);
    },
  };
}
