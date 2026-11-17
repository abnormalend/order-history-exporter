// The retirement plan: one saved plan for the household, the starting point taken from
// Wealth (balances by tax treatment, what the invested money is in) and My money (the
// last twelve months' spending), and its projection.
import type { BankStore } from '../bank/store';
import type { PersonalService } from '../personal/service';
import type { WealthService } from '../wealth/service';
import { BUCKETS, project } from './project';
import type { Balances, Markets, Mix, Plan } from './project';

const KEY = 'retirement.plan';
// Long-run yearly returns before inflation, as a plain starting point to change.
export const DEFAULT_MARKETS: Markets = { stocks: 0.07, bonds: 0.045, cash: 0.035, inflation: 0.028 };
const round = (n: number) => Math.round(n * 100) / 100;

export function retirementService({ bank, wealth, personal, today = () => new Date().toISOString().slice(0, 10) }: { bank: BankStore; wealth: WealthService; personal: PersonalService; today?: () => string }) {
  // Where the plan starts: the household's own accounts (not a business's), by bucket.
  function startingPoint() {
    const w = wealth.summary();
    const balances: Balances = { cash: 0, taxable: 0, pre_tax: 0, hsa: 0, roth: 0 };
    const left: { name: string; balance: number; why: string }[] = [];
    for (const a of w.accounts) {
      const balance = a.balance ?? 0;
      if (!balance) continue;
      if (a.treatment === 'owed') left.push({ name: a.name, balance, why: 'owed' });
      else if (a.treatment === 'education') left.push({ name: a.name, balance, why: 'education' });
      else if ((BUCKETS as readonly string[]).includes(a.treatment)) balances[a.treatment as keyof Balances] += balance;
    }
    for (const b of BUCKETS) balances[b] = round(balances[b]);
    // Target-date and mixed funds count as 60% stocks, 40% bonds.
    const share = (key: string) => w.allocation.find((c) => c.key === key)?.share ?? 0;
    const mixed = share('target_date');
    const mix: Mix = {
      bonds: share('bond') + mixed * 0.4,
      cash: share('cash'),
      stocks: share('us_stock') + share('intl_stock') + share('real_estate') + share('other') + share('unknown') + mixed * 0.6,
    };
    if (!w.allocation.length) Object.assign(mix, { stocks: 0.6, bonds: 0.4, cash: 0 });
    const my = personal.summary({});
    const spent = my.last12.spent.reduce((s, g) => s + g.amount, 0);
    return {
      balances,
      left,
      mix,
      spending: { amount: round(spent), from: my.last12.from, to: my.last12.to, firstMonth: my.firstMonth ?? null },
    };
  }

  const saved = (): Plan | null => {
    const raw = bank.getSetting(KEY);
    return raw ? (JSON.parse(raw) as Plan) : null;
  };

  function run(plan: Plan) {
    const start = startingPoint();
    return project(plan, start.balances, start.mix, Number(today().slice(0, 4)));
  }

  function get() {
    const plan = saved();
    return { plan, start: startingPoint(), defaults: { markets: DEFAULT_MARKETS }, projection: plan ? run(plan) : null, startYear: Number(today().slice(0, 4)) };
  }

  function save(plan: Plan) {
    bank.setSetting(KEY, JSON.stringify(plan));
    return run(plan);
  }

  return { get, save, preview: run };
}

export type RetirementService = ReturnType<typeof retirementService>;
