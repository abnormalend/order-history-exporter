// Sorts item names the keyword rules couldn't place, with Claude. Only the item names
// and the category names are sent; nothing else from the books. Claude may say it
// isn't sure, and those are left for the user.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

// Naming everyday products is simple, so the small fast model is enough.
export const SORTER_MODEL = 'claude-haiku-5-5';

export interface SortResult {
  // One per name, in order: a category from the list, or null when unsure.
  categories: (string | null)[];
  model: string;
}
export type ItemSorter = (names: string[], categories: string[]) => Promise<SortResult>;

export class SorterError extends Error {}

const SortSchema = z.object({
  items: z.array(
    z.object({
      n: z.number().int().describe('The number of the item in the list.'),
      category: z.string().nullable().describe('Exactly one of the listed categories, or null if none clearly fits or the name is too vague to tell.'),
    })
  ),
});

const SYSTEM = `You sort items from a household's and small business's online store orders into spending categories for their bookkeeping. Item names are product titles copied from the store, often long and full of brand names and sizes. Decide what the product is, then choose the one listed category it belongs to. Use the category names exactly as written. Food and drink to eat at home is Grocery. Say null rather than guess when the name doesn't tell you what the product is, or when no listed category fits.`;

export function claudeSorter(apiKey: () => string | null): ItemSorter {
  return async (names, categories) => {
    const key = apiKey();
    if (!key) throw new SorterError('Add an Anthropic API key in Settings first. It is the same key used to read receipts.');
    const client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    const list = names.map((name, i) => `${i + 1}. ${name.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
    let response;
    try {
      response = await client.beta.messages.parse({
        model: SORTER_MODEL,
        max_tokens: 16000,
        output_config: { format: betaZodOutputFormat(SortSchema) },
        system: SYSTEM,
        messages: [{ role: 'user', content: `Categories: ${categories.join('; ')}\n\nItems:\n${list}\n\nGive a category for every item, by its number.` }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new SorterError('The Anthropic API key was refused. Check it in Settings.');
      if (err instanceof Anthropic.PermissionDeniedError) throw new SorterError("The Anthropic API key isn't allowed to use this model.");
      if (err instanceof Anthropic.RateLimitError) throw new SorterError('Anthropic is busy or the account has hit its limit. Try again in a few minutes.');
      if (err instanceof Anthropic.APIError) throw new SorterError(`Anthropic replied with an error (${err.status ?? 'no status'}). Try again later.`);
      throw err;
    }
    if (response.stop_reason === 'refusal' || !response.parsed_output) throw new SorterError('Claude could not sort these items. Try again later.');
    const allowed = new Set(categories);
    const out: (string | null)[] = names.map(() => null);
    for (const item of response.parsed_output.items) {
      const i = item.n - 1;
      if (i >= 0 && i < names.length && item.category && allowed.has(item.category)) out[i] = item.category;
    }
    return { categories: out, model: response.model };
  };
}
