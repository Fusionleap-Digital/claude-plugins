// Anthropic SDK loading, credentials check and cost estimate. The SDK is an
// optional dependency: only the anthropic target and graded (rubric)
// assertions need it.

// USD per million tokens. Override per target with `pricing: { input, output }`.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-haiku-4-5': [1, 5],
};

export function costFor(model, usage, override) {
  if (!usage) return 0;
  const [inp, out] = override ? [override.input, override.output] : PRICES[model] || PRICES[String(model).replace(/-\d{8}$/, '')] || [0, 0];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * inp + (usage.output_tokens || 0) * out) / 1e6;
}

export function hasCredentials() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let cached;
export async function loadAnthropic() {
  if (cached) return cached;
  if (!hasCredentials()) {
    cached = { ok: false, reason: 'ANTHROPIC_API_KEY is not set' };
    return cached;
  }
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    cached = { ok: false, reason: '@anthropic-ai/sdk is not installed (run "npm install" in the agent-evals scripts folder)' };
    return cached;
  }
  const describeError = (err) => {
    if (err instanceof Anthropic.AuthenticationError) return 'Anthropic API: invalid credentials';
    if (err instanceof Anthropic.RateLimitError) return 'Anthropic API: rate limited (lower --concurrency)';
    if (err instanceof Anthropic.BadRequestError) return `Anthropic API: bad request: ${err.message}`;
    if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
    return `Anthropic API: ${err?.message || err}`;
  };
  cached = { ok: true, client: new Anthropic({ maxRetries: 4 }), describeError };
  return cached;
}
