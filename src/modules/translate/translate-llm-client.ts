import { sleep, stripThinking } from './translate-lang';

// A hung LLM connection (no timeout on fetch) would block the whole translate queue forever, silently
// dropping every group's messages. Abort so translate()'s fallback loop moves on.
//
// The ceiling differs by where the model runs, so one number cannot serve both. A cloud provider
// answers healthy calls in well under a second; when one degrades, every queued message pays the full
// deadline before the fallback runs, and translations are serialized — so the penalty compounds per
// message (observed: gemini-flash-lite at 0.7s -> 388s for ~10 minutes). A local Ollama, by contrast,
// legitimately needs tens of seconds to load a cold model, so the same short deadline would abort a
// perfectly healthy first call. Hence two defaults, chosen by provider.
//
// TRANSLATE_LLM_TIMEOUT_MS still overrides both, so an existing deploy that pinned it keeps its value.
//
// 8s is safe to be strict with because the fallback chain absorbs the miss: a genuinely slow message
// that blows the cloud deadline drops to the next entry rather than being lost, and a chain ending in
// ollama still gets the full 30s there. Measured on live traffic at 8s: 107 translations, 0 fallbacks.
//
// Known interaction with the circuit breaker in TranslateService: it counts CONSECUTIVE failures
// without distinguishing "provider is down" from "that one message was too big for the deadline", so
// two oversized messages in a row can sideline a healthy provider for the cooldown. Not observed in
// practice (0 of 107) — but if a provider looks skipped for no reason, check message length first.
const CLOUD_TIMEOUT_MS = 8_000;
const OLLAMA_TIMEOUT_MS = 30_000;

/** Exported for tests: the choice is the whole point of this change, so assert it directly. */
export function timeoutFor(provider: LlmProvider): number {
  return Number(process.env.TRANSLATE_LLM_TIMEOUT_MS) || (provider === 'ollama' ? OLLAMA_TIMEOUT_MS : CLOUD_TIMEOUT_MS);
}

// Groq (and other cloud providers) return 429 with a Retry-After when the tier RPM/TPM is exhausted.
// Wait it out instead of dropping the message. Capped so a far-off reset (e.g. daily quota) fails fast
// to the fallback model rather than stalling the queue.
const LLM_MAX_RETRIES = Number(process.env.TRANSLATE_LLM_MAX_RETRIES) || 2;
const LLM_MAX_BACKOFF_MS = Number(process.env.TRANSLATE_LLM_MAX_BACKOFF_MS) || 10_000;

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Retry-After is seconds (Groq) or an HTTP-date; fall back to exponential backoff (1s, 2s, ...) when absent.
function retryAfterMs(res: Response, attempt: number): number {
  const h = res.headers.get('retry-after');
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(h);
    if (!Number.isNaN(date)) return date - Date.now();
  }
  return Math.min(1000 * 2 ** attempt, LLM_MAX_BACKOFF_MS);
}

// Retry ONLY on 429 (rate limit): the request was rejected unprocessed, so a retry can't double-charge
// tokens or duplicate work (unlike a timeout, which fetchWithTimeout throws — never retried here).
// Honors Retry-After; if the wait exceeds the cap, returns the 429 so translate() falls back instead of stalling.
async function fetchWithRetry(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(url, timeoutMs, init);
    if (res.status !== 429 || attempt >= LLM_MAX_RETRIES) return res;
    const waitMs = retryAfterMs(res, attempt);
    if (waitMs > LLM_MAX_BACKOFF_MS) return res; // reset too far off — fail to the fallback model now
    if (waitMs > 0) await sleep(waitMs);
  }
}

export type LlmProvider = 'ollama' | 'openai' | 'groq' | 'azure' | 'gemini';
export const LLM_PROVIDERS: LlmProvider[] = ['ollama', 'openai', 'groq', 'azure', 'gemini'];

/** The subset needed to make one LLM call — used by translate + the test/models probes. */
export interface LlmParams {
  provider: LlmProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  temperature: number;
}

/** Single LLM call, provider-dispatched. Stateless (all inputs in `p`) so the probes can reuse it. */
export async function callLlm(p: LlmParams, prompt: string): Promise<string> {
  const raw =
    p.provider === 'gemini'
      ? await callGemini(p, prompt)
      : p.provider === 'ollama'
        ? await callOllama(p, prompt)
        : // openai, groq, azure all speak the OpenAI /chat/completions shape (auth header differs for azure).
          await callOpenAiCompatible(p, prompt);
  // Reasoning models (qwen3, deepseek-r1, ...) prepend <think>...</think>; keep only the answer so the
  // group never sees the chain-of-thought. Empty after stripping = all reasoning → fail so translate()
  // tries the next fallback model.
  const out = stripThinking(raw);
  if (!out) throw new Error(`${p.provider} produced only reasoning, no answer`);
  return out;
}

