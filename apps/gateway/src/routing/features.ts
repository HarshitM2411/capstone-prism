import type { ChatMessage } from '../http/validate.js';

/**
 * The structural half of the `auto` difficulty classifier (architecture §4.4): cheap signals read
 * from the *task being asked*, not from how much text surrounds it.
 *
 * Two rules shape everything here:
 *  1. Only a bounded window is analysed: the opening sentence and the final instruction. A long
 *     roster, log or email with a trivial question at the end is judged by that question, and a
 *     very long prompt costs no more to classify than a short one.
 *  2. Length is at most a weak feature. Short-but-hard ("prove that ...") must be able to beat
 *     long-but-trivial.
 *
 * The weights are authored from general principles and tuned on our own development prompts
 * (`apps/gateway/eval/routing_dev.jsonl`). The provided `routing_eval.jsonl` is never read here.
 */

export interface Signal {
  name: string;
  /** Added to the difficulty score when the pattern matches; negative means "looks simple". */
  weight: number;
  pattern: RegExp;
  /** The signal counts once per distinct match, up to this many times (default 1). */
  maxCount?: number;
}

/** Evidence of a task that needs reasoning, construction or judgement. */
const COMPLEX_SIGNALS: readonly Signal[] = [
  {
    name: 'proof',
    weight: 2.4,
    pattern:
      /\b(prove|disprove|proof|derive|derivation|show that|demonstrate that|by induction|contradiction)\b/,
  },
  {
    name: 'reasoning',
    weight: 1.4,
    pattern:
      /\b(show your (reasoning|work|calculations)|step[- ]by[- ]step|walk me through|walk through|justify|justification|reason (step|through|about)|argue|rigorous)\b/,
  },
  {
    name: 'design',
    weight: 1.6,
    pattern:
      /\b(design|architect|architecture|blueprint|roadmap|strategy|migration plan|rollout plan|(create|draft|outline|propose|devise|write) (a|an|the) (\w+ ){0,3}(plan|strategy|design|architecture|approach)|plan (to|for) (migrat|roll|reduc|mov))/,
  },
  {
    name: 'compare',
    weight: 1.4,
    pattern:
      /\b(compare|contrast|trade-?offs?|pros and cons|versus|recommend|evaluate|assess|analy[sz]e|critique|argue both)\b/,
  },
  {
    name: 'estimate',
    weight: 1.8,
    pattern: /\b(estimate (how|the)|fermi|back[- ]of[- ]the[- ]envelope|order of magnitude)\b/,
  },
  {
    name: 'diagnose',
    weight: 1.4,
    pattern:
      /\b(root cause|(most|more) (likely|probable|plausible) causes?|likely causes|what (could|might) cause|how (would|do|can|could) (you|we) (debug|diagnose|investigate|track down|confirm|detect|mitigate|prevent|isolate|avoid|handle|ensure)|troubleshoot)\b/,
  },
  { name: 'why', weight: 0.9, pattern: /\bwhy\b/ },
  {
    name: 'expert-topic',
    weight: 0.7,
    maxCount: 3,
    pattern:
      /\b(distributed|consensus|consistency|quorum|replicat\w+|partition(ed|s)?|concurren\w+|deadlocks?|race conditions?|thread[- ]safe|idempoten\w+|latency|throughput|scalab\w+|sharding|p9[59]|big[- ]o|complexity|amortized|algorithms?|recurrence|asymptotic|theorem|lemma|undecidable|np-hard|gradient|convergence|eigen\w+|cryptograph\w+|garbage collect\w+|memory (leak|barrier)s?|transactions?|isolation level|microservices?|monolith|bottlenecks?|failure modes?|fault[- ]toleran\w+|cache invalidation|load balanc\w+|rate limit\w*|leader election|data structures?)\b/,
  },
  {
    name: 'build-code',
    weight: 1.0,
    pattern:
      /\b(write|implement|code|create|build)\b.{0,40}\b(function|class|program|algorithm|query|script|module|parser|data structure|cache)\b/,
  },
  {
    name: 'explain-deep',
    weight: 1.0,
    pattern: /\bexplain\b.{0,60}\b(how|why|mechanism|works?)\b/,
  },
  {
    name: 'multi-part',
    weight: 0.8,
    pattern:
      /\b(and explain|and justify|with justification|including how|discuss|give (me )?(three|several|a few|\d+)|each stage|at each|list (the )?(most|several))\b/,
  },
  { name: 'numbered-steps', weight: 0.8, pattern: /(^|\s)(1[.)]|\(1\))\s.*(\s2[.)]|\s\(2\))/ },
  {
    name: 'code-or-math',
    weight: 1.0,
    pattern: /```|[∫∑√∞≤≥]|\bdef\s+\w+\(|\bfunction\s+\w+\(|\bO\(|\\frac|\bselect\b.+\bfrom\b/,
  },
];

/** Evidence of a closed, mechanical or look-up task. */
const SIMPLE_SIGNALS: readonly Signal[] = [
  {
    name: 'transform',
    weight: -1.6,
    pattern:
      /\b(translate|convert|extract|rewrite|rephrase|paraphrase|proofread|fix the (grammar|spelling|typo)|correct the (grammar|spelling)|capitali[sz]e|alphabetical|sort (these|the)|reverse|spell|synonym|antonym|plural|define|stand for|pick out|reformat|shorten|one[- ]line|one[- ]sentence|in one sentence|two[- ]line|haiku|yes or no|reply with)\b/,
  },
  { name: 'summarize', weight: -0.8, pattern: /\bsummari[sz]e\b/ },
  { name: 'factoid', weight: -1.0, pattern: /^(who|when|where|which)\b/ },
  {
    name: 'meaning',
    weight: -1.2,
    pattern: /^what does\b.*\b(mean|stand for|do|return)\b/,
  },
  {
    name: 'short-definition',
    weight: -0.8,
    pattern: /^what (is|are|was|were) (the |a |an )?[\w' -]{1,40}\?$/,
  },
  { name: 'yes-no', weight: -0.8, pattern: /^(is|are|does|do|can|was|were) [^,;]{1,70}\?$/ },
  { name: 'count-lookup', weight: -0.6, pattern: /^how many\b/ },
  {
    name: 'short-writing',
    weight: -1.0,
    pattern:
      /^(write|give me|draft|compose) (a|an) (short|brief|one|friendly|polite|quick|simple)\b/,
  },
  {
    name: 'list-or-name',
    weight: -0.8,
    pattern: /^(list|name|give me a) (the |three |two |a )?[\w' -]{1,40}[.?]?$/,
  },
];

/** How much of a long prompt is kept: its opening sentence and the final instruction. */
export const HEAD_CHARS = 220;
export const TAIL_CHARS = 260;
/** Prompts up to this long are analysed whole. */
export const SHORT_PROMPT_CHARS = 450;
/** Weak pull towards "complex" for longer instructions; never decisive on its own. */
const LENGTH_WEIGHT = 0.4;

export interface Analysis {
  /** The text that was analysed (and embedded). */
  window: string;
  /** The prompt was longer than the window and only its opening and final instruction were used. */
  windowed: boolean;
  /** Matched signals, `+name` / `-name`, in order of strength. */
  signals: string[];
  /** Sum of the signal weights plus the weak length term. */
  score: number;
}

/** The last user message is the task; earlier turns and the system prompt are context. */
export function taskText(messages: readonly ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === 'user' && message.content.trim() !== '') return message.content;
  }
  return messages.at(-1)?.content ?? '';
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9'"([])/).filter((s) => s.trim() !== '');
}

/** The opening sentence and the final instruction of a long prompt; short prompts whole. */
export function instructionWindow(text: string): { window: string; windowed: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SHORT_PROMPT_CHARS) return { window: flat, windowed: false };

  const parts = sentences(flat);
  const head = (parts[0] ?? flat).slice(0, HEAD_CHARS);
  let tail = parts.at(-1) ?? flat.slice(-TAIL_CHARS);
  // A very short last sentence ("Why?") is only meaningful with the one before it.
  if (tail.length < 60 && parts.length > 2) tail = `${parts.at(-2)!} ${tail}`;
  tail = tail.slice(-TAIL_CHARS);
  return { window: head === tail ? head : `${head} ${tail}`, windowed: true };
}

function matches(signal: Signal, text: string): number {
  const flags = signal.pattern.flags.includes('g')
    ? signal.pattern.flags
    : `${signal.pattern.flags}g`;
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(signal.pattern.source, flags))) {
    found.add(match[0].toLowerCase());
  }
  return Math.min(found.size, signal.maxCount ?? 1);
}

/** Structural analysis of a prompt: which signals fire and what they add up to. */
export function analyze(text: string): Analysis {
  const { window, windowed } = instructionWindow(text);
  const lower = window.toLowerCase();

  const fired: { name: string; contribution: number }[] = [];
  for (const signal of [...COMPLEX_SIGNALS, ...SIMPLE_SIGNALS]) {
    // Opening-anchored patterns look at where an instruction starts: the first and last sentence.
    const targets = signal.pattern.source.startsWith('^') ? instructionStarts(lower) : [lower];
    const count = Math.max(...targets.map((target) => matches(signal, target)));
    if (count > 0) fired.push({ name: signal.name, contribution: signal.weight * count });
  }

  const length = LENGTH_WEIGHT * Math.min(1, window.length / SHORT_PROMPT_CHARS);
  const score = fired.reduce((sum, f) => sum + f.contribution, 0) + length;
  fired.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return {
    window,
    windowed,
    signals: fired.map((f) => `${f.contribution > 0 ? '+' : '-'}${f.name}`),
    score,
  };
}

/** The sentences an opening-anchored pattern is tried on: where an instruction can start. */
function instructionStarts(lowerWindow: string): string[] {
  const parts = sentences(lowerWindow);
  if (parts.length <= 1) return [lowerWindow];
  return [...new Set([parts[0]!, parts.at(-1)!])];
}
