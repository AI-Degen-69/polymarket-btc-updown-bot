const LEVEL_COLOUR: Record<string, string> = {
  entry: "\u001b[32m",
  exit: "\u001b[36m",
  settle: "\u001b[35m",
  risk: "\u001b[33m",
  skip: "\u001b[90m",
  error: "\u001b[31m",
  info: "\u001b[37m",
};
const RESET = "\u001b[0m";

type Fields = Record<string, unknown>;

function fmt(value: unknown): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
}

export function log(kind: keyof typeof LEVEL_COLOUR | string, message: string, fields?: Fields): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const colour = LEVEL_COLOUR[kind] ?? "";
  const tag = kind.toUpperCase().padEnd(6);
  const extras =
    fields && Object.keys(fields).length > 0
      ? " " +
        Object.entries(fields)
          .filter(([, v]) => v !== undefined && v !== null)
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(" ")
      : "";
  process.stdout.write(`${stamp} ${colour}${tag}${RESET} ${message}${extras}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}
