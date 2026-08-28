# Lead-gen call transcripts: Kommo → Ringostat → role-tagged text

Pulls won lead-gen deals out of Kommo, finds the matching Ringostat call
recordings by phone number, and transcribes them **split by role** — so it is
visible on every line whether the manager or the client is speaking.

## Status: ready to run, not yet run

The code is complete and its logic is covered by tests, but **no data has been
extracted yet**. Two things are missing, both outside the code:

1. **No credentials.** Kommo and Ringostat API keys are not present in this
   environment.
2. **No network route.** This sandbox's egress policy returns `403` for
   `api.ringostat.net`, `*.kommo.com`, and every external speech-to-text API.
   Only package registries are reachable.

So the pipeline has to run somewhere with credentials and open egress — a
laptop, a VM, or a Claude environment whose network policy allows those hosts.
See *Running it* below.

## What it produces

For every call, all three required fields plus context:

```
output/
├── transcripts/deal_98765/2026-08-12_10_04_11__380671234567.txt
├── calls_index.csv          one row per call (UTF-8 BOM, opens cleanly in Sheets)
├── calls_index.xlsx         same, formatted, transcript column wrapped
└── run_summary.json         coverage stats for the run
```

A transcript file:

```
Угода:        98765 — Лідоген / сайт
Менеджер:     Олег К.
Телефон:      +380671234567
Дата дзвінка: 2026-08-12 10:04:11
Напрямок:     вихідний
Тривалість:   214 сек
Ролі:         high
------------------------------------------------------------
[00:00] Менеджер: Добрий день, компанія Альфа.
[00:03] Клієнт: Вітаю, я щодо пропозиції.
[00:07] Менеджер: Так, підберу варіант.
```

To deliver as a Google Sheet: import `calls_index.csv` (File → Import), or
upload `calls_index.xlsx` to Drive and open it as Sheets.

## How roles are separated

This is the part the brief cares about most, so it does not rely on guesswork
where it doesn't have to.

**Primary method — stereo channel split.** Ringostat records each call leg on
its own audio channel. The two speakers are therefore already physically
separated in the file. The pipeline splits the channels with ffmpeg,
transcribes each one independently, tags every segment with the role that
channel belongs to, and merges them back by timestamp. No diarisation model, no
speaker-similarity guessing, no cross-talk confusion. These calls are marked
`role_confidence=high`.

Which channel is the manager follows from call direction — channel 0 carries
the *caller's* leg, so it is the manager on an outbound call and the client on
an inbound one. **That convention must be confirmed once against a real
recording** (see below); it is the one assumption in the role logic.

**Fallback — diarisation.** If a recording turns out to be mono, the pipeline
falls back to `pyannote` speaker diarisation and marks those calls
`role_confidence=low`. Without a HuggingFace token it emits the text with roles
marked `Невідомо` and `role_confidence=none` rather than inventing labels. The
index column makes every such call easy to find and spot-check.

## Running it

```bash
pip install -r requirements.txt
apt-get install -y ffmpeg          # required for the channel split
cp .env.example .env               # then fill in the four required values
```

Then work through these four steps in order:

**1. Find the lead-gen pipeline.** "Lead-gen deals" is an account-specific
notion — it is usually a dedicated pipeline. This lists every pipeline with its
won-deal count for the window, so you can pick the right id:

```bash
python src/discover.py pipelines
```

Put the id(s) into `KOMMO_PIPELINE_IDS`. If lead-gen is marked some other way
in your account (a source field, a tag, a set of responsible managers), say so
and the filter is a small change in `kommo_client.won_leads`.

**2. Check the Ringostat field mapping.** The Ringostat API docs were not
reachable from the machine this was written on, so the response parser tries a
list of candidate key names per field. This prints what the API actually
returns and which key the mapper chose:

```bash
python src/discover.py ringostat
```

Anything showing `NOT FOUND` needs its real key added to `FIELD_CANDIDATES` in
`src/ringostat_client.py` — one dict, one line per field.

**3. Verify the role mapping.** Download one recording and check which channel
is really the manager:

```bash
python src/verify_roles.py some_call.mp3 --direction out
```

It prints both channels unlabelled alongside its prediction. The side opening
with the company greeting is the manager. If the prediction is inverted, pin it
with `CHANNEL_ROLE_MODE=ch0_manager` or `ch0_client`. Doing this once is what
makes every later transcript's roles trustworthy.

**4. Run.** Check the deal and call counts first, then smoke-test, then go:

```bash
python src/run_pipeline.py --dry-run    # counts only, no audio downloaded
python src/run_pipeline.py --limit 5    # five real transcripts, end to end
python src/run_pipeline.py              # the full run
```

Transcripts are cached under `output/cache`, so an interrupted run resumes
where it stopped instead of re-transcribing.

## Runtime expectations

200+ deals × up to 5 calls is up to ~1000 recordings, and each is transcribed
twice (once per channel). On a **GPU**, `large-v3` handles this in roughly
2–4 hours. On **CPU** the same run is measured in days — if no GPU is
available, either set `WHISPER_MODEL=medium` and accept somewhat lower accuracy
on noisy calls, or run against a hosted Whisper API. The model is only loaded
if there is uncached work to do.

Language is auto-detected per call, which handles the Ukrainian/Russian
code-switching typical of these conversations. Pin it with `WHISPER_LANGUAGE`
if the account is single-language.

## Selection rules

- Deals: `status_id = 142` ("Closed – won"), `closed_at` inside the last
  `MONTHS_BACK` months, restricted to `KOMMO_PIPELINE_IDS`.
- Phone numbers come from the linked contacts' `PHONE` custom field.
- Matching is on the **last 9 digits**, so `+38 (067) 123-45-67`, `0671234567`
  and `380671234567` all join correctly.
- Calls: the `CALLS_PER_DEAL` most recent per number, skipping anything shorter
  than `MIN_CALL_SECONDS` (rings and voicemail) or without a recording.
- The whole Ringostat journal is fetched once and indexed in memory rather than
  queried per number — one pass instead of 200+ requests.

## Layout

| File | Role |
|---|---|
| `src/run_pipeline.py` | orchestrator, 5 stages, resumable |
| `src/kommo_client.py` | won deals + contact phones, paginated and throttled |
| `src/ringostat_client.py` | call journal, phone indexing, recording download |
| `src/transcribe.py` | channel split, Whisper, role assignment |
| `src/export.py` | txt files, CSV, XLSX, summary |
| `src/phones.py` | number normalisation and the join key |
| `src/discover.py` | pipeline listing + Ringostat schema dump |
| `src/verify_roles.py` | one-off channel/role spot-check |
| `tests/test_pipeline.py` | 14 offline tests, no network needed |

```bash
python tests/test_pipeline.py
```

Covers phone-format collapsing, won/lost and pipeline filtering, pagination,
Kommo's `204` empty response, direction-based client-number resolution, the
"5 most recent" cut, short/unrecorded call filtering, role assignment and
overrides, chronological channel merging, and cache round-tripping.
