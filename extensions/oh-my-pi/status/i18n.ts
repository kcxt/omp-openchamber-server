import type { CategoryId, NotFoundReason } from '../service/breakdown';

/** Every word the page shows, in one language. Functions take what the sentence needs. */
export type Messages = {
  category: Record<CategoryId, string> & { reserve: string };
  group: { prompt: string; conversation: string };
  tokensOf: (used: string, limit: string) => string;
  compaction: {
    at: (threshold: string) => string;
    reached: (threshold: string) => string;
    imminent: string;
  };
  cache: {
    warm: (left: string, lifetime: string) => string;
    cold: (elapsed: string, lifetime: string, tokens: string) => string;
    warmShort: (left: string) => string;
    coldShort: (tokens: string) => string;
  };
  facts: {
    growth: string;
    perCall: (tokens: string) => string;
    cacheRead: string;
    cacheWrite: string;
    compactions: string;
    none: string;
    lastCompaction: (before: string, after: string) => string;
  };
  trend: (turns: number) => string;
  note: { omp: string; transcript: string };
  duration: { seconds: (n: number) => string; minutes: (n: number) => string; hours: (h: number, m: string) => string; days: (n: number) => string };
  empty: {
    loading: string;
    noSession: [string, string];
    noTurn: [string, string];
    notFound: string;
    unreachable: string;
    reasons: Record<NotFoundReason, string>;
  };
};

const fr: Messages = {
  category: {
    systemPrompt: 'Prompt système',
    systemTools: 'Outils système',
    systemContext: 'Contexte système',
    instructionFiles: "Fichiers d'instructions",
    skills: 'Skills',
    system: 'Système et instructions',
    messages: 'Messages',
    free: 'Libre',
    reserve: 'Réserve de compaction',
  },
  group: { prompt: 'Prompt', conversation: 'Conversation' },
  tokensOf: (used, limit) => `${used} / ${limit} tokens`,
  compaction: {
    at: (threshold) => `Compaction à ${threshold}`,
    imminent: 'Compaction au prochain appel',
    reached: (threshold) => `Seuil de compaction atteint (${threshold}) : la prochaine réponse résumera la conversation.`,
  },
  cache: {
    warm: (left, lifetime) => `Cache probablement chaud encore ≈ ${left} (durée supposée ${lifetime}).`,
    cold: (elapsed, lifetime, tokens) =>
      `Cache probablement expiré : dernier appel il y a ${elapsed} (durée supposée ${lifetime}). Le prochain message relira ≈ ${tokens} tokens sans cache.`,
    warmShort: (left) => `Cache chaud ? · ${left}`,
    coldShort: (tokens) => `Cache froid · ${tokens} à relire`,
  },
  facts: {
    growth: 'Croissance',
    perCall: (tokens) => `≈ ${tokens} par appel`,
    cacheRead: 'Cache lu',
    cacheWrite: 'Cache écrit',
    compactions: 'Compactions',
    none: 'aucune',
    lastCompaction: (before, after) => `dernière ${before} → ${after}`,
  },
  trend: (turns) => `Évolution sur ${turns} tours`,
  note: {
    omp: 'Total exact (taille du prompt rapportée par le fournisseur). Catégories : estimations de omp.',
    transcript: "Total exact. Catégories : découpage grossier du journal ; omp n'a pas donné son détail.",
  },
  duration: {
    seconds: (n) => `${n} s`,
    minutes: (n) => `${n} min`,
    hours: (h, m) => `${h} h ${m}`,
    days: (n) => `${n} j`,
  },
  empty: {
    loading: 'Lecture du contexte…',
    noSession: ['Aucune session ouverte', 'Ouvre une session pour voir son contexte.'],
    noTurn: ['Pas encore de réponse', "Le contexte apparaît après la première réponse de l'agent."],
    notFound: 'Contexte introuvable',
    unreachable: "Le service Contexte ne répond pas. Vérifie qu'il est approuvé dans Réglages → Extensions.",
    reasons: {
      'bad-request': 'Demande illisible : rouvre la section.',
      'no-session': 'Ouvre une session pour voir son contexte.',
      unreachable: "Le sidecar omp ne répond pas. Vérifie qu'il tourne.",
      'session-not-found': 'Le sidecar ne connaît pas cette session.',
      'no-window': "La fenêtre du modèle est inconnue : ouvre une fois le sélecteur de modèle pour que le sidecar l'apprenne.",
      failed: 'Lecture du contexte impossible pour le moment.',
    },
  },
};

const en: Messages = {
  category: {
    systemPrompt: 'System prompt',
    systemTools: 'System tools',
    systemContext: 'System context',
    instructionFiles: 'Instruction files',
    skills: 'Skills',
    system: 'System and instructions',
    messages: 'Messages',
    free: 'Free',
    reserve: 'Compaction reserve',
  },
  group: { prompt: 'Prompt', conversation: 'Conversation' },
  tokensOf: (used, limit) => `${used} / ${limit} tokens`,
  compaction: {
    at: (threshold) => `Compaction at ${threshold}`,
    imminent: 'Compaction on the next call',
    reached: (threshold) => `Compaction threshold reached (${threshold}): the next reply will summarize the conversation.`,
  },
  cache: {
    warm: (left, lifetime) => `Cache probably warm for ≈ ${left} more (assumed lifetime ${lifetime}).`,
    cold: (elapsed, lifetime, tokens) =>
      `Cache probably expired: last call ${elapsed} ago (assumed lifetime ${lifetime}). The next message will read ≈ ${tokens} tokens without cache.`,
    warmShort: (left) => `Cache warm? · ${left}`,
    coldShort: (tokens) => `Cache cold · ${tokens} to reread`,
  },
  facts: {
    growth: 'Growth',
    perCall: (tokens) => `≈ ${tokens} per call`,
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    compactions: 'Compactions',
    none: 'none',
    lastCompaction: (before, after) => `last ${before} → ${after}`,
  },
  trend: (turns) => `Last ${turns} turns`,
  note: {
    omp: "Total is exact (the prompt size the provider reported). Categories are omp's estimates.",
    transcript: "Total is exact. Categories are a coarse split from the transcript; omp gave no breakdown.",
  },
  duration: {
    seconds: (n) => `${n} s`,
    minutes: (n) => `${n} min`,
    hours: (h, m) => `${h} h ${m}`,
    days: (n) => `${n} d`,
  },
  empty: {
    loading: 'Reading the context…',
    noSession: ['No session open', 'Open a session to see its context.'],
    noTurn: ['No reply yet', "The context shows after the agent's first reply."],
    notFound: 'Context not found',
    unreachable: 'The Context service does not answer. Check that it is approved in Settings → Extensions.',
    reasons: {
      'bad-request': 'Unreadable request: reopen the section.',
      'no-session': 'Open a session to see its context.',
      unreachable: 'The omp sidecar does not answer. Check that it is running.',
      'session-not-found': 'The sidecar does not know this session.',
      'no-window': "The model's window is unknown: open the model picker once so the sidecar learns it.",
      failed: 'The context cannot be read right now.',
    },
  },
};

const CATALOG: Record<string, Messages> = { fr, en };

/** The host's language when there is a translation for it, else English. */
export function messagesFor(locale: string | undefined): { locale: string; messages: Messages } {
  const language = (locale ?? 'en').toLowerCase().split(/[-_]/)[0]!;
  const messages = CATALOG[language];
  return messages ? { locale: locale!, messages } : { locale: 'en', messages: en };
}