async function callOllama(p: LlmParams, prompt: string): Promise<string> {
  const res = await fetchWithRetry(p.endpoint, timeoutFor(p.provider), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      // Suppress chain-of-thought at the source for reasoning models (qwen3 etc.); harmless for models
      // that don't think. stripThinking() in callLlm is the belt-and-suspenders fallback.
      think: false,
      options: { temperature: p.temperature },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  const out = data.message?.content?.trim();
  if (!out) throw new Error('Ollama empty response');
  return out;
}

// OpenAI / Groq (Bearer) and Azure OpenAI (api-key header; deployment in the endpoint URL).
async function callOpenAiCompatible(p: LlmParams, prompt: string): Promise<string> {
  const auth: Record<string, string> = {};
  if (p.apiKey) {
    if (p.provider === 'azure') auth['api-key'] = p.apiKey;
    else auth.authorization = `Bearer ${p.apiKey}`;
  }
  const res = await fetchWithRetry(p.endpoint, timeoutFor(p.provider), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({
      model: p.model,
      temperature: p.temperature,
      messages: [{ role: 'user', content: prompt }],
      // Groq qwen3 models are reasoning models: without this they spend the reply on <think> blocks and
      // stripThinking() yields '' → constant fallback. Mirrors callOllama's think:false / Gemini's thinkingBudget:0.
      ...(p.provider === 'groq' && /qwen-?3/i.test(p.model) ? { reasoning_effort: 'none' } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${p.provider} HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const out = data.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error(`${p.provider} empty response`);
  return out;
}

// Gemini generateContent. endpoint = API base (e.g. https://generativelanguage.googleapis.com/v1beta).
async function callGemini(p: LlmParams, prompt: string): Promise<string> {
  const base = p.endpoint.replace(/\/+$/, '');
  const url = `${base}/models/${p.model}:generateContent?key=${encodeURIComponent(p.apiKey)}`;
  const res = await fetchWithRetry(url, timeoutFor(p.provider), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // Translation needs no reasoning. Without this, thinking models (gemini-flash/2.5+) spend
      // the whole output budget on internal thinking, finish with MAX_TOKENS and return empty
      // parts — which reads as "translation randomly stops working". Mirrors callOllama's think:false.
      generationConfig: { temperature: p.temperature, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const out = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!out) throw new Error('Gemini empty response');
  return out;
}

/**
 * Validate endpoint + key. Prefer the model-agnostic list endpoint (Ollama /api/tags,
 * OpenAI/Groq /models) so a wrong/blank model name doesn't fail key validation; only azure/gemini
 * (no portable list endpoint) fall back to a tiny generation, which does need a valid model.
 */
export async function testConnection(p: LlmParams): Promise<{ ok: boolean; message: string }> {
  try {
    if (p.provider !== 'azure') {
      const models = await listModels(p);
      return { ok: true, message: models.length ? `${models.length} model(s)` : 'ok' };
    }
    const out = await callLlm({ ...p, temperature: 0 }, 'ping');
    return { ok: true, message: out.slice(0, 40) || 'ok' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// Swap just the PATH of a URL (keeps scheme/host/port), like TypeTwo's _replacePath — robust for a
// LAN Ollama or any host, unlike a suffix regex that only matches the default path.
function replacePath(endpoint: string, path: string): string {
  try {
    const u = new URL(endpoint);
    u.pathname = path;
    u.search = '';
    return u.toString();
  } catch {
    return endpoint;
  }
}

// OpenAI-compatible /models URL: swap a trailing /chat/completions in the path for /models (keeps a
// prefix like Groq's /openai/v1); otherwise fall back to /v1/models. Mirrors TypeTwo exactly.
function modelsUrl(endpoint: string, fallback: string): string {
  if (!endpoint.trim()) return fallback;
  try {
    const u = new URL(endpoint);
    const swapped = u.pathname.replace(/\/chat\/completions\/?$/, '/models');
    u.pathname = swapped !== u.pathname ? swapped : '/v1/models';
    u.search = '';
    return u.toString();
  } catch {
    return fallback;
  }
}

/** List model names for the endpoint (Ollama /api/tags, OpenAI/Groq /models, Gemini /v1beta/models). */
export async function listModels(p: Pick<LlmParams, 'provider' | 'endpoint' | 'apiKey'>): Promise<string[]> {
  if (p.provider === 'ollama') {
    const res = await fetchWithRetry(replacePath(p.endpoint, '/api/tags'), timeoutFor(p.provider));
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name?: string }[] };
    return (data.models ?? []).map(m => m.name ?? '').filter(Boolean);
  }
  if (p.provider === 'openai' || p.provider === 'groq') {
    const fallback =
      p.provider === 'groq'
        ? 'https://api.groq.com/openai/v1/models'
        : 'https://api.openai.com/v1/models';
    const res = await fetchWithRetry(modelsUrl(p.endpoint, fallback), timeoutFor(p.provider), {
      headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
    });
    if (!res.ok) throw new Error(`${p.provider} HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map(m => m.id ?? '').filter(Boolean);
  }
  if (p.provider === 'gemini') {
    const base = (p.endpoint || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const res = await fetchWithRetry(`${base}/models`, timeoutFor(p.provider), {
      headers: p.apiKey ? { 'x-goog-api-key': p.apiKey } : {},
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    return (data.models ?? [])
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map(m => (m.name ?? '').split('/').pop() ?? '')
      .filter(Boolean);
  }
  // azure has no portable list endpoint — enter the deployment/model manually.
  return [];
}
