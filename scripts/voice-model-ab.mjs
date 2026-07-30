#!/usr/bin/env node
// A/B two STT models over the SAME archived voice notes.
//
// Needs a corpus: set TRANSLATE_VOICE_ARCHIVE_DIR (see archiveAudio) for a measurement window so real
// notes land on disk, then run this against that directory. Synthesised/TTS audio is worthless here —
// the thing being measured is Vietnamese-accented English loanwords (bot -> boss), which a standard
// TTS voice does not reproduce.
//
// Usage:
//   node scripts/voice-model-ab.mjs <audio-dir> [modelA] [modelB]
// Env: TRANSLATE_VOICE_STT_URL, TRANSLATE_VOICE_STT_KEY, TRANSLATE_VOICE_LANGUAGE (optional)

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const AUDIO_EXT = new Set(['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.wav', '.webm', '.flac']);
const MIME = { '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.webm': 'audio/webm', '.flac': 'audio/flac' };

const dir = process.argv[2];
const models = [process.argv[3] || 'whisper-large-v3', process.argv[4] || 'whisper-large-v3-turbo'];
const baseUrl = (process.env.TRANSLATE_VOICE_STT_URL || '').replace(/\/+$/, '');
const apiKey = process.env.TRANSLATE_VOICE_STT_KEY || '';
const language = process.env.TRANSLATE_VOICE_LANGUAGE || '';

if (!dir || !baseUrl) {
  console.error('usage: node scripts/voice-model-ab.mjs <audio-dir> [modelA] [modelB]');
  console.error('       TRANSLATE_VOICE_STT_URL (and usually _STT_KEY) must be set');
  process.exit(1);
}

const url = baseUrl.endsWith('/v1') ? `${baseUrl}/audio/transcriptions` : `${baseUrl}/v1/audio/transcriptions`;

async function run(buf, ext, model) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: MIME[ext] || 'audio/ogg' }), `audio${ext}`);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (language) form.append('language', language);

  const startedAt = Date.now();
  const res = await fetch(url, { method: 'POST', headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined, body: form });
  if (!res.ok) return { model, error: `${res.status}: ${(await res.text()).slice(0, 120)}` };
  const json = await res.json();
  const segs = Array.isArray(json.segments) ? json.segments : [];
  // Worst segment, not the average — mirrors summarizeConfidence(); a clean opening segment must not
  // average away a hallucinated one.
  return {
    model,
    ms: Date.now() - startedAt,
    text: (json.text || '').trim(),
    noSpeech: segs.length ? Math.max(...segs.map(s => s.no_speech_prob ?? 0)) : null,
    logprob: segs.length ? Math.min(...segs.map(s => s.avg_logprob ?? 0)) : null,
    segments: segs.length || null,
  };
}

const files = (await readdir(dir)).filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase())).sort();
if (!files.length) {
  console.error(`no audio files in ${dir} — set TRANSLATE_VOICE_ARCHIVE_DIR and collect a window first`);
  process.exit(1);
}
console.error(`${files.length} file(s), models: ${models.join(' vs ')}\n`);

const rows = [];
for (const f of files) {
  const buf = await readFile(path.join(dir, f));
  const ext = path.extname(f).toLowerCase();
  // Sequential on purpose: free Groq tiers rate-limit, and this is a one-off run.
  for (const model of models) rows.push({ file: f, bytes: buf.byteLength, ...(await run(buf, ext, model)) });
}

const fmt = n => (typeof n === 'number' ? n.toFixed(3) : '-');
for (const f of files) {
  console.log(`\n=== ${f}`);
  for (const r of rows.filter(r => r.file === f)) {
    if (r.error) console.log(`  ${r.model}: ERROR ${r.error}`);
    else console.log(`  ${r.model}: ${r.ms}ms no_speech=${fmt(r.noSpeech)} logprob=${fmt(r.logprob)} seg=${r.segments ?? '-'}\n    ${r.text}`);
  }
  const [a, b] = rows.filter(r => r.file === f);
  if (a?.text && b?.text) console.log(`  -> transcripts ${a.text === b.text ? 'IDENTICAL' : 'DIFFER'}`);
}

console.log('\n=== per-model summary');
for (const model of models) {
  const ok = rows.filter(r => r.model === model && !r.error);
  if (!ok.length) continue;
  const avg = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  console.log(
    `  ${model}: n=${ok.length} avg_ms=${Math.round(avg(ok.map(r => r.ms)))}` +
      ` avg_no_speech=${fmt(avg(ok.map(r => r.noSpeech).filter(n => n !== null)))}` +
      ` avg_logprob=${fmt(avg(ok.map(r => r.logprob).filter(n => n !== null)))}`,
  );
}
const differ = files.filter(f => {
  const [a, b] = rows.filter(r => r.file === f);
  return a?.text && b?.text && a.text !== b.text;
});
console.log(`  transcripts differ on ${differ.length}/${files.length} file(s)`);
console.log('\nAccuracy is a HUMAN call: read the differing pairs above and judge which is right.');
console.log('The numbers only say how confident each model was, not which one heard correctly.');
