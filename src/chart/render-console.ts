import { Chart, CONSTANTS } from "@neabyte/candlestick-cli";
import type { Candle, Trade } from "../types.js";

export interface RenderConsoleChartInput {
  pair: string;
  candles: Candle[];
  trades: Trade[];
  /** Terminal chart width (0 = auto from stdout). */
  width?: number;
  /** Terminal chart height (0 = auto from stdout). */
  height?: number;
  /** Colorize B/S markers (default: stdout.isTTY). */
  color?: boolean;
}

export interface BucketedCandle extends Candle {
  /** Inclusive start index into the original series. */
  sourceFrom: number;
  /** Exclusive end index into the original series. */
  sourceTo: number;
}

const ANSI_BUY = "\u001b[92m";
const ANSI_SELL = "\u001b[91m";
const ANSI_RESET = "\u001b[00m";
/** Strip CSI color sequences from chart lines (for pad measurement). */
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

/**
 * Bucket OHLC so the series fits the candlestick-cli visible column budget.
 * Library "fit" mode otherwise keeps only the last N candles.
 */
export function bucketCandlesForWidth(candles: Candle[], maxColumns: number): BucketedCandle[] {
  if (candles.length === 0) return [];
  const cols = Math.max(1, Math.floor(maxColumns));
  if (candles.length <= cols) {
    return candles.map((c, i) => ({
      ...c,
      sourceFrom: i,
      sourceTo: i + 1,
    }));
  }

  const out: BucketedCandle[] = [];
  for (let col = 0; col < cols; col++) {
    const from = Math.floor((col * candles.length) / cols);
    const to = Math.floor(((col + 1) * candles.length) / cols);
    if (to <= from) continue;
    const first = candles[from]!;
    let high = first.high;
    let low = first.low;
    let volume = 0;
    for (let i = from; i < to; i++) {
      const c = candles[i]!;
      high = Math.max(high, c.high);
      low = Math.min(low, c.low);
      volume += c.volume;
    }
    const last = candles[to - 1]!;
    out.push({
      time: first.time,
      open: first.open,
      high,
      low,
      close: last.close,
      volume,
      sourceFrom: from,
      sourceTo: to,
    });
  }
  return out;
}

/** Visible candle columns for a given terminal width (mirrors candlestick-cli fit sampling). */
export function visibleCandleColumns(terminalWidth: number): number {
  const marginsLeft = 0;
  const marginsRight = 4;
  const available = terminalWidth - CONSTANTS.WIDTH - marginsLeft - marginsRight;
  return Math.max(1, Math.floor((available - 2) / 1.1));
}

/** Map each trade to a column index in the (possibly bucketed) series, or -1 if unmatched. */
export function tradeColumnIndexes(
  buckets: BucketedCandle[],
  trades: Trade[],
  originalCandles: Candle[],
): { side: "BUY" | "SELL"; column: number }[] {
  const timeToIndex = new Map<number, number>();
  for (let i = 0; i < originalCandles.length; i++) {
    timeToIndex.set(originalCandles[i]!.time, i);
  }

  const indexToColumn = (sourceIndex: number): number => {
    for (let col = 0; col < buckets.length; col++) {
      const b = buckets[col]!;
      if (sourceIndex >= b.sourceFrom && sourceIndex < b.sourceTo) return col;
    }
    return -1;
  };

  const markers: { side: "BUY" | "SELL"; column: number }[] = [];
  for (const t of trades) {
    if (t.side !== "BUY" && t.side !== "SELL") continue;
    const sec = Math.floor(t.at.getTime() / 1000);
    // Exact candle open time, else nearest candle at or before the fill.
    const sourceIndex = timeToIndex.get(sec) ?? findNearestCandleIndex(originalCandles, sec);
    if (sourceIndex < 0) continue;
    const column = indexToColumn(sourceIndex);
    if (column < 0) continue;
    markers.push({ side: t.side, column });
  }
  return markers;
}

function findNearestCandleIndex(candles: Candle[], timeSec: number): number {
  if (candles.length === 0) return -1;
  let best = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i]!.time <= timeSec) best = i;
    else break;
  }
  return best;
}

/** Build a single marker row aligned under candle columns (after y-axis pad). */
export function buildTradeMarkerRow(
  columnCount: number,
  markers: { side: "BUY" | "SELL"; column: number }[],
  leftPad: number,
  color: boolean,
): string {
  const cells: string[] = Array.from({ length: columnCount }, () => " ");
  for (const m of markers) {
    if (m.column < 0 || m.column >= columnCount) continue;
    const prev = cells[m.column]!;
    if (prev === " ") {
      cells[m.column] = m.side === "BUY" ? "B" : "S";
    } else if ((prev === "B" && m.side === "SELL") || (prev === "S" && m.side === "BUY")) {
      cells[m.column] = "*";
    }
  }

  const colored = cells.map((ch) => {
    if (!color || ch === " " || ch === "*") return ch;
    if (ch === "B") return `${ANSI_BUY}B${ANSI_RESET}`;
    if (ch === "S") return `${ANSI_SELL}S${ANSI_RESET}`;
    return ch;
  });

  return `${" ".repeat(Math.max(0, leftPad))}${colored.join("")}`;
}

/**
 * Spaces before the first candle column.
 * Y-axis is `${price} ┤` + MARGIN_RIGHT spaces; candle voids are also spaces, so do not
 * skip past ┤ into the plot area.
 */
