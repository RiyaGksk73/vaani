/**
 * Structural enforcement of the localisation rules.
 *
 * An LLM chat endpoint lets you *ask* for "preserve placeholders, keep line
 * breaks, never summarise". Sarvam's /translate is a pure text-in/text-out
 * endpoint with no system prompt, so asking is not an option. Every rule is
 * enforced by construction instead:
 *
 *   character names   -> split off the speaker prefix, translate only the line
 *   placeholders      -> masked to sentinels, restored after, verified
 *   line breaks       -> each line translated separately, separators reattached
 *   numbering/bullets -> leading markers split off and reattached
 *   punctuation       -> leading/trailing whitespace and markers never sent
 *   no summarising    -> the model only ever sees one line at a time
 *
 * Verification is the part that matters: if a sentinel does not come back, we
 * refuse the result rather than shipping a line with a mangled placeholder.
 * A flagged row is recoverable; silent corruption in a million-row script is
 * not.
 */

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

/**
 * Patterns treated as untranslatable. Ordered longest-construct-first so that
 * `{{name}}` is matched before `{name}` and `%1$s` before `%s`.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\{[^{}\n]{0,80}\}\}/g, // {{handlebars}}
  /\{[^{}\n]{0,80}\}/g, //     {single_brace}
  /\[\[[^\[\]\n]{0,80}\]\]/g, // [[wiki style]]
  /\[(?:SFX|VO|OS|SUPER|CAPTION|SOUND)[^\]\n]{0,80}\]/gi, // [SFX: door slams]
  /<\/?[A-Za-z][A-Za-z0-9-]{0,30}(?:\s[^<>\n]{0,80})?>/g, // <b>, </i>, <br/>
  /%\d+\$[sdif]/g, //          %1$s
  /%[sdif]/g, //               %s
  /\$\{[^}\n]{0,80}\}/g, //    ${template}
  /\$[A-Z_][A-Z0-9_]{0,40}/g, // $SHOUTY_VAR
];

/** Sentinel styles, tried in order when a translation loses its markers. */
const TOKEN_STYLES = [
  (i: number) => `#${i}#`,
  (i: number) => `((${i}))`,
] as const;

export interface Placeholder {
  token: string;
  original: string;
}

export interface ProtectedText {
  masked: string;
  placeholders: Placeholder[];
}

export const PLACEHOLDER_STYLE_COUNT = TOKEN_STYLES.length;

/**
 * Replace every placeholder with a sentinel. `style` selects the sentinel
 * shape so a failed round-trip can be retried with a different one.
 */
export function protect(text: string, style = 0): ProtectedText {
  const makeToken = TOKEN_STYLES[style % TOKEN_STYLES.length]!;
  const placeholders: Placeholder[] = [];
  let masked = text;

  for (const pattern of PLACEHOLDER_PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), (match) => {
      // Never mask a sentinel we just wrote, or we would nest them.
      if (placeholders.some((p) => p.token === match)) return match;
      const token = makeToken(placeholders.length);
      placeholders.push({ token, original: match });
      return token;
    });
  }

  return { masked, placeholders };
}

/** Put the original placeholders back. */
export function restore(text: string, placeholders: readonly Placeholder[]): string {
  let out = text;
  for (const { token, original } of placeholders) {
    out = out.split(token).join(original);
  }
  return out;
}

/**
 * Sentinels the model failed to return. A non-empty result means the output
 * cannot be trusted and the segment must be retried or flagged.
 */
export function missingTokens(
  translated: string,
  placeholders: readonly Placeholder[],
): string[] {
  return placeholders.filter((p) => !translated.includes(p.token)).map((p) => p.token);
}

// ---------------------------------------------------------------------------
// Line structure
// ---------------------------------------------------------------------------

/** Splits text into lines while remembering the exact separators used. */
export function splitLines(text: string): { lines: string[]; separators: string[] } {
  const lines: string[] = [];
  const separators: string[] = [];
  const pattern = /\r\n|\r|\n/g;

  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    lines.push(text.slice(last, match.index));
    separators.push(match[0]);
    last = match.index + match[0].length;
  }
  lines.push(text.slice(last));

  return { lines, separators };
}

export function joinLines(lines: readonly string[], separators: readonly string[]): string {
  return lines.reduce(
    (acc, line, i) => (i === 0 ? line : acc + (separators[i - 1] ?? "\n") + line),
    "",
  );
}

/**
 * Leading list markers: "1. ", "1) ", "- ", "* ", "• ", "12.3 ".
 * Kept out of the payload so numbering survives verbatim.
 */
const MARKER_PATTERN = /^(\s*(?:(?:\d+(?:\.\d+)*[.)]|[-*•–—])\s+))/;

/**
 * Speaker prefix: "RAJU: ", "Raju (angry): ", "Mrs. D'Souza: ".
 *
 * Deliberately conservative - a colon inside ordinary prose ("Listen: I said
 * no") must not be mistaken for a speaker. The prefix has to be short, hold at
 * most four words, and carry no sentence-ending punctuation.
 */
const SPEAKER_PATTERN = /^([^\n:]{1,48}?)(\s*:\s+)/;

/**
 * The same prefix in Markdown bold, as scripts pasted from Docs or a chat tool
 * arrive: "**Him:** “What?”". The closing "**" sits after the colon, so the
 * plain pattern never matches and the label used to be sent off and
 * translated as dialogue.
 */
const BOLD_SPEAKER_PATTERN = /^(\*\*|__)([^\n:*_]{1,48}?)(\s*:\s*\1\s*|\s*\1\s*:\s+)/;

