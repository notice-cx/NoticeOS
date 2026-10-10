// Terminal colour for the operator commands' output, plain when stdout is not a TTY.

const style = (code) => (process.stdout.isTTY ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => s);

export const ansi = Object.freeze({
  dim: style(2),
  bold: style(1),
  red: style(31),
  green: style(32),
  yellow: style(33),
  cyan: style(36),
});
