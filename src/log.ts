/**
 * JSON lines on stdout: Railway and Better Stack (T0.7.5) parse them as
 * structured logs. Never log payloads or secrets — job ids and orgs only.
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

export type Logger = {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): Logger;
};

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

export function createLogger(level: Level = "info", base: Fields = {}): Logger {
  const write = (at: Level, message: string, fields: Fields = {}) => {
    if (ORDER[at] < ORDER[level]) return;
    const entry: Fields = { time: new Date().toISOString(), level: at, msg: message, ...base };
    for (const [key, value] of Object.entries(fields)) entry[key] = serialize(value);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}

/** A logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