export interface LineParts {
  /** Whitespace + list marker, e.g. "  1. ". Never translated. */
  marker: string;
  /** Speaker name plus its separator, e.g. "RAJU: ". Never translated. */
  speaker: string;
  /** The only part that reaches the provider. */
  body: string;
  /** Trailing whitespace, preserved exactly. */
  trailing: string;
}

function looksLikeSpeaker(candidate: string, knownCharacters?: ReadonlySet<string>): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  if (knownCharacters?.has(trimmed.toLocaleLowerCase())) return true;

  // Parentheticals are part of the cue, not the name: "RAJU (angry)".
  const bare = trimmed.replace(/\s*\([^)]{0,40}\)\s*$/, "").trim();
  if (!bare) return false;
  if (bare.length > 40) return false;
  if (bare.split(/\s+/).length > 4) return false;
  if (/[.!?…।]$/.test(bare)) return false;
  if (!/\p{L}/u.test(bare)) return false;
  // A character name never contains brackets. Without this, the colon inside
  // a stage cue like "[SFX: door creaks]" reads as a speaker separator and the
  // cue gets torn in half. (Sentinels such as "#0#" are deliberately allowed,
  // so a masked cue can still sit in front of a real speaker.)
  if (/[[\]{}<>]/.test(bare)) return false;

  return true;
}

export function splitLine(line: string, knownCharacters?: ReadonlySet<string>): LineParts {
  let rest = line;

  const markerMatch = MARKER_PATTERN.exec(rest);
  const marker = markerMatch?.[1] ?? "";
  if (marker) rest = rest.slice(marker.length);

  // Leading whitespace not already eaten by a marker.
  const leadMatch = /^\s+/.exec(rest);
  const lead = leadMatch?.[0] ?? "";
  if (lead) rest = rest.slice(lead.length);

  let speaker = "";
  const boldMatch = BOLD_SPEAKER_PATTERN.exec(rest);
  const speakerMatch = SPEAKER_PATTERN.exec(rest);
  if (boldMatch && looksLikeSpeaker(boldMatch[2]!, knownCharacters)) {
    speaker = boldMatch[0];
    rest = rest.slice(speaker.length);
  } else if (speakerMatch && looksLikeSpeaker(speakerMatch[1]!, knownCharacters)) {
    speaker = speakerMatch[1]! + speakerMatch[2]!;
    rest = rest.slice(speaker.length);
  }

  const trailMatch = /\s+$/.exec(rest);
  const trailing = trailMatch?.[0] ?? "";
  if (trailing) rest = rest.slice(0, rest.length - trailing.length);

  return { marker: marker + lead, speaker, body: rest, trailing };
}

/** "**Him:** " -> "Him". The bare name, for giving a model context. */
export function speakerName(speaker: string): string {
  return speaker.replace(/[*_]/g, "").replace(/\s*:\s*$/, "").trim();
}

/**
 * Split an imported line into speaker and dialogue. Accepts "Raju: text" and
 * the Markdown-bold "**Raju:** text". Null speaker means narration or a cue.
 */
export function parseScriptLine(line: string): { characterName: string | null; text: string } {
  const bold = BOLD_SPEAKER_PATTERN.exec(line);
  if (bold && looksLikeSpeaker(bold[2]!) && line.length > bold[0].length) {
    return { characterName: bold[2]!.trim(), text: line.slice(bold[0].length).trim() };
  }
  const plain = SPEAKER_PATTERN.exec(line);
  if (plain && looksLikeSpeaker(plain[1]!) && line.length > plain[0].length) {
    return { characterName: plain[1]!.trim(), text: line.slice(plain[0].length).trim() };
  }
  return { characterName: null, text: line };
}

export function joinLine(parts: LineParts, translatedBody: string): string {
  return parts.marker + parts.speaker + translatedBody + parts.trailing;
}

// ---------------------------------------------------------------------------
// Translatability
// ---------------------------------------------------------------------------

/**
 * True when the text contains at least one letter. Lines that are pure
 * punctuation, digits, or placeholders ("...", "---", "{count}") are returned
 * unchanged and never cost an API call.
 */
export function hasTranslatableContent(text: string): boolean {
  return /\p{L}/u.test(text);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Sentence terminators, including the Devanagari danda and double danda. */
const SENTENCE_END = /([.!?…।॥]+["'”’)\]]*\s+)/;

/**
 * Split text so every chunk fits `maxChars`, preferring sentence boundaries,
 * then clause boundaries, then whitespace. A chunk is only hard-cut mid-word
 * when a single unbroken run genuinely exceeds the limit.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const sentences = text.split(SENTENCE_END).reduce<string[]>((acc, part, i, arr) => {
    // split() with a capturing group interleaves text and delimiters.
    if (i % 2 === 0) acc.push(part + (arr[i + 1] ?? ""));
    return acc;
  }, []);

  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };

  for (const sentence of sentences) {
    if (!sentence) continue;

    if (current.length + sentence.length <= maxChars) {
      current += sentence;
      continue;
    }

    push();

    if (sentence.length <= maxChars) {
      current = sentence;
      continue;
    }

    // A single sentence over the limit: fall back to clauses, then words.
    for (const piece of splitLongRun(sentence, maxChars)) {
      if (current.length + piece.length <= maxChars) {
        current += piece;
      } else {
        push();
        current = piece;
      }
    }
  }

  push();
  return chunks.filter((c) => c.length > 0);
}

function splitLongRun(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let remaining = text;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    // Prefer a clause break, then any whitespace, then give up and hard-cut.
    const clause = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
    const space = window.lastIndexOf(" ");
    const cut = clause > maxChars * 0.5 ? clause + 2 : space > 0 ? space + 1 : maxChars;

    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  if (remaining) out.push(remaining);
  return out;
}
