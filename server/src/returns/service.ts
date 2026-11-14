// What each business reported on its tax return, line by line, beside what Business Hub
// has for the same year. A line names the categories it covers, so Business Hub's
// figure follows any later change to the transactions.
import type { DatabaseSync } from 'node:sqlite';
import type { PlService } from '../pl/service';

type Row = Record<string, any>;

export interface ReturnLineInput {
  section: string;
  line: string;
  reported: number;
  // The figure from the owner's own worksheet when it was filed, if any.
  worksheet?: number | null;
  categories?: string[] | null;
  note?: string | null;
}

const cents = (n: number) => Math.round(n * 100) / 100;

export function returnsService({ db, pl }: { db: DatabaseSync; pl: PlService }) {
  const raw = db;

  const years = () => (raw.prepare('SELECT DISTINCT year FROM tax_return_lines ORDER BY year DESC').all() as Row[]).map((r) => r.year as string);

  function list(year: string) {
    const rows = raw
      .prepare(
        `SELECT l.*, e.name AS entity FROM tax_return_lines l JOIN entities e ON e.id = l.entity_id
         WHERE l.year = ? ORDER BY e.name COLLATE NOCASE, l.position, l.id`
      )
      .all(year) as Row[];
    const byEntity = new Map<number, { entityId: number; entity: string; form: string | null; lines: Row[] }>();
    // Business Hub's totals for the year, per business: spending and income by category.
    const totals = new Map<number, Map<string, number>>();
    const totalsFor = (entityId: number) => {
      let found = totals.get(entityId);
      if (!found) {
        const report = pl.report({ kind: 'year', year }, entityId);
        found = new Map<string, number>();
        for (const c of report.categories) found.set(c.category, (found.get(c.category) || 0) + c.amount);
        for (const c of report.incomeCategories) found.set(c.category, (found.get(c.category) || 0) + c.amount);
        totals.set(entityId, found);
      }
      return found;
    };
    for (const r of rows) {
      let group = byEntity.get(r.entity_id);
      if (!group) byEntity.set(r.entity_id, (group = { entityId: r.entity_id, entity: r.entity, form: r.form ?? null, lines: [] }));
      const categories = r.categories ? (JSON.parse(r.categories) as string[]) : [];
      const hub = categories.length ? cents(categories.reduce((t, c) => t + (totalsFor(r.entity_id).get(c) || 0), 0)) : null;
      group.lines.push({
        id: r.id,
        section: r.section,
        line: r.line,
        reported: r.reported,
        worksheet: r.worksheet ?? null,
        categories,
        hub,
        note: r.note ?? null,
      });
    }
    return { year, years: years(), returns: [...byEntity.values()] };
  }

  // Replaces what's kept for one business's return for a year.
  function save(entityId: number, year: string, form: string | null, lines: ReturnLineInput[]) {
    const now = new Date().toISOString();
    raw.exec('BEGIN');
    try {
      raw.prepare('DELETE FROM tax_return_lines WHERE entity_id = ? AND year = ?').run(entityId, year);
      const insert = raw.prepare(
        'INSERT INTO tax_return_lines (entity_id, year, form, section, line, reported, worksheet, categories, note, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      lines.forEach((l, i) =>
        insert.run(entityId, year, form, l.section, l.line, l.reported, l.worksheet ?? null, l.categories?.length ? JSON.stringify(l.categories) : null, l.note ?? null, i, now)
      );
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
    return list(year);
  }

  return { years, list, save };
}

export type ReturnsService = ReturnType<typeof returnsService>;
