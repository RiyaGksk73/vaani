# Vaani

Script localisation for comic, animation and dubbing teams. Books → episodes →
script rows, translated through Sarvam AI with translation memory, a background
queue, realtime progress and a human review loop that feeds corrections back
into the cache.

---

## Language coverage — read this first

Sarvam's `/translate` endpoint covers **English and the 22 scheduled Indian
languages**, and nothing else.

Spanish, French, German, Italian, Portuguese, Russian, Arabic, Japanese,
Korean, Chinese, Turkish, Indonesian, Thai and Vietnamese are **not reachable
through Sarvam**. The supported set is exactly what `src/services/translation/languages.ts`
lists — that file is the single source of truth, and the UI only ever offers
what is really there.

Reaching the wider set means registering a second provider (see
[Adding a provider](#adding-a-provider)). The provider layer is built for
exactly that; it just is not wired to anything else today.

| | Languages |
|---|---|
| **Supported** | English, Hindi, Bengali, Gujarati, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu, Assamese, Bodo, Dogri, Konkani, Kashmiri, Maithili, Manipuri, Nepali, Sanskrit, Santali, Sindhi, Urdu |
| **Needs another provider** | Spanish, French, German, Italian, Portuguese, Russian, Arabic, Japanese, Korean, Chinese, Turkish, Indonesian, Thai, Vietnamese |

---

## Getting started

```bash
npm install
cp .env.example .env.local      # fill in the values below
npm run check:sarvam            # confirms the Sarvam key works before anything else

supabase db push                # applies supabase/migrations/*
npm run dev                     # http://localhost:3000
npm run worker                  # in a second terminal - nothing translates without it
```

Sign up in the app (every account gets its own private workspace), then optionally:

```bash
npm run seed -- --email you@example.com --rows 5000
```

### Environment

| Variable | Where it is used |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | browser + server |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser + server, gated by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** — the worker; bypasses RLS |
| `SARVAM_API_KEY` | **server only** — never sent to the browser |
| `SARVAM_API_BASE_URL` | `https://api.sarvam.ai` |
| `SARVAM_MODEL` | `sarvam-translate:v1` (all 23) or `mayura:v1` (12, plus colloquial modes) |
| `TRANSLATION_CONCURRENCY` | in-flight Sarvam requests per worker |
| `TRANSLATION_BATCH_SIZE` | rows claimed per slice |
| `TRANSLATION_MAX_ATTEMPTS` | tries before a row is parked as `failed` |
| `WORKER_TICK_SECRET` | guards `POST /api/worker/tick` |

Every key lives on the server. The browser only ever sees the anon key, and
everything it can reach is bounded by row-level security.

---

## How translation works

Pressing **Translate** does not translate anything. It enqueues:

```
POST /api/translate
  └─ enqueue_translation_job()      creates a job + one queue item per row
                                    that still needs work

worker (npm run worker)
  ├─ claim_job_items()              FOR UPDATE SKIP LOCKED, N rows at a time
  ├─ dedupe identical rows          same line in the slice = one call
  ├─ translation memory lookup      cache hit = zero calls
  ├─ Sarvam, bounded concurrency    retries 429/5xx with jittered backoff
  ├─ apply_translation_results()    one set-based UPDATE for the whole slice
  └─ mark_job_items()               settles the queue, rolls up progress
                                    └─ Realtime pushes counters to the browser
```

Nothing translates inline, because a 5,000-row episode would blow through any
request timeout long before it finished. Progress reaches the UI over Supabase
Realtime rather than polling, so a dozen reviewers watching the same episode
cost one broadcast rather than a dozen poll loops.

### Retries

- **429 / 5xx / timeout** — retried inside the provider with jittered backoff,
  honouring `Retry-After`.
- **A row that still fails** — requeued until `TRANSLATION_MAX_ATTEMPTS`, then
  parked as `failed` with the error visible in the review table.
- **A worker that dies mid-slice** — `requeue_stuck_job_items()` reclaims
  anything locked for more than 10 minutes on the next tick.
- **4xx** — never retried. A malformed request will stay malformed; retrying it
  only burns quota.

---

## The localisation rules are structural, not instructional

Sarvam's `/translate` is text-in/text-out. There is no system prompt, so
"preserve placeholders, keep the line breaks, do not summarise" cannot be
*asked for*. `src/services/translation/preserve.ts` enforces each rule by
construction instead:

| Rule | How it is guaranteed |
|---|---|
| Character names preserved | The speaker prefix is split off and reattached; only the dialogue is sent |
| Placeholders preserved | `{x}`, `{{x}}`, `%s`, `<b>`, `[SFX: …]`, `${x}` are masked to sentinels, restored after, and **verified** |
| Line breaks preserved | Each line is translated separately and rejoined with its original separator (`\n`, `\r\n`, `\r`) |
| Numbering preserved | Leading `1.`, `1)`, `-`, `*`, `•` markers never enter the payload |
| Punctuation & spacing preserved | Leading/trailing whitespace is split off and reattached verbatim |
| No summarising or rewriting | The model only ever sees one line at a time — there is nothing to summarise |

**Masking happens before the speaker split, and the order is load-bearing.** A
stage cue like `[SFX: door creaks]` contains a colon; splitting first reads
`[SFX` as the speaker and sends `door creaks]` off to be translated. That bug
was real and was caught by `npm run check:sarvam` against the live API — there
are regression tests for it in both `preserve.test.ts` and `translator.test.ts`.

If a placeholder sentinel does not survive the round trip, the line is retried
with a different sentinel shape, and if it still does not survive the row is
**failed rather than shipped**. A flagged row is recoverable; a million-row
script with silently mangled markup is not.

```
Input          Raju: Namaste sabhi ko.
Sent to Sarvam Namaste sabhi ko.
Output         Raju: <translated>
```

---

## Cost control

Four layers, in the order they apply:

1. **Nothing untranslatable is sent.** Lines with no letters (`...`, `---`,
   `42`, bare placeholders) are returned as-is for free.
2. **In-slice deduplication.** Identical rows in the same slice collapse to one
   call even on a cold cache.
3. **Translation memory.** Every source line is hashed and looked up first.
   Recurring catchphrases, SFX, intros and re-cut dialogue are paid for once.
4. **Human corrections are permanent.** Saving an edit writes it back with
   `origin = 'human'`, and `upsert_translation_memory` refuses to let machine
   output overwrite a human entry. Review effort compounds instead of being
   undone by the next run.

Only rows that need work are enqueued at all — anything already `edited` or
`approved` is skipped unless you explicitly re-translate.

`/memory` doubles as the cost dashboard: `use_count` is how many calls each
entry has already saved.

---

## Built for the stated scale

| Requirement | How it is handled |
|---|---|
| 100+ books, 10,000+ episodes | Ordinary indexed tables; `org_id` denormalised so RLS is a single index lookup, not a two-level join |
| 1,000,000+ script rows | `script_rows.id` is `bigint identity`, not uuid, keeping the hot btree and every FK compact |
| Fast search | `pg_trgm` GIN indexes on source text, translations and titles; `ILIKE` rides them |
| Pagination | Keyset (`id > after`), never `OFFSET` — offset has to walk everything it skips |
| Multi-user | Supabase Auth + RLS on every table; owner / editor / reviewer / viewer |
| Realtime progress | One `UPDATE` per settled slice on `translation_jobs`, broadcast to subscribers |
| Queue | Postgres with `SKIP LOCKED` — no second broker to run, and jobs are already in the database |
| Horizontal scale | Run as many workers as your rate limit allows; claiming is the only contended step |

The next structural step, at roughly 50M rows, is partitioning `script_rows`
and `translations` by book. Nothing above needs to change to get there.

---

## Roles

| Role | Can |
|---|---|
| `owner` | Everything, including membership |
| `editor` | Create books/episodes/rows, start translations, edit translations |
| `reviewer` | Edit and approve translations; cannot change source content |
| `viewer` | Read only |

---

## Adding a provider

`translator.ts` routes by language pair, so a new provider is one file and one
registration — no caller changes:

```ts
export class GeminiProvider implements TranslationProvider {
  readonly name = "gemini";
  readonly model = "gemini-2.5-flash";
  readonly maxInputChars = 8000;

  supports(source: LanguageCode, target: LanguageCode) {
    return source !== target;          // whatever this provider really covers
  }

  async translate(request: ProviderRequest): Promise<ProviderResult> { /* ... */ }
}
```

```ts
// createTranslator() in translator.ts - registration order is preference order
return new Translator([
  new SarvamProvider({ ... }),   // Indic pairs keep going to the specialist
  new GeminiProvider({ ... }),   // everything else falls through to here
]);
```

To actually offer the extra languages, add their codes to
`languages.ts` — the UI, validation and job pipeline all read from that table.

An LLM-backed provider is also the place to put the prompt-based version of the
localisation rules; `preserve.ts` still applies underneath it, so both layers
reinforce each other.

---

## Running the worker

**Long-lived process (preferred).** Pays connection setup once and drains jobs
continuously:

```bash
npm run worker
```

**HTTP tick (serverless).** For Vercel Cron, pg_cron, GitHub Actions — anything
that can POST on a timer:

```bash
curl -X POST https://your-app/api/worker/tick -H "x-worker-secret: $WORKER_TICK_SECRET"
```

Each tick processes a bounded number of slices so it returns inside the
platform's function timeout; whatever is left is picked up next tick.

---

## Layout

```
src/
├─ services/translation/
│  ├─ types.ts        provider contract + caller-facing shapes
│  ├─ languages.ts    the 23 real languages (single source of truth)
│  ├─ sarvam.ts       Sarvam provider: HTTP, retries, per-model limits
│  ├─ preserve.ts     structural enforcement of the localisation rules
│  ├─ memory.ts       normalisation, hashing, cache port
│  ├─ translator.ts   provider registry, routing, batching pipeline
│  └─ runner.ts       job execution: claim → translate → write back → settle
├─ lib/
│  ├─ env.ts          validated server env
│  ├─ retry.ts        backoff + bounded concurrency
│  └─ supabase/       browser / session / service-role clients + DB types
├─ app/               routes, API handlers, server actions
└─ components/        translate panel, review table, forms
supabase/migrations/  schema, RLS, RPCs
scripts/              worker, seed
```

---

## Tests

```bash
npm test          # 44 tests
npm run check:sarvam   # live API + pipeline check, no database needed
npm run typecheck
```

Coverage is concentrated where correctness is expensive to get wrong: the
placeholder round-trip, speaker splitting, chunking, provider routing, batch
deduplication, memory hits and failure isolation.

> **Note for this machine:** Windows Application Control blocks rollup's native
> binary, so `package.json` pins `rollup` to `@rollup/wasm-node` via
> `overrides`. On a machine without that policy the override can be dropped.
