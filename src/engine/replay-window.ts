export interface ReplayWindow {
  fromTime: number;
  toTime: number;
}

/**
 * Parse a calendar date or ISO datetime into Unix seconds.
 * Date-only forms are UTC. Supported:
 * - `YYYY-MM-DD` / `YYYY-MM-DDTHH:mm:ssZ`
 * - `DD-MM-YYYY` (e.g. 01-01-2026)
 */
export function parseReplayDate(raw: string, bound: "from" | "to"): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Empty --${bound} date`);
  }

  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    return calendarDayBoundUtc(year, month, day, bound);
  }

  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (ymd) {
    const year = Number(ymd[1]);
    const month = Number(ymd[2]);
    const day = Number(ymd[3]);
    return calendarDayBoundUtc(year, month, day, bound);
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(
      `Invalid --${bound} date "${raw}". Use YYYY-MM-DD, DD-MM-YYYY, or an ISO datetime.`,
    );
  }
  return Math.floor(ms / 1000);
}

function calendarDayBoundUtc(
  year: number,
  month: number,
  day: number,
  bound: "from" | "to",
): number {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid calendar date ${year}-${month}-${day}`);
  }
  // --from = start of that UTC day; --to = start of the next UTC day (exclusive end).
  const startMs = Date.UTC(year, month - 1, day);
  const check = new Date(startMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(
      `Invalid calendar date ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
  }
  if (bound === "from") {
    return Math.floor(startMs / 1000);
  }
  return Math.floor(Date.UTC(year, month - 1, day + 1) / 1000);
}

export function resolveReplayWindow(options: {
  days?: number;
  fromTime?: number;
  toTime?: number;
}): ReplayWindow {
  const now = Math.floor(Date.now() / 1000);

  if (options.fromTime !== undefined) {
    const fromTime = options.fromTime;
    const toTime = options.toTime ?? now;
    if (!(fromTime < toTime)) {
      throw new Error(`Invalid window: from (${fromTime}) must be before to (${toTime})`);
    }
    return { fromTime, toTime };
  }

  if (options.toTime !== undefined) {
    throw new Error("--to requires --from (or use --days for a lookback from now)");
  }

  const days = options.days !== undefined && options.days > 0 ? options.days : 90;
  return { fromTime: now - days * 24 * 60 * 60, toTime: now };
}

export function readFlagValue(
  argv: string[],
  index: number,
  flag: string,
): { value: string; nextIndex: number } {
  const eq = argv[index];
  if (eq?.startsWith(`${flag}=`)) {
    const value = eq.slice(flag.length + 1);
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}
