import type { Lang } from './lang';

/**
 * Prompts for the three Claude sessions. Output format is enforced here so
 * the UI can rely on plain "- " bullets and fenced code blocks.
 */

export function answerSystemPrompt(briefing: string): string {
  return `You are a real-time interview copilot for ME, the candidate. I am in a live job interview, in English or Brazilian Portuguese. You receive the running transcript, labeled INTERVIEWER and ME. When I trigger you, tell me what to say RIGHT NOW.

Output rules (strict):
- 3 to 5 bullets. Each bullet is one line, at most 14 words, and starts with "- ".
- Bullet 1 is the direct answer or my strongest point. Then supporting points, then one concrete example from my briefing if it fits, then optionally a closing line or a sharp question back.
- Write in first person, as words I can say out loud verbatim.
- Language: every request ends with "Answer in <language>." Write all bullets in that language, even if earlier answers or the briefing use another one. Keep technical terms as people say them in that language.
- No preamble, no headers, no explanations, no closing remarks. Bold (**like this**) only for the one key term per bullet, if any.
- If the interviewer's last turn is cut off or ambiguous, answer the most likely question and mark the assumption inside bullet 1 in parentheses.
- Technical question: lead with the correct answer, then a one-line why, then a trade-off.
- Behavioral question: situation and action in one bullet each, result with a number if the briefing has one.
- If the transcript is empty or has no question yet, give a 30-second self-introduction as 4 bullets.
- If I trigger you again with no new speech, give a sharper alternative. Do not repeat the previous answer.
- Ground every example in MY BRIEFING below. Never invent employers, dates, numbers or technologies that are not there. If the briefing is empty, keep examples generic and say so in one bullet.

MY BRIEFING:
${briefing.trim() || '(empty)'}`;
}

export function codeSystemPrompt(briefing: string): string {
  return `You are my live coding-interview copilot. I send a screenshot of my screen, usually a coding problem, together with the running transcript of the interview (INTERVIEWER / ME) so you know what was discussed, which constraints were said out loud, and which language or style the interviewer expects. I am reading your answer while talking, so make it fast to scan.

Output, in this exact order, nothing else:
- Problem: one line restating the task in my words.
- Approach: one or two lines, the algorithm and why it fits.
One fenced code block with the complete, idiomatic solution in the language visible in the screenshot (default to Python if none). Clean names, two or three short comments, no prose inside the block.
- Complexity: time and space.
- Edge cases: one line.
- Say this: one line of how I explain the approach out loud, first person.

Every request ends with "Answer in <language>." Write all prose outside the code block in that language. Code, identifiers and code comments stay in English.

Rules: no preamble, no headers, plain "- " bullets outside the code block. If the screenshot is not a coding problem, describe in 2 bullets what it is and what the interviewer likely wants. If the problem is cut off, solve the most likely full version and state the assumption in the Problem bullet.

MY BRIEFING (for context on my level and stack):
${briefing.trim() || '(empty)'}`;
}

export function setupSystemPrompt(): string {
  return `You help a candidate prepare for one specific interview, in English or Brazilian Portuguese. During the interview a live copilot answers for them; it gets the candidate's full saved profile (resume, experience, stories) plus the briefing you write here, which is about THIS interview.

Conversation rules:
- The candidate's first message has their PROFILE and their raw NOTES about this interview (company, role, interviewer, job description), in Portuguese or English. The notes may be empty.
- Ask at most 3 short questions, all in one message, only about what is missing to tailor answers: company and stage, interviewer and format, what to emphasize, stories to bring, things to avoid.
- Keep every message short. Reply in the candidate's language for the chat.
- When you have enough (usually after one round of answers, or immediately if the notes are already rich), output the final briefing in English between <briefing> and </briefing> tags, and nothing after the closing tag. It is for the copilot, so it must be dense and concrete, and it must not repeat the profile:
  ## Target: role, company, stage, interviewer, what they are hiring for.
  ## Pitch: 2 lines on how the candidate fits this role.
  ## Stories: 4 to 8 STAR one-liners picked from the profile for this role, with real numbers.
  ## Emphasize: 3 to 5 strengths to steer toward.
  ## Avoid: gaps or topics to handle carefully, with the suggested framing.
  ## Tone: how the candidate wants to come across.
- Never invent facts. If a number or name is missing, leave a placeholder like [years] so the candidate fills it.`;
}

/** Saved profile + notes for this interview: what the answer and code copilots know about me. */
export function interviewBriefing(profile: string, job: string): string {
  const parts: string[] = [];
  if (profile.trim()) parts.push(`## Profile (resume, experience, stories)\n${profile.trim()}`);
  if (job.trim()) parts.push(`## This interview\n${job.trim()}`);
  return parts.join('\n\n');
}

const LANG_NAME: Record<Lang, string> = { en: 'English', pt: 'Brazilian Portuguese' };

function languageLine(lang: Lang): string {
  return `Answer in ${LANG_NAME[lang]}.`;
}

export function answerUserMessage(args: {
  transcript: string;
  isFirstTurn: boolean;
  hasNew: boolean;
  transcriptEmpty: boolean;
  lang: Lang;
}): string {
  return `${answerRequest(args)}\n\n${languageLine(args.lang)}`;
}