export function inferCandleLeftPad(chartText: string): number {
  const line = chartText.split("\n").find((l) => l.includes("┤"));
  if (!line) return CONSTANTS.WIDTH + CONSTANTS.MARGIN_RIGHT;
  const plain = line.replace(ANSI_RE, "");
  const tick = plain.indexOf("┤");
  if (tick < 0) return CONSTANTS.WIDTH + CONSTANTS.MARGIN_RIGHT;
  // price + " ┤" ends at tick; then MARGIN_RIGHT blank cols before candles.
  return tick + 1 + CONSTANTS.MARGIN_RIGHT;
}

/** UTC time label for a candle open (short form for the axis). */
export function formatAxisTime(timeSec: number, spanSec: number): string {
  const d = new Date(timeSec * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  // Prefer clock time when the window is shorter than ~3 days.
  if (spanSec < 3 * 24 * 60 * 60) {
    return `${dd}-${mm} ${hh}:${mi}`;
  }
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/**
 * Build a time axis under the candle columns: start / mid / end labels.
 * Labels are placed to avoid overlap; end label is right-aligned to the plot width.
 */
export function buildTimeAxisRow(buckets: BucketedCandle[], leftPad: number): string {
  if (buckets.length === 0) return "";
  const first = buckets[0]!;
  const last = buckets[buckets.length - 1]!;
  const spanSec = Math.max(0, last.time - first.time);
  const startText = formatAxisTime(first.time, spanSec);
  const endText = formatAxisTime(last.time, spanSec);
  const midIndex = Math.floor((buckets.length - 1) / 2);
  const midText = formatAxisTime(buckets[midIndex]!.time, spanSec);

  const width = Math.max(buckets.length, startText.length + endText.length + 1);
  const chars: string[] = Array.from({ length: width }, () => " ");

  const writeAt = (start: number, text: string): boolean => {
    if (start < 0 || start + text.length > chars.length) return false;
    for (let i = 0; i < text.length; i++) {
      if (chars[start + i] !== " ") return false;
    }
    for (let i = 0; i < text.length; i++) {
      chars[start + i] = text[i]!;
    }
    return true;
  };

  writeAt(0, startText);
  writeAt(Math.max(0, buckets.length - endText.length), endText);

  // Mid label only when it fits without colliding with start/end.
  if (midIndex > 0 && midIndex < buckets.length - 1) {
    const midStart = Math.max(0, midIndex - Math.floor(midText.length / 2));
    writeAt(midStart, midText);
  }

  const rule = `${" ".repeat(Math.max(0, leftPad))}${"─".repeat(buckets.length)}`;
  const labelsRow = `${" ".repeat(Math.max(0, leftPad))}${chars.join("")}`;
  return `${rule}\n${labelsRow}`;
}

function toLibCandles(buckets: BucketedCandle[]) {
  return buckets.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: c.time * 1000,
    type: c.close >= c.open ? (1 as const) : (0 as const),
  }));
}

/**
 * Render a terminal candlestick chart with B/S markers and a time axis.
 * Returns the full multi-line string (does not print).
 */
export async function renderConsoleChart(input: RenderConsoleChartInput): Promise<string> {
  const { pair, candles, trades } = input;
  if (candles.length === 0) {
    return "(no candles to chart)";
  }

  const width = input.width ?? process.stdout.columns ?? 120;
  const height = input.height ?? 30;
  const color = input.color ?? Boolean(process.stdout.isTTY);
  const maxCols = visibleCandleColumns(width);
  const buckets = bucketCandlesForWidth(candles, maxCols);
  const markers = tradeColumnIndexes(buckets, trades, candles);

  const chart = new Chart(toLibCandles(buckets), {
    title: `${pair} backtest`,
    width,
    height,
  });
  chart.setVolumePaneEnabled(false);
  chart.fitToData();

  const body = await chart.render();
  const visibleCount = chart.chartData.visibleCandleSet.candles.length;
  // If the lib still clipped (should not after bucketing), align markers to the visible tail.
  const visibleBuckets =
    visibleCount > 0 && visibleCount < buckets.length
      ? buckets.slice(buckets.length - visibleCount)
      : buckets;
  const colOffset = buckets.length - visibleBuckets.length;
  const visibleMarkers = markers
    .map((m) => ({ ...m, column: m.column - colOffset }))
    .filter((m) => m.column >= 0 && m.column < visibleBuckets.length);

  const leftPad = inferCandleLeftPad(body);
  const markerRow = buildTradeMarkerRow(visibleBuckets.length, visibleMarkers, leftPad, color);
  const timeAxis = buildTimeAxisRow(visibleBuckets, leftPad);
  const legend = color
    ? `Trades: ${ANSI_BUY}B${ANSI_RESET}=BUY  ${ANSI_SELL}S${ANSI_RESET}=SELL  *=both in bucket` +
      (buckets.length < candles.length
        ? `  (showing ${visibleBuckets.length}/${candles.length} bucketed candles)`
        : "")
    : `Trades: B=BUY  S=SELL  *=both in bucket` +
      (buckets.length < candles.length
        ? `  (showing ${visibleBuckets.length}/${candles.length} bucketed candles)`
        : "");

  // Info bar is appended on the last price line by the lib; put time axis after the body.
  return `${legend}\n${markerRow}\n${body}\n${timeAxis}`;
}
