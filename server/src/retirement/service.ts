// The retirement plan: one saved plan for the household, the starting point taken from
// Wealth (balances by tax treatment, what the invested money is in) and My money (the
// last twelve months' spending), and its projection.
import { HttpError } from '../params';
import type { BankStore } from '../bank/store';
import type { PersonalService } from '../personal/service';
import type { WealthService } from '../wealth/service';
import { BUCKETS, emptyBalances, project } from './project';
import type { Balances, Markets, Mix, Plan } from './project';
import { DEFAULT_TAXES } from './project';
import { STATES, TAX_YEAR } from './tax';
import { DEFAULT_TRIALS, DEFAULT_VOLATILITY, simulate } from './simulate';
import type { Volatility } from './simulate';

const KEY = 'retirement.plan';
const SCENARIOS = 'retirement.scenarios';
export const MAX_SCENARIOS = 10;
export interface Scenario {
  id: number;
  name: string;
  plan: Plan;
  savedAt: string;
}
// Long-run yearly returns before inflation, as a plain starting point to change.
export const DEFAULT_MARKETS: Markets = { stocks: 0.07, bonds: 0.045, cash: 0.035, inflation: 0.028 };
const round = (n: number) => Math.round(n * 100) / 100;

export function retirementService({ bank, wealth, personal, today = () => new Date().toISOString().slice(0, 10) }: { bank: BankStore; wealth: WealthService; personal: PersonalService; today?: () => string }) {
  // Where the plan starts: the household's own accounts (not a business's), by bucket.
  function startingPoint() {
    const w = wealth.summary();
    const balances: Balances = emptyBalances();
    let taxableBasis = 0;
    const left: { name: string; balance: number; why: string }[] = [];
    for (const a of w.accounts) {
      const balance = a.balance ?? 0;
      if (!balance) continue;
      if (a.treatment === 'owed') left.push({ name: a.name, balance, why: 'owed' });
      else if (a.treatment === 'education') left.push({ name: a.name, balance, why: 'education' });
      else if (a.investType === 'deferred_comp') balances.deferred += balance;
      else if (a.treatment === 'pre_tax') balances[a.holder === 'spouse' ? 'pre_tax_spouse' : 'pre_tax'] += balance;
      else if ((BUCKETS as readonly string[]).includes(a.treatment)) {
        balances[a.treatment as keyof Balances] += balance;
        // What was paid for taxable holdings; anything without a cost counts at its value.
        if (a.treatment === 'taxable') {
          const held = a.positions ? wealth.holdings(a.id).holdings : [];
          const value = held.reduce((s, h) => s + h.value, 0);
          taxableBasis += held.reduce((s, h) => s + (h.costBasis ?? h.value), 0) + Math.max(0, balance - value);
        }
      }
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
      taxableBasis: round(taxableBasis),
      left,
      mix,
      spending: { amount: round(spent), from: my.last12.from, to: my.last12.to, firstMonth: my.firstMonth ?? null },
    };
  }

  const saved = (): Plan | null => {
    const raw = bank.getSetting(KEY);
    return raw ? (JSON.parse(raw) as Plan) : null;
  };

  const year = () => Number(today().slice(0, 4));
  function run(plan: Plan) {
    const start = startingPoint();
    return project(plan, { balances: start.balances, taxableBasis: start.taxableBasis }, start.mix, year());
  }

  // Many trials of the plan on random market years.
  function trials(plan: Plan, options: { trials?: number; volatility?: Partial<Volatility> } = {}) {
    const start = startingPoint();
    return simulate(plan, { balances: start.balances, taxableBasis: start.taxableBasis }, start.mix, year(), options);
  }

  // Saved versions of the plan to compare: "retire at 60", "move to North Carolina".
  const scenarios = (): Scenario[] => {
    const raw = bank.getSetting(SCENARIOS);
    return raw ? (JSON.parse(raw) as Scenario[]) : [];
  };
  function saveScenario(name: string, plan: Plan) {
    const list = scenarios();
    const same = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!same && list.length >= MAX_SCENARIOS) throw new HttpError(400, `Up to ${MAX_SCENARIOS} scenarios; remove one first.`);
    const scenario: Scenario = { id: same?.id ?? Math.max(0, ...list.map((s) => s.id)) + 1, name, plan, savedAt: today() };
    const next = same ? list.map((s) => (s.id === same.id ? scenario : s)) : [...list, scenario];
    bank.setSetting(SCENARIOS, JSON.stringify(next));
    return next;
  }
  function removeScenario(id: number) {
    const list = scenarios();
    if (!list.some((s) => s.id === id)) throw new HttpError(404, 'No such scenario.');
    const next = list.filter((s) => s.id !== id);
    bank.setSetting(SCENARIOS, JSON.stringify(next));
    return next;
  }

  // The plan on screen beside each saved scenario: the steady projection and the trials.
  function compare(current: Plan) {
    const entries = [{ id: null as number | null, name: 'This plan', plan: current }, ...scenarios().map((s) => ({ id: s.id as number | null, name: s.name, plan: s.plan }))];
    return entries.map((e) => {
      const steady = run(e.plan);
      const sim = trials(e.plan, { trials: DEFAULT_TRIALS });
      return {
        id: e.id,
        name: e.name,
        retireYear: e.plan.me.birthYear + e.plan.me.retireAge,
        spending: e.plan.spending,
        successRate: sim.successRate,
        runsOut: steady.runsOut,
        atRetirement: steady.atRetirement,
        atEnd: steady.atEnd,
        endP10: sim.end.p10,
        endP50: sim.end.p50,
        lifetimeTax: steady.lifetimeTax,
      };
    });
  }

  function get() {
    const plan = saved();
    return { plan, start: startingPoint(), defaults: { markets: DEFAULT_MARKETS, taxes: DEFAULT_TAXES }, states: Object.entries(STATES).map(([key, s]) => ({ key, ...s })), taxYear: TAX_YEAR, volatility: DEFAULT_VOLATILITY, trials: DEFAULT_TRIALS, scenarios: scenarios(), projection: plan ? run(plan) : null, startYear: Number(today().slice(0, 4)) };
  }

  function save(plan: Plan) {
    bank.setSetting(KEY, JSON.stringify(plan));
    return run(plan);
  }

  return { get, save, preview: run, trials, saveScenario, removeScenario, compare };
}

export type RetirementService = ReturnType<typeof retirementService>;
