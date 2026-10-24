// Turning model text into something a small speaker can say.
//
// A Pipbit speaks every reply aloud, so markdown, links, emoji and tables
// would be read out as noise ("asterisk asterisk", "h t t p s colon"). The
// model is asked for plain speech (the channel's formatting hints), but this
// pass makes sure: it keeps the words, drops the markup, and caps the length
// at a sentence boundary. Pure: no I/O, no OpenClaw.

/** About how much a Pipbit should say in one reply (characters). */
export const DEFAULT_SPEECH_MAX_CHARS = 1500;

export interface SpeechOptions {
  /** Cap on the result, cut back to the last full sentence that fits. */
  maxChars?: number;
}

type LineKind = "text" | "sentence";

interface Line {
  kind: LineKind;
  text: string;
}

const FENCE = /^\s*(```|~~~)/;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/;
const BLOCK_QUOTE = /^\s*(>\s?)+/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/;
const TASK_BOX = /^\[[ xX]\]\s+/;

// Emoji and their glue: pictographs, variation selectors, zero-width joiners,
// skin tones, regional indicator letters (flags) and the keycap mark.
const EMOJI =
  /\p{Extended_Pictographic}|[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]|[\u{1F3FB}-\u{1F3FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;

const TERMINAL_PUNCTUATION = /[.!?:;…]["')\]]*$/;

// One or more bracketed citation numbers (optionally footnote-style or
// linked), or the 【n†source】 form some models use.
const CITATION = /\s*(?:\[\^?\d{1,3}\](?:\([^)\s]*\))?|【[^】]*†[^】]*】)+/g;

/**
 * Strip markdown and other visual formatting, drop emoji, collapse
 * whitespace and cap the length, so the text reads well aloud.
 * Returns "" when nothing speakable is left.
 */
export function sanitizeForSpeech(input: string, options: SpeechOptions = {}): string {
  const maxChars = Math.max(1, Math.floor(options.maxChars ?? DEFAULT_SPEECH_MAX_CHARS));
  if (typeof input !== "string" || input.trim() === "") {
    return "";
  }
  const paragraphs = toParagraphs(input);
  const spoken = paragraphs
    .map((lines) => joinParagraph(lines))
    .filter((paragraph) => paragraph !== "")
    .join(" ");
  return capAtSentence(tidy(spoken), maxChars);
}

/** Split into paragraphs of classified lines, block markup removed. */
function toParagraphs(input: string): Line[][] {
  const rawLines = input.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs: Line[][] = [];
  let current: Line[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      paragraphs.push(current);
      current = [];
    }
  };

  for (const raw of rawLines) {
    if (FENCE.test(raw)) {
      // A code fence opens or closes a block: keep the lines inside as plain
      // text, but never the fence itself or its language word.
      flush();
      continue;
    }
    if (raw.trim() === "") {
      flush();
      continue;
    }
    if (HORIZONTAL_RULE.test(raw) || TABLE_SEPARATOR.test(raw)) {
      flush();
      continue;
    }
    if (SETEXT_UNDERLINE.test(raw) && current.length > 0) {
      // "Title\n=====": the line above was a heading.
      const last = current[current.length - 1];
      if (last) {
        last.kind = "sentence";
      }
      flush();
      continue;
    }

    let text = raw.replace(BLOCK_QUOTE, "");
    const heading = HEADING.exec(text);
    if (heading) {
      flush();
      pushLine(current, "sentence", heading[1] ?? "");
      flush();
      continue;
    }
    if (isTableRow(text)) {
      const cells = text
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => inline(cell))
        .filter((cell) => cell !== "");
      if (cells.length > 0) {
        pushLine(current, "sentence", cells.join(", "), false);
      }
      continue;
    }
    const item = LIST_ITEM.exec(text);
    if (item) {
      text = capitalize(inline((item[1] ?? "").replace(TASK_BOX, "")));
      pushLine(current, "sentence", text, false);
      continue;
    }
    pushLine(current, "text", text);
  }
  flush();
  return paragraphs;
}

function pushLine(lines: Line[], kind: LineKind, text: string, applyInline = true): void {
  const cleaned = applyInline ? inline(text) : text;
  if (cleaned !== "") {
    lines.push({ kind, text: cleaned });
  }
}

/** A list item reads as its own sentence, so it starts with a capital. */
function capitalize(text: string): string {
  return text.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.length > 1;
}

/** Inline markup: links, code spans, emphasis, HTML tags, URLs, emoji. */
function inline(text: string): string {
  let out = text;
  // Images say nothing aloud; links keep their label.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // Citation markers from search results would be read out as stray
  // numbers: [1], [2][3], [^1], [4](https://...), and 【5†source】. Dropped
  // with the space before them, and before the reference-link rule below,
  // which would otherwise read "[2][3]" as a link labelled 2.
  out = out.replace(CITATION, "");
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, (_match, label: string) =>
    label.trim() === "" ? "a link" : label,
  );
  // Reference-style links: [label][ref] -> label.
  out = out.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Autolinks and bare URLs.
  out = out.replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, "a link");
  out = out.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi, "a link");
  // Inline code: keep the words, drop the backticks.
  out = out.replace(/`+([^`]*)`+/g, "$1");
  out = out.replace(/`/g, "");
  // HTML-ish tags (<br>, <b>, </i>).
  out = out.replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, " ");
  // Emphasis: bold, italic, strike. Only markers that hug words, so
  // arithmetic ("2 * 3") and snake_case survive.
  out = out.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2");
  out = out.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1");
  out = out.replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1");
  // Struck-through words were taken back: drop them.
  out = out.replace(/~~(?=\S)[\s\S]*?\S~~/g, " ");
  // Heading or emphasis leftovers at the edges ("**", "#").
  out = out.replace(/(^|\s)(\*{2,}|_{2,}|#{1,6})(?=\s|$)/g, "$1");
  out = out.replace(EMOJI, "");
  return out.replace(/\s+/g, " ").trim();
}

/** Join a paragraph's lines, closing list items, headings and rows as sentences. */
function joinParagraph(lines: Line[]): string {
  const parts: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    const next = lines[index + 1];
    const closes = line.kind === "sentence" || !next || next.kind === "sentence";
    parts.push(closes ? endSentence(line.text) : line.text);
  }
  return parts.join(" ");
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "" || TERMINAL_PUNCTUATION.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}.`;
}

function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.!?])\.+(?=\s|$)/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut to maxChars at the last sentence end that fits, else at a word. */
function capAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const window = text.slice(0, maxChars);
  let cut = -1;
  const sentenceEnd = /[.!?…]["')\]]*(?=\s)/g;
  for (let match = sentenceEnd.exec(window); match; match = sentenceEnd.exec(window)) {
    cut = match.index + match[0].length;
  }
  if (window.length === maxChars && /[.!?…]$/.test(window) && text[maxChars] === " ") {
    cut = maxChars;
  }
  if (cut >= Math.floor(maxChars * 0.5)) {
    return window.slice(0, cut).trim();
  }
  const lastSpace = window.lastIndexOf(" ");
  const base = (lastSpace > 0 ? window.slice(0, lastSpace) : window).replace(/[\s,;:]+$/, "");
  if (base.length >= maxChars) {
    return `${base.slice(0, maxChars - 1)}.`;
  }
  return `${base}.`;
}
