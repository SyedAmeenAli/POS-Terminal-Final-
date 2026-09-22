const REDACT_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'signature',
  'webhooksecret',
  'password',
  'cardnumber',
  'cvv',
  'bankaccount',
]);

export function redactPayload(val: unknown, seen = new WeakSet<object>()): unknown {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === 'object') {
    if (seen.has(val)) {
      return '[CIRCULAR]';
    }
    seen.add(val);
    if (Array.isArray(val)) {
      return val.map(item => redactPayload(item, seen));
    }
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      if (REDACT_KEYS.has(k.toLowerCase())) {
        res[k] = '[REDACTED]';
      } else {
        res[k] = redactPayload(v, seen);
      }
    }
    return res;
  }
  return val;
}
