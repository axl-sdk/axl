import { describe, it, expectTypeOf } from 'vitest';
import type { ApiKeySource } from '../providers/types.js';
import type { ProviderConfig, AxlConfig } from '../config.js';
import type { OpenAICompatibleOptions } from '../providers/openai-compatible.js';

// ---------------------------------------------------------------------------
// Type-level guard for the widened `apiKey` union (T2.2). Compiled by the
// `typecheck` CI gate. A plain string must remain assignable everywhere it was
// before (so widening stays backward-compatible / patch-level — cf. the
// 0.18.1→0.18.2 strictFunctionTypes regression), AND a function must now be
// accepted at the config input and every constructor option.
// ---------------------------------------------------------------------------

describe('ApiKeySource union (T2.2)', () => {
  it('accepts both a string and a sync/async function', () => {
    const a: ApiKeySource = 'sk-static';
    const b: ApiKeySource = () => 'sk-sync';
    const c: ApiKeySource = async () => 'sk-async';
    void a;
    void b;
    void c;
  });

  it('ProviderConfig.apiKey accepts string AND function (backward-compatible)', () => {
    const stringCfg: ProviderConfig = { apiKey: 'sk-static' };
    const fnCfg: ProviderConfig = { apiKey: () => 'sk-dynamic' };
    const asyncCfg: ProviderConfig = { apiKey: async () => 'sk-async' };
    expectTypeOf(stringCfg.apiKey).toEqualTypeOf<ApiKeySource | undefined>();
    void fnCfg;
    void asyncCfg;
  });

  it('AxlConfig.providers carries the union through', () => {
    const cfg: AxlConfig = {
      providers: {
        openrouter: { apiKey: async () => 'tok' },
        openai: { apiKey: 'sk' },
        azure: { apiKey: async () => 'entra-token', authHeader: 'bearer' },
      },
    };
    void cfg;
  });

  it('OpenAICompatibleOptions.apiKey accepts the union', () => {
    expectTypeOf<OpenAICompatibleOptions['apiKey']>().toEqualTypeOf<ApiKeySource | undefined>();
  });
});
