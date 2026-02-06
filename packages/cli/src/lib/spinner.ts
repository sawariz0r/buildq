const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

const noColor = !!process.env['NO_COLOR'];
const isTTY = !!process.stderr.isTTY;

const green = (s: string) => (noColor ? s : `\x1b[32m${s}\x1b[0m`);
const red = (s: string) => (noColor ? s : `\x1b[31m${s}\x1b[0m`);
const yellow = (s: string) => (noColor ? s : `\x1b[33m${s}\x1b[0m`);

export interface Spinner {
  update(msg: string): void;
  stop(symbol: string, msg: string): void;
  clear(): void;
}

export function createSpinner(initialMsg: string): Spinner {
  let message = initialMsg;
  let frameIdx = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = Date.now();
  let stopped = false;

  function elapsed(): string {
    const s = Math.round((Date.now() - startedAt) / 1000);
    return `${s}s`;
  }

  function render() {
    if (stopped) return;
    if (isTTY) {
      const frame = FRAMES[frameIdx % FRAMES.length];
      frameIdx++;
      process.stderr.write(`\r\x1b[K${frame} ${message} [${elapsed()}]`);
    }
  }

  // Non-TTY: print the initial message as a static line
  if (!isTTY) {
    process.stderr.write(`  ${message}\n`);
  } else {
    render();
    timer = setInterval(render, INTERVAL_MS);
  }

  return {
    update(msg: string) {
      if (stopped) return;
      message = msg;
      if (!isTTY) {
        process.stderr.write(`  ${msg}\n`);
      }
    },

    stop(symbol: string, msg: string) {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (isTTY) {
        process.stderr.write(`\r\x1b[K${symbol} ${msg}\n`);
      } else {
        process.stderr.write(`${symbol} ${msg}\n`);
      }
    },

    clear() {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (isTTY) {
        process.stderr.write('\r\x1b[K');
      }
    },
  };
}
