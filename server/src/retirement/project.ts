// The retirement projection: a year-by-year plan on fixed returns, in today's dollars,
// that can be checked by hand. Everything is in today's dollars: returns are real
// (after inflation), pay and spending stay flat, and an income that isn't raised for
// inflation shrinks each year. Taxes and required withdrawals come in the next step;
// here, money taken from any account counts at its full value.

export const BUCKETS = ['cash', 'taxable', 'pre_tax', 'hsa', 'roth'] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Balances = Record<Bucket, number>;
// The order money is taken out to cover spending.
export const WITHDRAWAL_ORDER: Bucket[] = ['cash', 'taxable', 'pre_tax', 'hsa', 'roth'];
// Contributions come out of pay before take-home: into these.
export const CONTRIBUTION_BUCKETS = ['pre_tax', 'roth', 'hsa'] as const;
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
  contributions: Record<ContributionBucket, number>;
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
export interface Plan {
  me: Person;
  spouse: Person | null;
  // Yearly spending in today's dollars, and how it changes once the older is 80.
  spending: number;
  spendingChangeAt80: number;
  markets: Markets;
  streams: Stream[];
  events: LifeEvent[];
}
// What the invested money is in, as shares adding to 1: decides its return.
export interface Mix {
  stocks: number;
  bonds: number;
  cash: number;
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
  withdrawn: Balances;
  saved: number;
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

export function project(plan: Plan, start: Balances, mix: Mix, startYear: number): Projection {
  const returns = returnsFor(plan.markets, mix);
  const people = [plan.me, plan.spouse] as const;
  const balances: Balances = { ...start };
  const own = people.map((p) => (p ? p.ssAtFullAge * 12 * claimFactor(p.birthYear, p.ssClaimAge) : 0));
  // Each one's yearly benefit once claimed, the spousal amount if it's more.
  const benefit = people.map((p, i) => {
    const other = people[1 - i];
    if (!p) return 0;
    return Math.max(own[i], other ? other.ssAtFullAge * 12 * spousalFactor(p.birthYear, p.ssClaimAge) : 0);
  });
  const lastYear = Math.max(...people.filter(Boolean).map((p) => p!.birthYear + p!.planToAge));
  const rows: Row[] = [];
  let runsOut: Projection['runsOut'] = null;
  let atRetirement: Projection['atRetirement'] = null;
  const retireYear = Math.max(...people.filter(Boolean).map((p) => p!.birthYear + p!.retireAge));

  for (let year = startYear; year <= lastYear; year++) {
    const ages = people.map((p) => (p ? year - p.birthYear : null)) as [number | null, number | null];
    const alive = people.map((p, i) => Boolean(p) && ages[i]! <= p!.planToAge);
    const working = people.map((p, i) => alive[i] && ages[i]! < p!.retireAge);

    // Growth on the year's opening balances.
    let growth = 0;
    for (const b of BUCKETS) {
      const g = balances[b] > 0 ? balances[b] * (b === 'cash' ? returns.cash : returns.invested) : 0;
      balances[b] += g;
      growth += g;
    }

    const pay = people.reduce((s, p, i) => s + (working[i] ? p!.takeHome : 0), 0);
    // Social Security once claimed; after a death the survivor keeps the larger benefit.
    let socialSecurity = 0;
    people.forEach((p, i) => {
      if (!p || !alive[i] || ages[i]! < p.ssClaimAge) return;
      const other = people[1 - i];
      const widowed = other && !alive[1 - i];
      socialSecurity += widowed ? Math.max(benefit[i], own[1 - i]) : benefit[i];
    });
    let other = 0;
    for (const s of plan.streams) {
      const i = s.owner === 'me' ? 0 : 1;
      const age = ages[i];
      if (!people[i] || !alive[i] || age === null || age < s.startAge || (s.endAge !== null && age >= s.endAge)) continue;
      other += s.inflationAdjusted ? s.yearly : s.yearly / (1 + plan.markets.inflation) ** (year - startYear);
    }
    const events = plan.events.reduce((s, e) => s + (year >= e.year && year < e.year + Math.max(1, e.years) ? e.amount : 0), 0);
    const oldest = Math.max(...ages.filter((a, i) => a !== null && alive[i]).map(Number));
    const spending = alive.some(Boolean) ? plan.spending * (oldest >= 80 ? 1 + plan.spendingChangeAt80 : 1) : 0;

    let contributions = 0;
    people.forEach((p, i) => {
      if (!p || !working[i]) return;
      for (const b of CONTRIBUTION_BUCKETS) {
        balances[b] += p.contributions[b];
        contributions += p.contributions[b];
      }
    });

    // What's left over is saved in the taxable account; a gap is taken out in order.
    const net = pay + socialSecurity + other + events - spending;
    const withdrawn: Balances = { cash: 0, taxable: 0, pre_tax: 0, hsa: 0, roth: 0 };
    let saved = 0;
    let shortfall = 0;
    if (net >= 0) {
      balances.taxable += net;
      saved = net;
    } else {
      let need = -net;
      for (const b of WITHDRAWAL_ORDER) {
        const take = Math.min(need, Math.max(0, balances[b]));
        balances[b] -= take;
        withdrawn[b] = round(take);
        need -= take;
        if (need <= 0.005) break;
      }
      shortfall = need > 0.005 ? round(need) : 0;
    }
    if (shortfall && !runsOut) runsOut = { year, ages };
    const total = BUCKETS.reduce((s, b) => s + balances[b], 0);
    if (year === retireYear) atRetirement = { year, total: round(total) };
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
      withdrawn,
      saved: round(saved),
      shortfall,
      end: Object.fromEntries(BUCKETS.map((b) => [b, round(balances[b])])) as Balances,
      total: round(total),
    });
  }
  if (!atRetirement && retireYear < startYear) atRetirement = null;
  return {
    rows,
    returns,
    socialSecurity: { me: round(benefit[0]), spouse: plan.spouse ? round(benefit[1]) : null },
    runsOut,
    atRetirement,
    atEnd: rows.length ? rows[rows.length - 1].total : 0,
  };
}
