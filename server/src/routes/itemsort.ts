// Sorting items the keyword rules couldn't place, with Claude. What it chooses ranks
// below the user's own choices and what those taught, so a correction always wins.
import type { FastifyInstance } from 'fastify';
import type { OrdersDb } from '../legacy';
import type { ItemSorter } from '../items/sorter';
import { SorterError } from '../items/sorter';
import { HttpError } from '../params';
import type { AuthedRequest } from '../app';

const BATCH = 150;
// Enough for one click to take a few minutes at most; the rest wait for the next.
const MOST_PER_RUN = 1500;
// Categories for money movements rather than things bought.
const NOT_FOR_ITEMS = new Set(['Refunds & Returns', 'Owner Contribution', 'Owner Withdrawal', 'Loan & Mortgage Payments', 'Security Deposits']);

export function itemSortRoutes(app: FastifyInstance, db: OrdersDb, sorter: ItemSorter, hasKey: () => boolean) {
  const categories = () => db.categoryList().filter((c) => c.expenseClass !== 'income' && !NOT_FOR_ITEMS.has(c.name)).map((c) => c.name);
  let running = false;

  app.get('/api/items/auto-sort', async () => ({ ...db.itemSortStatus(), hasKey: hasKey(), running }));

  app.post('/api/items/auto-sort', async (request) => {
    const body = (request.body || {}) as { retryUnsure?: unknown };
    if (running) throw new HttpError(409, 'Already sorting. Give it a minute.');
    running = true;
    try {
      if (body.retryUnsure === true) db.forgetUnsureItems();
      const names = db.itemsToSort().slice(0, MOST_PER_RUN);
      const list = categories();
      let sorted = 0;
      let unsure = 0;
      for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        const result = await sorter(batch, list);
        db.saveSortedItems(
          batch.map((name, k) => ({ name, category: result.categories[k] ?? null })),
          result.model
        );
        sorted += result.categories.filter(Boolean).length;
        unsure += result.categories.filter((c) => !c).length;
      }
      (request as unknown as AuthedRequest).audit('items.auto-sort', { asked: names.length, sorted, unsure });
      return { asked: names.length, sortedNow: sorted, unsureNow: unsure, status: { ...db.itemSortStatus(), hasKey: hasKey(), running: false } };
    } catch (err) {
      if (err instanceof SorterError) throw new HttpError(400, err.message);
      throw err;
    } finally {
      running = false;
    }
  });
}
