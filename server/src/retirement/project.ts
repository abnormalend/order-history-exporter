// The retirement projection: a year-by-year plan on fixed returns, in today's dollars,
// that can be checked by hand. Returns are real (after inflation), pay and spending
// stay flat, and an income that isn't raised for inflation shrinks each year. Taxes
// use this year's tables throughout, since the brackets rise with inflation too.
import { STATES, bracketTop, incomeTax, rmd, rmdAge } from './tax';
import type { Filing, StateRules } from './tax';

export const BUCKETS = ['cash', 'taxable', 'pre_tax', 'pre_tax_spouse', 'deferred', 'hsa', 'roth'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Balances = Record<Bucket, number>;
export const emptyBalances = (): Balances => ({ cash: 0, taxable: 0, pre_tax: 0, pre_tax_spouse: 0, deferred: 0, hsa: 0, roth: 0 });
// The order money is taken out to cover spending and tax; "pre-tax first" fills the
// low brackets with pre-tax money before spending taxable savings.
export const WITHDRAWAL_ORDERS: Record<string, Bucket[]> = {
  standard: ['cash', 'taxable', 'pre_tax', 'pre_tax_spouse', 'hsa', 'roth'],
  pretax_first: ['cash', 'pre_tax', 'pre_tax_spouse', 'taxable', 'hsa', 'roth'],
};
// Contributions come out of pay before take-home.
export const CONTRIBUTION_BUCKETS = ['pre_tax', 'roth', 'hsa', 'deferred'] as const;
export type ContributionBucket = (typeof CONTRIBUTION_BUCKETS)[number];

export interface Person {
  name: string;
  birthYear: number;
  retireAge: number;
  // The plan runs until both have passed this age.
  planToAge: number;
  // Yearly pay after tax and after the contributions below, until retiring.
  takeHome: number;
  // Yearly into each kind of account until retiring, the employer's match included.
  // Deferred is a nonqualified plan (an excess or deferred compensation plan).
  contributions: { pre_tax: number; roth: number; hsa: number; deferred?: number };
  // The monthly benefit at full retirement age, from ssa.gov, and the age to claim it.
  ssAtFullAge: number;
  ssClaimAge: number;
}
export interface Stream {
  name: string;
  owner: 'me' | 'spouse';
  startAge: number;
  endAge: number | null;
  yearly: number;
  // A pension without a cost-of-living raise loses value to inflation every year.
  inflationAdjusted: boolean;
  // Taxed as income (a pension, an annuity's taxable part); missing means yes.
  taxable?: boolean;
}
export interface LifeEvent {
  name: string;
  year: number;
  // How many years in a row, from the year.
  years: number;
  // Money in (+) or out (−), each year, in today's dollars.
  amount: number;
}
export interface Markets {
  // Yearly returns before inflation, as fractions (0.07 for 7%).
  stocks: number;
  bonds: number;
  cash: number;
  inflation: number;
}
export interface TaxPlan {
  // False works the plan out before tax, as a comparison.
  enabled: boolean;
  state: string;
  // For a custom state.
  stateRate?: number;
  stateDeduction?: number;
  // Convert pre-tax money to Roth each year from retiring until RMDs, up to the top of
  // this bracket (0.12, 0.22, 0.24, 0.32), or not at all.
  rothConversionsTo: number | null;
  withdrawalOrder: 'standard' | 'pretax_first';
  // A deferred compensation plan pays out in equal yearly installments, starting the
  // year after its owner retires.
  deferredYears: number;
}
export interface Plan {
  me: Person;
  spouse: Person | null;
  // Yearly spending in today's dollars, and how it changes once the older is 80.
  spending: number;
  spendingChangeAt80: number;
  markets: Markets;
  streams: Stream[];
  events: LifeEvent[];
  taxes?: TaxPlan;
}
export const DEFAULT_TAXES: TaxPlan = { enabled: true, state: 'none', rothConversionsTo: null, withdrawalOrder: 'standard', deferredYears: 5 };
// What the invested money is in, as shares adding to 1: decides its return.
export interface Mix {
  stocks: number;
  bonds: number;
  cash: number;
}
export interface Start {
  balances: Balances;
  // What was paid for the taxable account's holdings, for the gain when they're sold.
  taxableBasis: number;
}

export interface Row {
  year: number;
  ages: [number | null, number | null];
  pay: number;
  socialSecurity: number;
  other: number;
  events: number;
  spending: number;
  contributions: number;
  growth: number;
  rmd: number;
  deferredPaid: number;
  conversion: number;
  gains: number;
  withdrawn: Balances;
  saved: number;
  tax: { federal: number; state: number };
  taxableOrdinary: number;
  shortfall: number;
  end: Balances;
  total: number;
}
export interface Projection {
  rows: Row[];
  returns: { invested: number; cash: number };
  socialSecurity: { me: number; spouse: number | null };
  // The first year spending couldn't be met, and the ages then.
  runsOut: { year: number; ages: [number | null, number | null] } | null;
  atRetirement: { year: number; total: number } | null;
  atEnd: number;
  lifetimeTax: number;
  rmdStarts: { me: number; spouse: number | null };
}

const round = (n: number) => Math.round(n * 100) / 100;
const real = (nominal: number, inflation: number) => (1 + nominal) / (1 + inflation) - 1;

// Full retirement age, in months, by birth year.
export function fullAgeMonths(birthYear: number): number {
  if (birthYear >= 1960) return 67 * 12;
  if (birthYear <= 1954) return 66 * 12;
  return 66 * 12 + (birthYear - 1954) * 2;
}

// What claiming at an age does to the full-age benefit: 5/9 of 1% less a month for the
// first 36 months early and 5/12 of 1% for each month before that; 2/3 of 1% more a
// month after full age, up to 70.
export function claimFactor(birthYear: number, claimAge: number): number {
  const months = Math.round(Math.min(70, Math.max(62, claimAge)) * 12) - fullAgeMonths(birthYear);
  if (months < 0) {
    const early = -months;
    return 1 - (Math.min(early, 36) * 5) / 900 - (Math.max(early - 36, 0) * 5) / 1200;
  }
  return 1 + (months * 2) / 300;
}

// A spouse's benefit, at most half the other's full-age benefit, cut for claiming early
// (25/36 of 1% a month for 36 months, 5/12 of 1% beyond); never raised for waiting.
export function spousalFactor(birthYear: number, claimAge: number): number {
  const months = Math.round(Math.min(70, Math.max(62, claimAge)) * 12) - fullAgeMonths(birthYear);
  if (months >= 0) return 0.5;
  const early = -months;
  return 0.5 * (1 - (Math.min(early, 36) * 25) / 3600 - (Math.max(early - 36, 0) * 5) / 1200);
}

// The invested return from the mix; cash in the bank earns the cash rate.
export function returnsFor(markets: Markets, mix: Mix) {
  const sum = mix.stocks + mix.bonds + mix.cash || 1;
  const nominal = (mix.stocks * markets.stocks + mix.bonds * markets.bonds + mix.cash * markets.cash) / sum;
  return { invested: real(nominal, markets.inflation), cash: real(markets.cash, markets.inflation) };
}

export function stateRules(taxes: TaxPlan): StateRules {
  const base = STATES[taxes.state] ?? STATES.none;
  if (taxes.state !== 'custom') return base;
  return { ...base, rate: taxes.stateRate ?? base.rate, deduction: taxes.stateDeduction ?? base.deduction };
}

export function project(plan: Plan, start: Start | Balances, mix: Mix, startYear: number): Projection {
  const taxes = { ...DEFAULT_TAXES, ...(plan.taxes ?? {}) };
  const state = stateRules(taxes);
  const returns = returnsFor(plan.markets, mix);
  const people = [plan.me, plan.spouse] as const;
  const opening = 'balances' in start ? start : { balances: start as Balances, taxableBasis: (start as Balances).taxable };
  const balances: Balances = { ...emptyBalances(), ...opening.balances };
  let basis = Math.min(opening.taxableBasis, balances.taxable);
  const preTaxOf: Bucket[] = ['pre_tax', 'pre_tax_spouse'];
  const own = people.map((p) => (p ? p.ssAtFullAge * 12 * claimFactor(p.birthYear, p.ssClaimAge) : 0));
  // Each one's yearly benefit once claimed, the spousal amount if it's more.
  const benefit = people.map((p, i) => {
    const other = people[1 - i];
    if (!p) return 0;
    return Math.max(own[i], other ? other.ssAtFullAge * 12 * spousalFactor(p.birthYear, p.ssClaimAge) : 0);
  });
  const living = people.filter(Boolean) as Person[];
  const lastYear = Math.max(...living.map((p) => p.birthYear + p.planToAge));
  const retireYear = Math.max(...living.map((p) => p.birthYear + p.retireAge));
  const deferredStarts = plan.me.birthYear + plan.me.retireAge + 1;
  const deferredEnds = deferredStarts + Math.max(1, taxes.deferredYears);
  const rows: Row[] = [];
  let runsOut: Projection['runsOut'] = null;
  let atRetirement: Projection['atRetirement'] = null;
  let lifetimeTax = 0;
  let widowed = false;

  for (let year = startYear; year <= lastYear; year++) {
    const ages = people.map((p) => (p ? year - p.birthYear : null)) as [number | null, number | null];
    const alive = people.map((p, i) => Boolean(p) && ages[i]! <= p!.planToAge);
    const working = people.map((p, i) => alive[i] && ages[i]! < p!.retireAge);
    const filing: Filing = alive[0] && alive[1] ? 'mfj' : 'single';
    // A survivor takes over the other's pre-tax accounts (a spousal rollover).
    if (!widowed && plan.spouse && !(alive[0] && alive[1])) {
      widowed = true;
      const to = alive[0] ? 'pre_tax' : 'pre_tax_spouse';
      const from = alive[0] ? 'pre_tax_spouse' : 'pre_tax';
      balances[to] += balances[from];
      balances[from] = 0;
    }

    // RMDs are worked out on the year's opening balance; then the year's growth.
    const rmds = preTaxOf.map((b, i) => (people[i] && alive[i] ? rmd(people[i]!.birthYear, ages[i]!, balances[b]) : 0));
    let growth = 0;
    for (const b of BUCKETS) {
      const g = balances[b] > 0 ? balances[b] * (b === 'cash' ? returns.cash : returns.invested) : 0;
      balances[b] += g;
      growth += g;
    }
    let rmdTotal = 0;
    preTaxOf.forEach((b, i) => {
      const take = Math.min(rmds[i], balances[b]);
      balances[b] -= take;
      rmdTotal += take;
    });
    // Deferred compensation pays out in equal parts of what's left over the years remaining.
    let deferredPaid = 0;
    if (year >= deferredStarts && balances.deferred > 0) {
      const remaining = Math.max(1, deferredEnds - year);
      deferredPaid = year >= deferredEnds - 1 ? balances.deferred : balances.deferred / remaining;
      balances.deferred -= deferredPaid;
    }

    const pay = people.reduce((s, p, i) => s + (working[i] ? p!.takeHome : 0), 0);
    // Social Security once claimed; after a death the survivor keeps the larger benefit.
    let socialSecurity = 0;
    people.forEach((p, i) => {
      if (!p || !alive[i] || ages[i]! < p.ssClaimAge) return;
      const other = people[1 - i];
      const lost = other && !alive[1 - i];
      socialSecurity += lost ? Math.max(benefit[i], own[1 - i]) : benefit[i];
    });
    let other = 0;
    let otherTaxed = 0;
    for (const s of plan.streams) {
      const i = s.owner === 'me' ? 0 : 1;
      const age = ages[i];
      if (!people[i] || !alive[i] || age === null || age < s.startAge || (s.endAge !== null && age >= s.endAge)) continue;
      const amount = s.inflationAdjusted ? s.yearly : s.yearly / (1 + plan.markets.inflation) ** (year - startYear);
      other += amount;
      if (s.taxable !== false) otherTaxed += amount;
    }
    const events = plan.events.reduce((s, e) => s + (year >= e.year && year < e.year + Math.max(1, e.years) ? e.amount : 0), 0);
    const oldest = Math.max(...ages.filter((a, i) => a !== null && alive[i]).map(Number));
    const spending = alive.some(Boolean) ? plan.spending * (oldest >= 80 ? 1 + plan.spendingChangeAt80 : 1) : 0;

    let contributions = 0;
    people.forEach((p, i) => {
      if (!p || !working[i]) return;
      for (const b of CONTRIBUTION_BUCKETS) {
        const amount = p.contributions[b] ?? 0;
        const into: Bucket = b === 'pre_tax' && i === 1 ? 'pre_tax_spouse' : b;
        balances[into] += amount;
        contributions += amount;
      }
    });

    // Roth conversions: once both have retired and until the first RMD, fill the chosen
    // bracket with pre-tax money moved to Roth (its tax is paid from other money).
    const retiredAll = people.every((p, i) => !p || !working[i]);
    const beforeRmds = people.some((p, i) => p && alive[i] && ages[i]! < rmdAge(p.birthYear));
    const converting = taxes.enabled && taxes.rothConversionsTo !== null && retiredAll && beforeRmds && year >= startYear;
    const over65 = people.filter((p, i) => p && alive[i] && ages[i]! >= 65).length;
    const cashIn = pay + socialSecurity + other + events + rmdTotal + deferredPaid;
    const order = WITHDRAWAL_ORDERS[taxes.withdrawalOrder] ?? WITHDRAWAL_ORDERS.standard;
    const gainShare = () => (balances.taxable > 0 ? Math.max(0, 1 - basis / balances.taxable) : 0);

    // Taking money out raises the tax, which needs more taken out: settle it by repeating.
    let tax = { federal: 0, state: 0, taxableOrdinary: 0 };
    let plan_: { withdrawn: Balances; gains: number; conversion: number; shortfall: number; saved: number } = { withdrawn: emptyBalances(), gains: 0, conversion: 0, shortfall: 0, saved: 0 };
    for (let round_ = 0; round_ < 30; round_++) {
      const need = spending + tax.federal + tax.state - cashIn;
      const withdrawn = emptyBalances();
      const left = { ...balances };
      let gains = 0;
      let shortfall = 0;
      let saved = 0;
      if (need <= 0) saved = -need;
      else {
        let rest = need;
        for (const b of order) {
          const take = Math.min(rest, Math.max(0, left[b]));
          if (b === 'taxable') gains += take * gainShare();
          left[b] -= take;
          withdrawn[b] = take;
          rest -= take;
          if (rest <= 0.005) break;
        }
        shortfall = rest > 0.005 ? rest : 0;
      }
      const ordinaryBase = rmdTotal + deferredPaid + otherTaxed + withdrawn.pre_tax + withdrawn.pre_tax_spouse;
      let conversion = 0;
      if (converting) {
        const top = bracketTop(filing, taxes.rothConversionsTo!);
        // The most that keeps taxable income within the bracket, allowing for the unused
        // deduction and for more Social Security becoming taxable: found by halving.
        const within = (c: number) => incomeTax({ filing, year, over65, ordinary: ordinaryBase + c, retirement: 0, socialSecurity, gains, state }).taxableOrdinary <= top;
        let low = 0;
        let high = Math.min(left.pre_tax + left.pre_tax_spouse, top + 200000);
        if (within(high)) low = high;
        else
          for (let k = 0; k < 40 && high - low > 0.5; k++) {
            const mid = (low + high) / 2;
            if (within(mid)) low = mid;
            else high = mid;
          }
        conversion = within(Math.ceil(low)) ? Math.ceil(low) : Math.floor(low);
      }
      const ordinary = ordinaryBase + conversion;
      const next = taxes.enabled
        ? incomeTax({ filing, year, over65, ordinary, retirement: ordinary - otherTaxed, socialSecurity, gains, state })
        : { federal: 0, state: 0, taxableOrdinary: 0 };
      plan_ = { withdrawn, gains, conversion, shortfall, saved };
      const settled = Math.abs(next.federal + next.state - tax.federal - tax.state) < 0.5;
      tax = { federal: next.federal, state: next.state, taxableOrdinary: next.taxableOrdinary };
      if (settled) break;
    }

    // Apply the year: withdrawals, the conversion, and savings into the taxable account.
    for (const b of BUCKETS) {
      if (b === 'taxable' && plan_.withdrawn.taxable > 0) basis -= basis * Math.min(1, plan_.withdrawn.taxable / Math.max(balances.taxable, 1e-9));
      balances[b] -= plan_.withdrawn[b];
    }
    let toConvert = plan_.conversion;
    for (const b of preTaxOf) {
      const take = Math.min(toConvert, balances[b]);
      balances[b] -= take;
      toConvert -= take;
    }
    balances.roth += plan_.conversion;
    if (plan_.saved > 0) {
      balances.taxable += plan_.saved;
      basis += plan_.saved;
    }
    const shortfall = round(plan_.shortfall);
    if (shortfall && !runsOut) runsOut = { year, ages };
    const total = BUCKETS.reduce((s, b) => s + balances[b], 0);
    if (year === retireYear) atRetirement = { year, total: round(total) };
    lifetimeTax += tax.federal + tax.state;
    rows.push({
      year,
      ages,
      pay: round(pay),
      socialSecurity: round(socialSecurity),
      other: round(other),
      events: round(events),
      spending: round(spending),
      contributions: round(contributions),
      growth: round(growth),
      rmd: round(rmdTotal),
      deferredPaid: round(deferredPaid),
      conversion: round(plan_.conversion),
      gains: round(plan_.gains),
      withdrawn: Object.fromEntries(BUCKETS.map((b) => [b, round(plan_.withdrawn[b])])) as Balances,
      saved: round(plan_.saved),
      tax: { federal: round(tax.federal), state: round(tax.state) },
      taxableOrdinary: round(tax.taxableOrdinary),
      shortfall,
      end: Object.fromEntries(BUCKETS.map((b) => [b, round(balances[b])])) as Balances,
      total: round(total),
    });
  }
  return {
    rows,
    returns,
    socialSecurity: { me: round(benefit[0]), spouse: plan.spouse ? round(benefit[1]) : null },
    runsOut,
    atRetirement,
    atEnd: rows.length ? rows[rows.length - 1].total : 0,
    lifetimeTax: round(lifetimeTax),
    rmdStarts: { me: plan.me.birthYear + rmdAge(plan.me.birthYear), spouse: plan.spouse ? plan.spouse.birthYear + rmdAge(plan.spouse.birthYear) : null },
  };
}
