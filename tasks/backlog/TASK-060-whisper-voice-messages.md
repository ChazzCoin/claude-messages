# TASK-060: Whisper transcription for voice messages

## User story

As a **user**, I want **voice messages I receive to be transcribed automatically and fed into the auto-note + draft pipeline**, so that **the substantive things people record rather than type don't get filed under "[encoded message — decoder skipped]" and ignored**.

## Why this matters

People record voice messages for the meaningful stuff — long updates, emotional content, things too complex to thumb out. Today our pipeline can't see them at all (audio attachment, no text). Result: any contact who voice-messages a lot is invisible to Galt.

Whisper-1 is cheap (~$0.006/min). Most voice messages are <30s.

## Scope

**In scope:**
- Detect inbound audio attachments (`is_audio_message=1` OR mime starts with `audio/`)
- Pull the audio file from `~/Library/Messages/Attachments/...` (we have FDA)
- Send to OpenAI `audio.transcriptions.create({model: 'whisper-1'})`
- Cache result on a new `audio_transcripts` table keyed by `attachment.guid` so we don't re-transcribe
- When auto-note / draft pipelines see an audio-only message, substitute the transcript as the message text
- Inspector adds a "Transcript" section under Attachments when one exists
- Surface the transcript in the bubble too (as an italicized indented block under the audio attachment)

**Out of scope:**
- Transcribing OUR sent voice messages (we don't send those)
- Diarization (single speaker by definition for voice messages)
- Real-time streaming transcription

## References

- chat.db `is_audio_message` column — `MessageRow.is_audio_message` (already exposed in inspector)
- Apple stores attachments on disk at the path in `attachment.filename`
- Existing OpenAI client: `server/ai.ts::getOpenAI()`
- Auto-note pipeline: `server/ai.ts::extractAutoNote`
- Cost tracking: `recordAiUsage()` — extend `purpose` enum with `'whisper'`

## Files expected to change

- `server/ai.ts` — `transcribeAudio(filePath)` + `recordAiUsage` with `whisper` purpose
- `server/db/app.ts` — new `audio_transcripts` table (attachment_guid PK, text, transcribed_at)
- `server/watcher.ts` (or wherever auto-notes fire) — branch when message is audio-only
- `web/js/views/thread.js` — render transcript under audio attachment bubble + in inspector
- Cost table in `server/ai.ts` — add a `whisper-1` entry (per-minute, not per-token)

## Acceptance criteria

- [ ] Inbound voice message from a watched contact gets transcribed within 30s
- [ ] Transcript shows in the bubble under the audio attachment
- [ ] Auto-notes for voice messages now have meaningful summaries (not "[audio]")
- [ ] Drafts in reply to a voice message reference the transcript content
- [ ] Re-loading the thread doesn't re-transcribe (cache hit)
- [ ] Whisper costs roll up into the AI usage panel under their own purpose label

## Test plan (E2E)

1. Setup: have a test contact send a voice message
2. Assert: bubble shows a transcript within 30s
3. Assert: an auto-note exists with non-empty meaningful summary
4. Reload thread; assert no second Whisper call (check usage counter)

## Manual verification

1. Voice-message a known contact
2. Watch thread page for transcript appearance
3. Check inspector → Transcript section populated

## Open questions / risks

- Apple may store some voice messages as `.caf`; confirm Whisper API accepts that or we need to convert to wav/m4a first
- Cost spike if a contact sends many long voice messages — add a per-month soft cap to settings (default ~$5)
- Privacy: voice content goes to OpenAI. Off-by-default? On-by-default with opt-out? User decides.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
