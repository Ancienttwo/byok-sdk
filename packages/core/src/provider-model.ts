/** A profile model is passed as one Pi launcher argument. */
export function isProviderProfileModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 160 && value.trim().length > 0
    && !value.startsWith('--') && !/\p{Cc}/u.test(value);
}

/** The Pi provider launcher refused the selected model before spawning Pi. */
export const PI_PROVIDER_MODEL_UNAVAILABLE_EXIT = 79;

/** Classify an HTTP provider error from parsed JSON or the provider's rendered body. */
export function classifyModelProviderHttpError(status: number, payload: unknown): string {
  const detail = safeProviderErrorText(payload);
  if (status === 402 || /(?:insufficient[_ -]?(?:quota|balance|credit)|quota[_ -]?exceeded|billing|payment required|余额不足|额度不足|欠费|充值)/iu.test(detail)) {
    return 'MODEL_PROVIDER_BALANCE_INSUFFICIENT';
  }
  if (status === 401 || status === 403 || /(?:invalid[_ -]?api[_ -]?key|authentication|unauthori[sz]ed|forbidden|鉴权失败|密钥无效|令牌无效)/iu.test(detail)) {
    return 'MODEL_PROVIDER_AUTH_FAILED';
  }
  if (status === 404 || /(?:model[_ -]?(?:not[_ -]?(?:found|available)|unavailable)|model does not exist|unknown model|no such model|no endpoints found for|模型不存在|无权访问模型)/iu.test(detail)) {
    return 'MODEL_PROVIDER_MODEL_NOT_FOUND';
  }
  if (status === 429) return 'MODEL_PROVIDER_RATE_LIMITED';
  return 'MODEL_PROVIDER_HTTP_ERROR';
}

function safeProviderErrorText(payload: unknown): string {
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    return text.slice(0, 8_000);
  } catch {
    return '';
  }
}
