// Monte Carlo trials of the retirement plan: the same plan run many times, each with
// its own random sequence of market years, to see how often the money lasts and the
// range of what's left. Returns are drawn from a lognormal around each market's
// expected return, with stocks and bonds slightly linked; inflation stays steady, so
// everything is still in today's dollars. A fixed seed gives the same answer each time
// for the same plan, so a change to the plan is what moves the result.
import { project } from './project';
import type { Mix, Plan, Projection, Start, YearReturns } from './project';

// How much each market's yearly return swings (standard deviation, before inflation).
export const DEFAULT_VOLATILITY = { stocks: 0.17, bonds: 0.06, cash: 0.01 };
const STOCK_BOND_LINK = 0.1;
export const DEFAULT_TRIALS = 1000;

export interface Volatility {
  stocks: number;
  bonds: number;
  cash: number;
}

// A small seeded random number generator (mulberry32), and normal draws from it.
export function randomSource(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare: number | null = null;
  const normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = next();
    const v = next();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
  return { next, normal };
}

// A lognormal yearly return with this average and spread: never below −100%.
export function lognormal(mean: number, sd: number, z: number) {
  const sigma2 = Math.log(1 + (sd * sd) / ((1 + mean) * (1 + mean)));
  return Math.exp(Math.log(1 + mean) - sigma2 / 2 + Math.sqrt(sigma2) * z) - 1;
}

// One trial's real returns for each year.
export function drawYears(plan: Plan, mix: Mix, years: number, vol: Volatility, random: ReturnType<typeof randomSource>): YearReturns {
  const m = plan.markets;
  const sum = mix.stocks + mix.bonds + mix.cash || 1;
  const out: YearReturns = [];
  for (let i = 0; i < years; i++) {
    const zs = random.normal();
    const zb = STOCK_BOND_LINK * zs + Math.sqrt(1 - STOCK_BOND_LINK ** 2) * random.normal();
    const zc = random.normal();
    const stocks = lognormal(m.stocks, vol.stocks, zs);
    const bonds = lognormal(m.bonds, vol.bonds, zb);
    const cash = lognormal(m.cash, vol.cash, zc);
    const nominal = (mix.stocks * stocks + mix.bonds * bonds + mix.cash * cash) / sum;
    out.push({ invested: (1 + nominal) / (1 + m.inflation) - 1, cash: (1 + cash) / (1 + m.inflation) - 1 });
  }
  return out;
}

// The value below which this share of the sorted list falls (linear between points).
export function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export interface Simulation {
  trials: number;
  // The share of trials in which spending was always met.
  successRate: number;
  // The total balance each year: the 10th, 25th, 50th, 75th and 90th percentile trial.
  years: { year: number; ages: [number | null, number | null]; p10: number; p25: number; p50: number; p75: number; p90: number }[];
  end: { p10: number; p50: number; p90: number };
  // Among trials that ran short: when, typically, and the earliest one in ten.
  shortfall: { medianYear: number; earlyYear: number } | null;
  lifetimeTax: { p50: number };
  volatility: Volatility;
}

const round = (n: number) => Math.round(n);

export function simulate(plan: Plan, start: Start, mix: Mix, startYear: number, options: { trials?: number; seed?: number; volatility?: Partial<Volatility> } = {}): Simulation {
  const trials = Math.max(1, Math.min(5000, Math.round(options.trials ?? DEFAULT_TRIALS)));
  const vol = { ...DEFAULT_VOLATILITY, ...plan.markets.volatility, ...options.volatility };
  const random = randomSource(options.seed ?? 20260101);
  const steady = project(plan, start, mix, startYear);
  const years = steady.rows.length;
  const totals: number[][] = steady.rows.map(() => []);
  const ends: number[] = [];
  const taxes: number[] = [];
  const failures: number[] = [];
  for (let t = 0; t < trials; t++) {
    const run: Projection = project(plan, start, mix, startYear, drawYears(plan, mix, years, vol, random));
    run.rows.forEach((r, i) => totals[i].push(r.total));
    ends.push(run.atEnd);
    taxes.push(run.lifetimeTax);
    if (run.runsOut) failures.push(run.runsOut.year);
  }
  const sorted = (list: number[]) => [...list].sort((a, b) => a - b);
  const endSorted = sorted(ends);
  const failSorted = sorted(failures);
  return {
    trials,
    successRate: Math.round(((trials - failures.length) / trials) * 1000) / 1000,
    years: steady.rows.map((r, i) => {
      const s = sorted(totals[i]);
      return { year: r.year, ages: r.ages, p10: round(percentile(s, 0.1)), p25: round(percentile(s, 0.25)), p50: round(percentile(s, 0.5)), p75: round(percentile(s, 0.75)), p90: round(percentile(s, 0.9)) };
    }),
    end: { p10: round(percentile(endSorted, 0.1)), p50: round(percentile(endSorted, 0.5)), p90: round(percentile(endSorted, 0.9)) },
    shortfall: failSorted.length ? { medianYear: Math.round(percentile(failSorted, 0.5)), earlyYear: Math.round(percentile(failSorted, 0.1)) } : null,
    lifetimeTax: { p50: round(percentile(sorted(taxes), 0.5)) },
    volatility: vol,
  };
}