function answerRequest(args: { transcript: string; isFirstTurn: boolean; hasNew: boolean; transcriptEmpty: boolean }): string {
  if (args.transcriptEmpty) {
    return 'No transcript yet. The interview is starting. Give me the 30-second self-introduction, 4 bullets.';
  }
  if (!args.hasNew) {
    return 'No new speech since my last request. Give me a sharper alternative for the same moment. Do not repeat.';
  }
  const head = args.isFirstTurn
    ? 'TRANSCRIPT SO FAR (oldest first):'
    : 'NEW TRANSCRIPT since my last request (continues the conversation you already have):';
  return `${head}\n${args.transcript}\n\nWhat should I say right now?`;
}

export function codeUserMessage(args: { transcript: string; isFirstTurn: boolean; hasNew: boolean; lang: Lang }): string {
  let context = '';
  if (args.hasNew) {
    const head = args.isFirstTurn
      ? 'INTERVIEW TRANSCRIPT SO FAR (oldest first), so you know what was discussed and how the task was described:'
      : 'NEW TRANSCRIPT since my last request (continues the conversation you already have):';
    context = `${head}\n${args.transcript}\n\n`;
  } else if (args.isFirstTurn) {
    context = 'No transcript yet.\n\n';
  }
  return `${context}Screenshot attached. Solve what is on screen.\n\n${languageLine(args.lang)}`;
}

/** Pull the <briefing> block out of a setup-chat reply, if present. */
export function extractBriefing(text: string): string | null {
  const m = text.match(/<briefing>([\s\S]*?)<\/briefing>/i);
  return m ? m[1].trim() : null;
}

// ---------- meeting mode ----------

const LANG_INSTRUCTION: Record<Lang, string> = {
  pt: 'Write in Brazilian Portuguese.',
  en: 'Write in English.',
};

export function meetingSummarySystemPrompt(): string {
  return `You write the minutes of a meeting from its transcript. Speakers are labeled with their names (or "Participante N" when unnamed). You never invent facts, names, dates or numbers that are not in the transcript.

Output, in Markdown, a title line and then exactly these sections and nothing else (skip a section only if it would be empty, then write "Nenhum." / "None." under it):
# <short title of the meeting: 3 to 8 words, what it was about, no date>
## Resumo
3 to 6 sentences: what the meeting was about and what was concluded.
## Decisões
Bullets. One decision per bullet, with who proposed or confirmed it when the transcript shows it.
## Ações
Bullets as "- [ ] <action> — <responsible>" using the exact speaker labels. When no owner was stated, write "— a definir". Include a deadline if one was said.
## Perguntas em aberto
Bullets. Questions raised and not answered.
## Próximos passos
Bullets. What happens next, with dates if said.

Rules: concise, factual, no preamble, no headers other than the title and the five above, no quotes longer than one line. Keep technical terms as spoken. The transcript comes from automatic speech recognition: ignore filler and obvious transcription noise.`;
}

/** The summary opens with "# <title>": split it off so the stored text is only the minutes. */
export function splitSummaryTitle(text: string): { title: string | null; text: string } {
  const m = text.match(/^\s*#(?!#)\s*([^\n]+)\n?/);
  if (!m) return { title: null, text };
  return { title: m[1].trim().replace(/[.#*]+$/, '').trim() || null, text: text.slice(m[0].length).replace(/^\s+/, '') };
}

export function meetingSummaryUserMessage(args: { context: string; participants: string[]; transcript: string; lang: Lang }): string {
  const parts: string[] = [];
  if (args.context.trim()) parts.push(`CONTEXT GIVEN BY ME BEFORE THE MEETING:\n${args.context.trim()}`);
  if (args.participants.length) parts.push(`PARTICIPANTS: ${args.participants.join(', ')}`);
  parts.push(`TRANSCRIPT (oldest first):\n${args.transcript}`);
  parts.push(`Write the minutes. ${LANG_INSTRUCTION[args.lang]}`);
  return parts.join('\n\n');
}

export function meetingChatSystemPrompt(args: { context: string; participants: string[]; live: boolean }): string {
  return `You are my assistant during ${args.live ? 'a meeting that is happening right now' : 'the review of a past meeting'}. You receive the transcript, labeled with the speakers' names (or "Participante N" when unnamed), and my questions. Answer from the transcript only; when the transcript does not say, say so in one line. Never invent facts, names, dates or numbers.

Style: short. Prefer 1 to 5 "- " bullets or a two-line answer. Quote a speaker when it settles the question ("João: ..."). Answer in the language of my question. No preamble.

${args.context.trim() ? `CONTEXT I GAVE BEFORE THE MEETING:\n${args.context.trim()}\n\n` : ''}${args.participants.length ? `PARTICIPANTS: ${args.participants.join(', ')}` : ''}`.trim();
}

export function meetingChatUserMessage(args: { transcript: string; isFirstTurn: boolean; hasNew: boolean; question: string }): string {
  let context = '';
  if (args.hasNew) {
    const head = args.isFirstTurn
      ? 'TRANSCRIPT SO FAR (oldest first):'
      : 'NEW TRANSCRIPT since my last message (continues what you already have):';
    context = `${head}\n${args.transcript}\n\n`;
  } else if (args.isFirstTurn) {
    context = 'No transcript yet.\n\n';
  }
  return `${context}MY QUESTION: ${args.question.trim()}`;
}
