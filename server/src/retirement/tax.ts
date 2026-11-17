// Income tax for the retirement projection: federal (ordinary brackets, long-term gains,
// the taxable share of Social Security, the net investment income tax) and a state's.
// The plan is in today's dollars and the brackets rise with inflation, so this year's
// tables apply to every year. Update these once a year.

export const TAX_YEAR = 2026;
export type Filing = 'mfj' | 'single';

interface Table {
  standard: number;
  // The extra standard deduction for each person 65 or older.
  extra65: number;
  // Ordinary income brackets: [top of the bracket, rate]; the last top is Infinity.
  brackets: [number, number][];
  // Long-term gains: 0% up to the first, 15% up to the second, 20% above.
  gains: [number, number];
  // The net investment income tax starts above this (not raised for inflation).
  niit: number;
  // Social Security: half is taxable above the first, 85% above the second (fixed in law).
  ss: [number, number];
  // The extra deduction for people 65 or older through 2028, and where it phases out.
  senior: { amount: number; phaseOutFrom: number };
}

export const FEDERAL: Record<Filing, Table> = {
  mfj: {
    standard: 32200,
    extra65: 1650,
    brackets: [
      [24800, 0.1],
      [100800, 0.12],
      [211400, 0.22],
      [403550, 0.24],
      [512450, 0.32],
      [768700, 0.35],
      [Infinity, 0.37],
    ],
    gains: [98900, 613700],
    niit: 250000,
    ss: [32000, 44000],
    senior: { amount: 6000, phaseOutFrom: 150000 },
  },
  single: {
    standard: 16100,
    extra65: 2050,
    brackets: [
      [12400, 0.1],
      [50400, 0.12],
      [105700, 0.22],
      [201775, 0.24],
      [256225, 0.32],
      [640600, 0.35],
      [Infinity, 0.37],
    ],
    gains: [49450, 545500],
    niit: 200000,
    ss: [25000, 34000],
    senior: { amount: 6000, phaseOutFrom: 75000 },
  },
};
const SENIOR_LAST_YEAR = 2028;

// States people commonly retire in or compare. A flat rate after a deduction, and
// whether Social Security and retirement withdrawals are taxed there.
export interface StateRules {
  label: string;
  rate: number;
  // The deduction or exemptions for a couple; half for one person.
  deduction: number;
  taxesSocialSecurity: boolean;
  taxesRetirement: boolean;
}
export const STATES: Record<string, StateRules> = {
  none: { label: 'No state income tax (FL, TX, NV, TN, WA…)', rate: 0, deduction: 0, taxesSocialSecurity: false, taxesRetirement: false },
  NC: { label: 'North Carolina', rate: 0.0399, deduction: 25500, taxesSocialSecurity: false, taxesRetirement: true },
  IL: { label: 'Illinois', rate: 0.0495, deduction: 5700, taxesSocialSecurity: false, taxesRetirement: false },
  custom: { label: 'Another state (enter its rate)', rate: 0.05, deduction: 0, taxesSocialSecurity: false, taxesRetirement: true },
};

export interface TaxInput {
  filing: Filing;
  year: number;
  // People 65 or older this year.
  over65: number;
  // Ordinary income: pre-tax withdrawals, RMDs, Roth conversions, deferred comp, pensions.
  ordinary: number;
  // The part of ordinary income that is retirement money (for states that don't tax it).
  retirement: number;
  socialSecurity: number;
  // Long-term gains realised from the taxable account.
  gains: number;
  state: StateRules;
}
export interface Tax {
  federal: number;
  state: number;
  socialSecurityTaxed: number;
  // Taxable ordinary income after the deduction, which decides the bracket.
  taxableOrdinary: number;
  agi: number;
}

// How much Social Security is taxable at this other income (IRS worksheet).
export function taxableSocialSecurity(filing: Filing, benefits: number, otherIncome: number): number {
  if (benefits <= 0) return 0;
  const [first, second] = FEDERAL[filing].ss;
  const provisional = otherIncome + benefits / 2;
  if (provisional <= first) return 0;
  if (provisional <= second) return Math.min(0.5 * (provisional - first), 0.5 * benefits);
  return Math.min(0.85 * benefits, 0.85 * (provisional - second) + Math.min(0.5 * benefits, 0.5 * (second - first)));
}

export function bracketTax(filing: Filing, taxable: number): number {
  let tax = 0;
  let floor = 0;
  for (const [top, rate] of FEDERAL[filing].brackets) {
    if (taxable <= floor) break;
    tax += (Math.min(taxable, top) - floor) * rate;
    floor = top;
  }
  return tax;
}

// The top of a bracket, as taxable income: where a Roth conversion "fills up to".
export function bracketTop(filing: Filing, rate: number): number {
  return FEDERAL[filing].brackets.find(([, r]) => Math.abs(r - rate) < 1e-9)?.[0] ?? 0;
}

export function deduction(filing: Filing, over65: number, agi: number, year: number): number {
  const t = FEDERAL[filing];
  let senior = 0;
  if (year <= SENIOR_LAST_YEAR && over65 > 0) senior = Math.max(0, t.senior.amount * over65 - 0.06 * Math.max(0, agi - t.senior.phaseOutFrom));
  return t.standard + t.extra65 * over65 + senior;
}

export function incomeTax(input: TaxInput): Tax {
  const t = FEDERAL[input.filing];
  const ssTaxed = taxableSocialSecurity(input.filing, input.socialSecurity, input.ordinary + input.gains);
  const agi = input.ordinary + ssTaxed + input.gains;
  const ded = deduction(input.filing, input.over65, agi, input.year);
  const taxableOrdinary = Math.max(0, input.ordinary + ssTaxed - ded);
  const leftover = Math.max(0, ded - input.ordinary - ssTaxed);
  const gains = Math.max(0, input.gains - leftover);
  let federal = bracketTax(input.filing, taxableOrdinary);
  // Gains sit on top of ordinary income: 0% while the total stays under the first line.
  const at0 = Math.max(0, Math.min(gains, t.gains[0] - taxableOrdinary));
  const at15 = Math.max(0, Math.min(gains - at0, t.gains[1] - Math.max(taxableOrdinary, t.gains[0])));
  federal += at15 * 0.15 + (gains - at0 - at15) * 0.2;
  federal += 0.038 * Math.max(0, Math.min(input.gains, agi - t.niit));

  const s = input.state;
  const people = input.filing === 'mfj' ? 1 : 0.5;
  const stateBase = agi - (s.taxesSocialSecurity ? 0 : ssTaxed) - (s.taxesRetirement ? 0 : input.retirement) - s.deduction * people;
  const state = Math.max(0, stateBase) * s.rate;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { federal: r(federal), state: r(state), socialSecurityTaxed: r(ssTaxed), taxableOrdinary: r(taxableOrdinary), agi: r(agi) };
}

// Required minimum distributions: the IRS Uniform Lifetime Table (from 2022).
const UNIFORM: Record<number, number> = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0,
  86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
  100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9, 109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3,
  113: 3.1, 114: 3.0, 115: 2.9, 116: 2.8, 117: 2.7, 118: 2.5, 119: 2.3, 120: 2.0,
};
// RMDs start at 73 for those born 1951–1959 and 75 for 1960 on (SECURE 2.0).
export const rmdAge = (birthYear: number) => (birthYear >= 1960 ? 75 : birthYear >= 1951 ? 73 : 72);
export function rmd(birthYear: number, age: number, balance: number): number {
  if (age < rmdAge(birthYear) || balance <= 0) return 0;
  return balance / (UNIFORM[Math.min(age, 120)] ?? 2);
}
