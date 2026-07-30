import { LLM_PROVIDERS, timeoutFor } from './translate-llm-client';

describe('timeoutFor', () => {
  const saved = process.env.TRANSLATE_LLM_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.TRANSLATE_LLM_TIMEOUT_MS;
    else process.env.TRANSLATE_LLM_TIMEOUT_MS = saved;
  });

  it('gives a local Ollama room to load a cold model', () => {
    delete process.env.TRANSLATE_LLM_TIMEOUT_MS;
    expect(timeoutFor('ollama')).toBe(30_000);
  });

  it('holds cloud providers to a short deadline', () => {
    delete process.env.TRANSLATE_LLM_TIMEOUT_MS;
    // A degraded cloud provider charges this to EVERY queued message, so it must stay small.
    for (const p of LLM_PROVIDERS.filter(p => p !== 'ollama')) {
      expect(timeoutFor(p)).toBe(8_000);
    }
  });

  it('lets an existing deploy pin one value for every provider', () => {
    process.env.TRANSLATE_LLM_TIMEOUT_MS = '5000';
    expect(timeoutFor('ollama')).toBe(5000);
    expect(timeoutFor('gemini')).toBe(5000);
  });

  it('falls back to the provider default for a garbage or zero override', () => {
    process.env.TRANSLATE_LLM_TIMEOUT_MS = 'soon';
    expect(timeoutFor('gemini')).toBe(8_000);
    process.env.TRANSLATE_LLM_TIMEOUT_MS = '0'; // 0 would disable the deadline entirely
    expect(timeoutFor('ollama')).toBe(30_000);
  });
});
