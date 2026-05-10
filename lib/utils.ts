import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const integerFormatter = new Intl.NumberFormat("zh-CN");
const compactFormatter = new Intl.NumberFormat("zh-CN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function formatNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return integerFormatter.format(value);
}

export function formatCompactNumber(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) < 1000) return integerFormatter.format(value);
  return compactFormatter.format(value);
}

export function formatTokenCount(value: number | null | undefined) {
  return formatCompactNumber(value);
}

export function asNumber(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function parseBoundedInt(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function formatScaledNumber(value: number | null | undefined, fractionDigits = 2) {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(fractionDigits)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(fractionDigits)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(fractionDigits)}k`;
  return String(value);
}

export function formatLimit(value: number | null | undefined, fractionDigits = 2) {
  if (value === null || value === undefined) return "-";
  if (value < 0) return "∞";
  return formatScaledNumber(value, fractionDigits);
}

export function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;

  const min = sec / 60;
  if (min < 60) return `${min.toFixed(2)} m`;

  return `${(min / 60).toFixed(2)} h`;
}
