/**
 * Answer language. Deepgram `language=multi` tags every word with a BCP-47
 * code; we count those per utterance. When the tags are missing (a fixed
 * STT language, or an old model), a stopword count on the text decides.
 */

export type Lang = 'pt' | 'en';

export type LangCounts = Partial<Record<Lang, number>>;

/** Fewer words than this cannot move the answer language ("ok", "yeah", "tá"). */
export const MIN_WORDS_TO_SWITCH = 3;

export function normalizeLang(code: string | undefined | null): Lang | null {
  const c = (code ?? '').toLowerCase();
  if (c.startsWith('pt')) return 'pt';
  if (c.startsWith('en')) return 'en';
  return null;
}

/** Starting answer language for a fixed STT language; `multi` starts in English. */
export function initialLang(sttLanguage: string): Lang {
  return normalizeLang(sttLanguage) ?? 'en';
}

export function addCounts(into: LangCounts, from: LangCounts): void {
  for (const [k, v] of Object.entries(from) as Array<[Lang, number]>) into[k] = (into[k] ?? 0) + v;
}

/** Majority language, or null when there are too few tagged words or a tie. */
export function majority(counts: LangCounts): Lang | null {
  const pt = counts.pt ?? 0;
  const en = counts.en ?? 0;
  if (pt + en < MIN_WORDS_TO_SWITCH || pt === en) return null;
  return pt > en ? 'pt' : 'en';
}

const PT_WORDS = new Set([
  'que', 'não', 'nao', 'é', 'eu', 'você', 'voce', 'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'um', 'uma',
  'para', 'pra', 'com', 'por', 'mas', 'se', 'como', 'mais', 'muito', 'isso', 'essa', 'esse', 'então', 'entao', 'tá', 'ta',
  'estou', 'está', 'esta', 'foi', 'tem', 'ter', 'fazer', 'gente', 'também', 'tambem', 'quando', 'onde', 'porque',
  'sim', 'já', 'ja', 'aqui', 'ele', 'ela', 'eles', 'meu', 'minha', 'seu', 'sua', 'ao', 'aos', 'às', 'pelo', 'pela', 'sobre',
]);

const EN_WORDS = new Set([
  'the', 'and', 'is', 'are', 'was', 'were', 'i', "i'm", 'you', 'your', 'to', 'of', 'in', 'on', 'it', "it's", 'that',
  'this', 'for', 'with', 'what', 'how', 'why', 'when', 'where', 'we', 'they', 'have', 'has', 'do', 'does', 'did', 'can',
  'would', 'could', 'should', 'about', 'so', 'but', 'not', "don't", 'my', 'be', 'been', 'will', 'just', 'like',
  'yeah', 'there', 'their', 'from', 'at', 'an', 'or', 'if', 'our', 'tell',
]);

/** Stopword count fallback. Returns null when the text does not lean either way. */
export function guessLang(text: string): Lang | null {
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let pt = 0;
  let en = 0;
  for (const w of words) {
    if (PT_WORDS.has(w)) pt++;
    if (EN_WORDS.has(w)) en++;
    if (/[ãõçáéíóúâêô]/.test(w)) pt++;
  }
  return majority({ pt, en });
}
