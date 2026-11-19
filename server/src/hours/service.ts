// Material participation hours for the rental businesses.
//
// Each log adds up the hours of one taxpayer: a married couple's hours count together,
// so they share a log, and anyone else who must meet the tests on their own (an adult
// child, say) has a log of their own. Hours come from four places:
//   - turnovers: the tasks done after every check-out, worked out from the stays, and
//     left out for the turnovers a paid cleaner did;
//   - repeating work, such as mowing every week between two dates;
//   - business purchases the owner says they installed themselves;
//   - hours entered by hand or imported.
// Worked-out hours are estimates. The owner can change or remove any of them, and a
// change is kept when the hours are worked out again.
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../params';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export type HourSource = 'turnover' | 'recurring' | 'purchase' | 'manual' | 'import';
export const HOUR_SOURCES: HourSource[] = ['turnover', 'recurring', 'purchase', 'manual', 'import'];

// Spending that is usually equipment or materials someone has to put in.
export const INSTALL_CATEGORIES = ['Appliances', 'Tools & Hardware', 'Building & Repair Materials', 'Furniture & Decor', 'Garden & Outdoor', 'Electronics & Computers'];
// Paid help with the turnovers: cleaning payments.
const HELP_CATEGORY = 'Cleaning & Maintenance Services';
const LOOKS_LIKE_CLEANING = /\b(clean\w*|maid\w*|housekeep\w*|turno|janitor\w*)\b/i;
// The smallest purchase asked about.
const SMALLEST_PURCHASE = 50;
// How long after a check-out a cleaner's payment may come.
const HELP_DAYS = 14;
// Who was paid: a Zelle or Venmo line names them ("Zelle payment to Pat Lee for
// Cleaning"); otherwise the payee.
const PAYMENT_APP = /^(zelle|venmo|paypal|cash ?app|online payment|payment)$/i;
export function helperName(description: string, payee: string | null) {
  if (payee && !PAYMENT_APP.test(payee.trim())) return payee;
  const named = description.match(/\b(?:to|from)\s+(.+?)(?:\s+(?:for|on|conf\w*|ref\w*|id)\b.*)?$/i);
  return (named?.[1] || payee || description).trim();
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, days: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDay(d);
};

// What every turnover usually takes, offered when a person has no tasks yet. Minutes
// for one person; the owner changes them to what the work really takes.
export const SUGGESTED_TASKS: { task: string; minutes: number; spa?: boolean }[] = [
  { task: 'Clean the kitchen', minutes: 45 },
  { task: 'Clean the bathrooms', minutes: 45 },
  { task: 'Clean, dust and vacuum the house', minutes: 60 },
  { task: 'Change the linens and make the beds', minutes: 30 },
  { task: 'Laundry', minutes: 60 },
  { task: 'Restock supplies and check for repairs', minutes: 30 },
  { task: 'Spa: test and treat the water, clean the cover and foam, inspect', minutes: 45, spa: true },
];

export interface HoursOptions {
  db: DatabaseSync;
  today?: () => string;
}

