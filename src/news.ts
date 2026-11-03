import type { NewsConfig } from "./config.ts";

export interface NewsStatus {
  blocked: boolean;
  reason?: string;
  secondsToEvent?: number;
}

/**
 * The guide blocks out 15 minutes before and after scheduled events (CPI, FOMC,
 * Fed speakers). The bot reads the list from config; it does not guess news.
 */
export function newsStatus(config: NewsConfig, nowMs: number): NewsStatus {
  const windowMs = config.blackoutMinutes * 60 * 1000;
  for (const event of config.events) {
    const at = Date.parse(event);
    if (!Number.isFinite(at)) continue;
    const delta = at - nowMs;
    if (Math.abs(delta) <= windowMs) {
      return {
        blocked: true,
        reason: `scheduled-event:${new Date(at).toISOString()}`,
        secondsToEvent: Math.round(delta / 1000),
      };
    }
  }
  return { blocked: false };
}
