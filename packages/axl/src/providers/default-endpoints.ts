/**
 * The vendors' own default API base URLs, shared by the adapters that default
 * to them and by the quota dialects, which apply only at these origins
 * (`quota.ts`). A leaf module (no imports) so both sides can depend on it
 * without a cycle.
 *
 * Internal: nothing here is barrel-exported.
 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
