export interface ContextSummary {
  current: { used: number; window?: number; percent?: number; nonMessage?: number } | null;
  history: Array<{ at: number; used: number; window?: number; epoch?: number }>;
  cache: { read: number; write: number; lastRead: number; lastWrite: number };
  compactions: { count: number; lastAt?: number; tokensBefore?: number; tokensAfter?: number };
}

export function pointsOf(messages: unknown): Array<Record<string, unknown> & { at: number; used: number }>;
export function compactionsOf(messages: unknown): ContextSummary["compactions"];
export function summarize(session: unknown, messages: unknown): ContextSummary;