export function hoursService({ db, today = () => isoDay(new Date()) }: HoursOptions) {
  const stamp = () => new Date().toISOString();

  const person = (id: number) => {
    const row = db.prepare('SELECT p.id, p.log_id, p.name FROM hour_people p WHERE p.id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'That person is not in a log.');
    return row;
  };
  const property = (id: string | null) => {
    if (id === null) return null;
    const row = db.prepare('SELECT id, name, entity_id FROM stay_properties WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(400, 'That property is not here.');
    return row;
  };
  const entityExists = (id: number) => {
    if (!db.prepare('SELECT 1 FROM entities WHERE id = ?').get(id)) throw new HttpError(400, 'That business is not here.');
  };
  const dateOrder = (from: string | null, to: string | null) => {
    if (from && to && to < from) throw new HttpError(400, 'The end date is before the start.');
  };

  // ---- Logs and people ----

  function addLog(name: string) {
    if (db.prepare('SELECT 1 FROM hour_logs WHERE name = ?').get(name)) throw new HttpError(409, 'A log with that name is already here.');
    const position = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM hour_logs').get() as Row).p;
    return Number(db.prepare('INSERT INTO hour_logs (name, position, created_at) VALUES (?, ?, ?)').run(name, position, stamp()).lastInsertRowid);
  }
  function renameLog(id: number, name: string) {
    if (db.prepare('SELECT 1 FROM hour_logs WHERE name = ? AND id != ?').get(name, id)) throw new HttpError(409, 'A log with that name is already here.');
    if (!db.prepare('UPDATE hour_logs SET name = ? WHERE id = ?').run(name, id).changes) throw new HttpError(404, 'That log is not here.');
  }
  function removeLog(id: number) {
    if (!db.prepare('DELETE FROM hour_logs WHERE id = ?').run(id).changes) throw new HttpError(404, 'That log is not here.');
  }
  function addPerson(logId: number, name: string) {
    if (!db.prepare('SELECT 1 FROM hour_logs WHERE id = ?').get(logId)) throw new HttpError(404, 'That log is not here.');
    if (db.prepare('SELECT 1 FROM hour_people WHERE log_id = ? AND name = ?').get(logId, name)) throw new HttpError(409, 'That person is already in this log.');
    return Number(db.prepare('INSERT INTO hour_people (log_id, name, created_at) VALUES (?, ?, ?)').run(logId, name, stamp()).lastInsertRowid);
  }
  function renamePerson(id: number, name: string) {
    const p = person(id);
    if (db.prepare('SELECT 1 FROM hour_people WHERE log_id = ? AND name = ? AND id != ?').get(p.log_id, name, id)) throw new HttpError(409, 'That person is already in this log.');
    db.prepare('UPDATE hour_people SET name = ? WHERE id = ?').run(name, id);
  }
  function removePerson(id: number) {
    person(id);
    db.prepare('DELETE FROM hour_people WHERE id = ?').run(id);
  }

  // ---- Turnover tasks and repeating work ----

  interface TaskInput {
    personId: number;
    propertyId: string | null;
    task: string;
    minutes: number;
    from: string | null;
    to: string | null;
  }
  function addTask(input: TaskInput) {
    person(input.personId);
    property(input.propertyId);
    dateOrder(input.from, input.to);
    const id = Number(
      db
        .prepare('INSERT INTO hour_tasks (person_id, property_id, task, minutes, from_date, to_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(input.personId, input.propertyId, input.task, input.minutes, input.from, input.to, stamp()).lastInsertRowid,
    );
    rebuild();
    return id;
  }
  function updateTask(id: number, input: TaskInput) {
    person(input.personId);
    property(input.propertyId);
    dateOrder(input.from, input.to);
    const changed = db
      .prepare('UPDATE hour_tasks SET person_id = ?, property_id = ?, task = ?, minutes = ?, from_date = ?, to_date = ? WHERE id = ?')
      .run(input.personId, input.propertyId, input.task, input.minutes, input.from, input.to, id).changes;
    if (!changed) throw new HttpError(404, 'That task is not here.');
    rebuild();
  }
  function removeTask(id: number) {
    if (!db.prepare('DELETE FROM hour_tasks WHERE id = ?').run(id).changes) throw new HttpError(404, 'That task is not here.');
    rebuild();
  }

  interface RecurringInput {
    personId: number;
    entityId: number;
    propertyId: string | null;
    task: string;
    minutes: number;
    everyDays: number;
    start: string;
    end: string | null;
  }
  function checkRecurring(input: RecurringInput) {
    person(input.personId);
    entityExists(input.entityId);
    property(input.propertyId);
    dateOrder(input.start, input.end);
  }
  function addRecurring(input: RecurringInput) {
    checkRecurring(input);
    const id = Number(
      db
        .prepare('INSERT INTO hour_recurring (person_id, entity_id, property_id, task, minutes, every_days, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.personId, input.entityId, input.propertyId, input.task, input.minutes, input.everyDays, input.start, input.end, stamp()).lastInsertRowid,
    );
    rebuild();
    return id;
  }
  function updateRecurring(id: number, input: RecurringInput) {
    checkRecurring(input);
    const changed = db
      .prepare('UPDATE hour_recurring SET person_id = ?, entity_id = ?, property_id = ?, task = ?, minutes = ?, every_days = ?, start_date = ?, end_date = ? WHERE id = ?')
      .run(input.personId, input.entityId, input.propertyId, input.task, input.minutes, input.everyDays, input.start, input.end, id).changes;
    if (!changed) throw new HttpError(404, 'That repeating work is not here.');
    rebuild();
  }
  function removeRecurring(id: number) {
    if (!db.prepare('DELETE FROM hour_recurring WHERE id = ?').run(id).changes) throw new HttpError(404, 'That repeating work is not here.');
    rebuild();
  }

  // ---- Working the hours out ----

  // What the turnovers and repeating work come to now: one entry for each source key.
  function planned() {
    const plan = new Map<string, { personId: number; entityId: number | null; propertyId: string | null; day: string; task: string; minutes: number; source: HourSource }>();
    const until = today();

    const tasks = db.prepare('SELECT id, person_id, property_id, task, minutes, from_date, to_date FROM hour_tasks').all() as Row[];
    if (tasks.length) {
      const cleaned = new Set((db.prepare('SELECT stay_id FROM hour_help WHERE is_help = 1 AND stay_id IS NOT NULL').all() as Row[]).map((r) => String(r.stay_id)));
      const stays = db
        .prepare(
          `SELECT s.id, s.property_id, substr(s.departure, 1, 10) AS day, p.entity_id
           FROM stays s JOIN stay_properties p ON p.id = s.property_id
           WHERE s.status = 'accepted' AND substr(s.departure, 1, 10) <= ?`,
        )
        .all(until) as Row[];
      for (const stay of stays) {
        if (cleaned.has(String(stay.id))) continue;
        for (const t of tasks) {
          if (t.property_id !== null && t.property_id !== stay.property_id) continue;
          if ((t.from_date && stay.day < t.from_date) || (t.to_date && stay.day > t.to_date)) continue;
          plan.set(`turnover:${stay.id}:${t.id}`, {
            personId: Number(t.person_id),
            entityId: stay.entity_id == null ? null : Number(stay.entity_id),
            propertyId: String(stay.property_id),
            day: String(stay.day),
            task: String(t.task),
            minutes: Number(t.minutes),
            source: 'turnover',
          });
        }
      }
    }

    for (const r of db.prepare('SELECT * FROM hour_recurring').all() as Row[]) {
      const last = r.end_date && r.end_date < until ? String(r.end_date) : until;
      const step = Math.max(1, Number(r.every_days));
      for (let day = String(r.start_date), n = 0; day <= last && n < 5000; day = addDays(day, step), n++) {
        plan.set(`recurring:${r.id}:${day}`, {
          personId: Number(r.person_id),
          entityId: Number(r.entity_id),
          propertyId: r.property_id ?? null,
          day,
          task: String(r.task),
          minutes: Number(r.minutes),
          source: 'recurring',
        });
      }
    }
    return plan;
  }

  // Brings the worked-out entries in line with the stays, tasks and repeating work.
  // Entries the owner changed or removed are left as they are.
  function rebuild() {
    const plan = planned();
    const existing = new Map((db.prepare("SELECT id, source_key, edited, removed FROM hour_entries WHERE source IN ('turnover', 'recurring')").all() as Row[]).map((r) => [String(r.source_key), r]));
    const insert = db.prepare(
      'INSERT INTO hour_entries (person_id, entity_id, property_id, worked_on, task, minutes, source, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const refresh = db.prepare('UPDATE hour_entries SET person_id = ?, entity_id = ?, property_id = ?, worked_on = ?, task = ?, minutes = ?, updated_at = ? WHERE id = ?');
    const drop = db.prepare('DELETE FROM hour_entries WHERE id = ?');
    let added = 0;
    let removed = 0;
    const at = stamp();
    db.exec('BEGIN');
    try {
      for (const [key, e] of plan) {
        const row = existing.get(key);
        if (!row) {
          insert.run(e.personId, e.entityId, e.propertyId, e.day, e.task, e.minutes, e.source, key, at, at);
          added++;
        } else if (!row.edited && !row.removed) {
          refresh.run(e.personId, e.entityId, e.propertyId, e.day, e.task, e.minutes, at, row.id);
        }
      }
      // Gone from the plan (a task deleted, a stay cancelled, a cleaner did it): the
      // entry goes too, unless the owner changed it.
      for (const [key, row] of existing) {
        if (plan.has(key) || row.edited) continue;
        drop.run(row.id);
        removed++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return { added, removed };
  }

  // ---- Entries ----

  interface EntryInput {
    personId: number;
    entityId: number | null;
    propertyId: string | null;
    day: string;
    task: string;
    minutes: number;
    note: string | null;
  }
  function entityFor(input: EntryInput) {
    if (input.entityId !== null) {
      entityExists(input.entityId);
      return input.entityId;
    }
    const p = property(input.propertyId);
    return p?.entity_id == null ? null : Number(p.entity_id);
  }
  function addEntry(input: EntryInput, source: 'manual' | 'import' = 'manual') {
    person(input.personId);
    const entity = entityFor(input);
    const at = stamp();
    return Number(
      db
        .prepare('INSERT INTO hour_entries (person_id, entity_id, property_id, worked_on, task, minutes, source, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.personId, entity, input.propertyId, input.day, input.task, input.minutes, source, input.note, at, at).lastInsertRowid,
    );
  }
  function updateEntry(id: number, input: EntryInput) {
    person(input.personId);
    const entity = entityFor(input);
    const changed = db
      .prepare('UPDATE hour_entries SET person_id = ?, entity_id = ?, property_id = ?, worked_on = ?, task = ?, minutes = ?, note = ?, edited = 1, removed = 0, updated_at = ? WHERE id = ?')
      .run(input.personId, entity, input.propertyId, input.day, input.task, input.minutes, input.note, stamp(), id).changes;
    if (!changed) throw new HttpError(404, 'That entry is not here.');
  }
  // A worked-out entry is only marked removed, so working the hours out again doesn't
  // bring it back; one entered by hand is deleted.
  function removeEntry(id: number) {
    const row = db.prepare('SELECT source FROM hour_entries WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'That entry is not here.');
    if (row.source === 'turnover' || row.source === 'recurring') db.prepare('UPDATE hour_entries SET removed = 1, edited = 1, updated_at = ? WHERE id = ?').run(stamp(), id);
    else db.prepare('DELETE FROM hour_entries WHERE id = ?').run(id);
  }
  // Puts a changed or removed worked-out entry back to what the tasks say.
  function resetEntry(id: number) {
    const row = db.prepare('SELECT source FROM hour_entries WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new HttpError(404, 'That entry is not here.');
    if (row.source !== 'turnover' && row.source !== 'recurring') throw new HttpError(400, 'Only worked-out hours can be put back.');
    db.prepare('UPDATE hour_entries SET edited = 0, removed = 0 WHERE id = ?').run(id);
    rebuild();
  }

  function entries(filters: { logId: number; year: string | null; source: HourSource | null; personId: number | null; entityId: number | null; removed: boolean; offset: number; limit: number }) {
    const clauses = ['p.log_id = ?'];
    const params: (string | number)[] = [filters.logId];
    if (filters.year) {
      clauses.push('e.worked_on BETWEEN ? AND ?');
      params.push(`${filters.year}-01-01`, `${filters.year}-12-31`);
    }
    if (filters.source) {
      clauses.push('e.source = ?');
      params.push(filters.source);
    }
    if (filters.personId) {
      clauses.push('e.person_id = ?');
      params.push(filters.personId);
    }
    if (filters.entityId) {
      clauses.push('e.entity_id = ?');
      params.push(filters.entityId);
    }
    clauses.push(filters.removed ? 'e.removed = 1' : 'e.removed = 0');
    const where = clauses.join(' AND ');
    const from = `FROM hour_entries e JOIN hour_people p ON p.id = e.person_id LEFT JOIN stay_properties sp ON sp.id = e.property_id LEFT JOIN entities en ON en.id = e.entity_id WHERE ${where}`;
    const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(e.minutes), 0) AS m ${from}`).get(...params) as Row;
    const rows = db
      .prepare(`SELECT e.*, p.name AS person, sp.name AS property, en.name AS entity ${from} ORDER BY e.worked_on DESC, e.id DESC LIMIT ? OFFSET ?`)
      .all(...params, filters.limit, filters.offset) as Row[];
    return {
      total: Number(totals.n),
      hours: Number(totals.m) / 60,
      entries: rows.map((r) => ({
        id: Number(r.id),
        personId: Number(r.person_id),
        person: String(r.person),
        entityId: r.entity_id == null ? null : Number(r.entity_id),
        entity: r.entity ?? null,
        propertyId: r.property_id ?? null,
        property: r.property ?? null,
        day: String(r.worked_on),
        task: String(r.task),
        hours: Number(r.minutes) / 60,
        source: r.source as HourSource,
        note: r.note ?? null,
        edited: Boolean(r.edited),
        removed: Boolean(r.removed),
      })),
    };
  }

  // ---- Paid help and purchases: questions for the owner ----

  const helpEntity = `COALESCE(t.entity_id, a.entity_id)`;
  // Business spending, not moved between accounts and not marked personal.
  const businessSpend = `t.amount < 0 AND t.kind = 'normal' AND COALESCE(t.status, '') != 'personal'`;

  // Check-outs a cleaner's payment may be for: the two weeks before it.
  function staysBefore(posted: string, entityId: number | null) {
    return (
      db
        .prepare(
          `SELECT s.id, substr(s.departure, 1, 10) AS day, p.name AS property, p.entity_id FROM stays s JOIN stay_properties p ON p.id = s.property_id
           WHERE s.status = 'accepted' AND substr(s.departure, 1, 10) BETWEEN ? AND ? ORDER BY s.departure DESC`,
        )
        .all(addDays(posted, -HELP_DAYS), posted) as Row[]
    )
      .map((s) => ({ id: String(s.id), day: String(s.day), property: String(s.property), entityId: s.entity_id == null ? null : Number(s.entity_id) }))
      .sort((a, b) => Number(b.entityId === entityId) - Number(a.entityId === entityId));
  }

  function helpPayments() {
    const rows = db
      .prepare(
        `SELECT t.id, t.posted, t.amount, t.description, t.payee, t.category, ${helpEntity} AS entity_id, en.name AS entity,
                h.is_help, h.stay_id, h.hours
         FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id LEFT JOIN entities en ON en.id = ${helpEntity}
         LEFT JOIN hour_help h ON h.transaction_id = t.id
         WHERE ${businessSpend} AND (${helpEntity} IN (SELECT id FROM entities WHERE activity = 'str') OR (${helpEntity} IS NULL AND a.owner = 'business') OR h.transaction_id IS NOT NULL)
           AND (t.category = ? OR h.transaction_id IS NOT NULL OR t.description LIKE '%clean%' OR t.description LIKE '%turno%' OR t.description LIKE '%maid%' OR t.payee LIKE '%clean%')
         ORDER BY t.posted DESC`,
      )
      .all(HELP_CATEGORY) as Row[];
    return rows
      .filter((r) => r.is_help !== null || LOOKS_LIKE_CLEANING.test(`${r.description} ${r.payee || ''}`) || r.category === HELP_CATEGORY)
      .map((r) => {
        const stays = staysBefore(String(r.posted), r.entity_id == null ? null : Number(r.entity_id));
        return {
          transactionId: Number(r.id),
          posted: String(r.posted),
          amount: Number(r.amount),
          description: helperName(String(r.description), r.payee ?? null),
          entityId: r.entity_id == null ? null : Number(r.entity_id),
          entity: r.entity ?? null,
          looksLikeCleaning: LOOKS_LIKE_CLEANING.test(`${r.description} ${r.payee || ''}`),
          answered: r.is_help !== null,
          isHelp: r.is_help === null ? null : Boolean(r.is_help),
          stayId: r.stay_id ?? null,
          hours: r.hours == null ? null : Number(r.hours),
          stays: stays.slice(0, 8),
        };
      });
  }

  function answerHelp(transactionId: number, answer: { isHelp: boolean; stayId: string | null; hours: number | null }) {
    if (!db.prepare('SELECT 1 FROM bank_transactions WHERE id = ?').get(transactionId)) throw new HttpError(404, 'That transaction is not here.');
    if (answer.stayId && !db.prepare('SELECT 1 FROM stays WHERE id = ?').get(answer.stayId)) throw new HttpError(400, 'That stay is not here.');
    db.prepare(
      `INSERT INTO hour_help (transaction_id, is_help, stay_id, hours, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (transaction_id) DO UPDATE SET is_help = excluded.is_help, stay_id = excluded.stay_id, hours = excluded.hours`,
    ).run(transactionId, answer.isHelp ? 1 : 0, answer.isHelp ? answer.stayId : null, answer.isHelp ? answer.hours : null, stamp());
    rebuild();
  }
  function forgetHelp(transactionId: number) {
    db.prepare('DELETE FROM hour_help WHERE transaction_id = ?').run(transactionId);
    rebuild();
  }

  function purchases(filters: { answered: boolean; offset: number; limit: number }) {
    const marks = INSTALL_CATEGORIES.map(() => '?').join(', ');
    const where = `${businessSpend} AND t.amount <= ? AND t.category IN (${marks}) AND ${helpEntity} IN (SELECT id FROM entities WHERE activity = 'str')
                   AND ${filters.answered ? 'hp.transaction_id IS NOT NULL' : 'hp.transaction_id IS NULL'}`;
    const from = `FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id LEFT JOIN entities en ON en.id = ${helpEntity} LEFT JOIN hour_purchases hp ON hp.transaction_id = t.id WHERE ${where}`;
    const params = [-SMALLEST_PURCHASE, ...INSTALL_CATEGORIES];
    const total = Number((db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as Row).n);
    const rows = db
      .prepare(`SELECT t.id, t.posted, t.amount, t.description, t.payee, t.category, ${helpEntity} AS entity_id, en.name AS entity, hp.installed ${from} ORDER BY t.posted DESC LIMIT ? OFFSET ?`)
      .all(...params, filters.limit, filters.offset) as Row[];
    const itemsOf = db.prepare(
      `SELECT i.name FROM order_links l JOIN items i ON i.store = l.store AND i.order_id = l.order_id WHERE l.transaction_id = ? AND i.name IS NOT NULL ORDER BY i.position LIMIT 6`,
    );
    const receiptOf = db.prepare(`SELECT vendor, items FROM receipts WHERE transaction_id = ? LIMIT 1`);
    const entryOf = db.prepare(`SELECT id, person_id, minutes, task, worked_on FROM hour_entries WHERE source_key = ?`);
    return {
      total,
      purchases: rows.map((r) => {
        let items = (itemsOf.all(r.id) as Row[]).map((i) => String(i.name));
        if (!items.length) {
          const receipt = receiptOf.get(r.id) as Row | undefined;
          try {
            items = receipt?.items
              ? (JSON.parse(String(receipt.items)) as { description?: string }[])
                  .map((i) => String(i.description || ''))
                  .filter(Boolean)
                  .slice(0, 6)
              : [];
          } catch {
            items = [];
          }
        }
        const entry = entryOf.get(`purchase:${r.id}`) as Row | undefined;
        return {
          transactionId: Number(r.id),
          posted: String(r.posted),
          amount: Number(r.amount),
          description: String(r.payee || r.description),
          category: String(r.category),
          entityId: r.entity_id == null ? null : Number(r.entity_id),
          entity: r.entity ?? null,
          items,
          installed: r.installed == null ? null : Boolean(r.installed),
          entry: entry ? { id: Number(entry.id), personId: Number(entry.person_id), hours: Number(entry.minutes) / 60, task: String(entry.task), day: String(entry.worked_on) } : null,
        };
      }),
    };
  }

  function answerPurchase(transactionId: number, answer: { installed: boolean; personId: number | null; minutes: number | null; task: string | null; day: string | null; propertyId: string | null }) {
    const tx = db
      .prepare(`SELECT t.id, t.posted, t.payee, t.description, ${helpEntity} AS entity_id FROM bank_transactions t JOIN bank_accounts a ON a.id = t.account_id WHERE t.id = ?`)
      .get(transactionId) as Row | undefined;
    if (!tx) throw new HttpError(404, 'That transaction is not here.');
    if (answer.installed && (!answer.personId || !answer.minutes)) throw new HttpError(400, 'Say who put it in and how long it took.');
    if (answer.personId) person(answer.personId);
    property(answer.propertyId);
    const key = `purchase:${transactionId}`;
    const at = stamp();
    db.exec('BEGIN');
    try {
      db.prepare(`INSERT INTO hour_purchases (transaction_id, installed, created_at) VALUES (?, ?, ?) ON CONFLICT (transaction_id) DO UPDATE SET installed = excluded.installed`).run(
        transactionId,
        answer.installed ? 1 : 0,
        at,
      );
      db.prepare('DELETE FROM hour_entries WHERE source_key = ?').run(key);
      if (answer.installed) {
        db.prepare('INSERT INTO hour_entries (person_id, entity_id, property_id, worked_on, task, minutes, source, source_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
          answer.personId,
          tx.entity_id ?? null,
          answer.propertyId,
          answer.day || String(tx.posted),
          answer.task || `Installed: ${tx.payee || tx.description}`,
          answer.minutes,
          'purchase',
          key,
          at,
          at,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  function forgetPurchase(transactionId: number) {
    db.prepare('DELETE FROM hour_purchases WHERE transaction_id = ?').run(transactionId);
    db.prepare('DELETE FROM hour_entries WHERE source_key = ?').run(`purchase:${transactionId}`);
  }

  // ---- The tests ----

  // For each business in a year: each log's hours by person, the paid help's hours, and
  // where each log stands against the two tests most rentals are judged by: 500 hours,
  // or 100 hours and more than any other one person.
  function summary(year: string) {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const people = db
      .prepare(
        `SELECT e.entity_id, p.log_id, p.id AS person_id, p.name, SUM(e.minutes) AS minutes
         FROM hour_entries e JOIN hour_people p ON p.id = e.person_id
         WHERE e.removed = 0 AND e.worked_on BETWEEN ? AND ? GROUP BY e.entity_id, p.id`,
      )
      .all(from, to) as Row[];
    const help = db
      .prepare(
        `SELECT COALESCE(sp.entity_id, t.entity_id, a.entity_id) AS entity_id, t.payee, t.description, h.hours
         FROM hour_help h JOIN bank_transactions t ON t.id = h.transaction_id JOIN bank_accounts a ON a.id = t.account_id
         LEFT JOIN stays s ON s.id = h.stay_id LEFT JOIN stay_properties sp ON sp.id = s.property_id
         WHERE h.is_help = 1 AND t.posted BETWEEN ? AND ?`,
      )
      .all(from, to) as Row[];
    const logs = db.prepare('SELECT id, name FROM hour_logs ORDER BY position, id').all() as Row[];
    const entities = db.prepare('SELECT id, name, activity FROM entities ORDER BY name COLLATE NOCASE').all() as Row[];
    const used = new Set([...people.map((p) => p.entity_id ?? 0), ...help.map((h) => h.entity_id ?? 0)].map(Number));
    const shown = [...entities.filter((e) => e.activity === 'str' || used.has(Number(e.id))), ...(used.has(0) ? [{ id: null, name: 'No business', activity: null }] : [])];

    return shown.map((en) => {
      const id = en.id == null ? null : Number(en.id);
      const mine = people.filter((p) => (p.entity_id == null ? null : Number(p.entity_id)) === id);
      const helpers = help.filter((h) => (h.entity_id == null ? null : Number(h.entity_id)) === id);
      // Each helper is one person in the "more than anyone else" test.
      const byName = new Map<string, { name: string; hours: number; visits: number }>();
      for (const h of helpers) {
        const who = helperName(String(h.description), h.payee ?? null);
        const one = byName.get(who.toLowerCase()) || { name: who, hours: 0, visits: 0 };
        one.hours += Number(h.hours || 0);
        one.visits += 1;
        byName.set(who.toLowerCase(), one);
      }
      const helpers2 = [...byName.values()];
      return {
        entityId: id,
        entity: String(en.name),
        str: en.activity === 'str',
        help: helpers2,
        logs: logs.map((log) => {
          const own = mine.filter((p) => Number(p.log_id) === Number(log.id)).map((p) => ({ personId: Number(p.person_id), name: String(p.name), hours: Number(p.minutes) / 60 }));
          const hours = own.reduce((s, p) => s + p.hours, 0);
          // Everyone outside this log, one person at a time: the other logs' people and
          // each paid helper.
          const others = [
            ...mine.filter((p) => Number(p.log_id) !== Number(log.id)).map((p) => ({ name: String(p.name), hours: Number(p.minutes) / 60 })),
            ...helpers2.map((h) => ({ name: h.name, hours: h.hours })),
          ];
          const most = others.reduce((best, o) => (o.hours > best.hours ? o : best), { name: '', hours: 0 });
          return {
            logId: Number(log.id),
            log: String(log.name),
            hours,
            people: own,
            mostByAnyoneElse: most.hours > 0 ? most : null,
            over500: hours >= 500,
            over100AndMost: hours >= 100 && hours > most.hours,
          };
        }),
      };
    });
  }

  function years() {
    const found = (db.prepare('SELECT DISTINCT substr(worked_on, 1, 4) AS y FROM hour_entries WHERE removed = 0 ORDER BY y DESC').all() as Row[]).map((r) => String(r.y));
    const current = today().slice(0, 4);
    return found.includes(current) ? found : [current, ...found];
  }

  function overview() {
    const logs = db.prepare('SELECT id, name FROM hour_logs ORDER BY position, id').all() as Row[];
    const people = db.prepare('SELECT id, log_id, name FROM hour_people ORDER BY id').all() as Row[];
    const tasks = db.prepare('SELECT t.*, p.name AS property FROM hour_tasks t LEFT JOIN stay_properties p ON p.id = t.property_id ORDER BY t.property_id IS NOT NULL, p.name, t.id').all() as Row[];
    const recurring = db
      .prepare('SELECT r.*, p.name AS property, e.name AS entity FROM hour_recurring r LEFT JOIN stay_properties p ON p.id = r.property_id JOIN entities e ON e.id = r.entity_id ORDER BY r.start_date')
      .all() as Row[];
    const properties = db.prepare('SELECT p.id, p.name, p.entity_id FROM stay_properties p ORDER BY p.name COLLATE NOCASE').all() as Row[];
    const entities = db.prepare("SELECT id, name, activity FROM entities WHERE closed_on IS NULL OR activity = 'str' ORDER BY name COLLATE NOCASE").all() as Row[];
    const personOf = (id: number) => people.find((p) => Number(p.id) === id);
    const helpOpen = helpPayments().filter((h) => !h.answered).length;
    const purchasesOpen = purchases({ answered: false, offset: 0, limit: 1 }).total;
    return {
      logs: logs.map((l) => ({ id: Number(l.id), name: String(l.name), people: people.filter((p) => Number(p.log_id) === Number(l.id)).map((p) => ({ id: Number(p.id), name: String(p.name) })) })),
      tasks: tasks.map((t) => ({
        id: Number(t.id),
        personId: Number(t.person_id),
        logId: Number(personOf(Number(t.person_id))?.log_id),
        propertyId: t.property_id ?? null,
        property: t.property ?? null,
        task: String(t.task),
        hours: Number(t.minutes) / 60,
        from: t.from_date ?? null,
        to: t.to_date ?? null,
      })),
      recurring: recurring.map((r) => ({
        id: Number(r.id),
        personId: Number(r.person_id),
        logId: Number(personOf(Number(r.person_id))?.log_id),
        entityId: Number(r.entity_id),
        entity: String(r.entity),
        propertyId: r.property_id ?? null,
        property: r.property ?? null,
        task: String(r.task),
        hours: Number(r.minutes) / 60,
        everyDays: Number(r.every_days),
        start: String(r.start_date),
        end: r.end_date ?? null,
      })),
      properties: properties.map((p) => ({ id: String(p.id), name: String(p.name), entityId: p.entity_id == null ? null : Number(p.entity_id) })),
      entities: entities.map((e) => ({ id: Number(e.id), name: String(e.name), str: e.activity === 'str' })),
      suggestedTasks: SUGGESTED_TASKS,
      questions: { help: helpOpen, purchases: purchasesOpen },
      years: years(),
    };
  }

  // Rows from a spreadsheet: each is one person's hours on one day.
  function importRows(logId: number, rows: { person: string; day: string; task: string; hours: number; entity: string | null; property: string | null; note: string | null }[]) {
    if (!db.prepare('SELECT 1 FROM hour_logs WHERE id = ?').get(logId)) throw new HttpError(404, 'That log is not here.');
    const peopleByName = new Map((db.prepare('SELECT id, name FROM hour_people WHERE log_id = ?').all(logId) as Row[]).map((p) => [String(p.name).toLowerCase(), Number(p.id)]));
    const entityByName = new Map((db.prepare('SELECT id, name FROM entities').all() as Row[]).map((e) => [String(e.name).toLowerCase(), Number(e.id)]));
    const propertyByName = new Map(
      (db.prepare('SELECT id, name, public_name, entity_id FROM stay_properties').all() as Row[]).flatMap(
        (p) => [[String(p.name).toLowerCase(), p], ...(p.public_name ? [[String(p.public_name).toLowerCase(), p]] : [])] as [string, Row][],
      ),
    );
    const problems: string[] = [];
    rows.forEach((r, i) => {
      if (!peopleByName.has(r.person.toLowerCase())) problems.push(`Row ${i + 1}: ${r.person} is not in this log.`);
      if (r.entity && !entityByName.has(r.entity.toLowerCase())) problems.push(`Row ${i + 1}: no business called ${r.entity}.`);
      if (r.property && !propertyByName.has(r.property.toLowerCase())) problems.push(`Row ${i + 1}: no property called ${r.property}.`);
    });
    if (problems.length) throw new HttpError(400, problems.slice(0, 5).join(' '));
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        const p = r.property ? propertyByName.get(r.property.toLowerCase()) : undefined;
        addEntry(
          {
            personId: peopleByName.get(r.person.toLowerCase())!,
            entityId: r.entity ? entityByName.get(r.entity.toLowerCase())! : null,
            propertyId: p ? String(p.id) : null,
            day: r.day,
            task: r.task,
            minutes: Math.round(r.hours * 60),
            note: r.note,
          },
          'import',
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return rows.length;
  }

  return {
    overview,
    summary,
    entries,
    rebuild,
    addLog,
    renameLog,
    removeLog,
    addPerson,
    renamePerson,
    removePerson,
    addTask,
    updateTask,
    removeTask,
    addRecurring,
    updateRecurring,
    removeRecurring,
    addEntry,
    updateEntry,
    removeEntry,
    resetEntry,
    helpPayments,
    answerHelp,
    forgetHelp,
    purchases,
    answerPurchase,
    forgetPurchase,
    importRows,
  };
}

export type HoursService = ReturnType<typeof hoursService>;
