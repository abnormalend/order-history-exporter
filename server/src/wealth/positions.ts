// Positions files from brokerages (what each account holds), the kind of investment
// account a name describes, and the asset class of each holding.
// Fidelity's download lists every account in one file; Schwab's and E*Trade's list one
// account each. Nothing here keeps the file: only the positions read from it are saved.
import { parseAmount, parseCsvText } from '../bank/csv';

export const ASSET_CLASSES = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  bond: 'Bonds',
  target_date: 'Target-date and mixed funds',
  real_estate: 'Real estate',
  cash: 'Cash',
  other: 'Other',
} as const;
export type AssetClass = keyof typeof ASSET_CLASSES;

export interface Position {
  symbol: string | null;
  description: string;
  quantity: number | null;
  price: number | null;
  value: number;
  costBasis: number | null;
  // What the brokerage calls it, when the file says (Schwab's Asset Type).
  hint: string | null;
}
export interface PositionsAccount {
  // How the file names the account, and its number's last four digits when it has one.
  label: string;
  number: string | null;
  last4: string | null;
  positions: Position[];
  total: number;
}
export interface PositionsFile {
  brokerage: 'fidelity' | 'schwab' | 'etrade';
  asOf: string | null;
  accounts: PositionsAccount[];
  // Rows left out on purpose, such as a 401(k) line that only points at its BrokerageLink.
  skipped: string[];
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
const pad = (n: string) => n.padStart(2, '0');
const money = (value: string | undefined) => {
  const text = String(value ?? '').trim();
  return !text || /^-+$/.test(text) || text === 'N/A' ? null : parseAmount(text.replace(/%$/, ''));
};
const round = (n: number) => Math.round(n * 100) / 100;
const lastFour = (number: string | null) => (number ? (number.replace(/\D/g, '').match(/(\d{3,4})$/) || [])[1] ?? null : null);

// Finds the date a file was made, in any of the ways these brokerages write it.
function dateIn(text: string): string | null {
  let m = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/); // Schwab: 2026/11/16
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/\b([A-Z][a-z]{2})[- ](\d{1,2}),?[- ](\d{4})\b/); // Fidelity: Nov-16-2026; E*Trade: Nov 16 2026
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${pad(m[2])}`;
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

const finish = (account: Omit<PositionsAccount, 'total'>): PositionsAccount => ({ ...account, total: round(account.positions.reduce((s, p) => s + p.value, 0)) });

function readFidelity(rows: string[][], text: string): PositionsFile {
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const col = (name: string) => head.indexOf(name);
  const at = { number: col('account number'), name: col('account name'), symbol: col('symbol'), description: col('description'), quantity: col('quantity'), price: col('last price'), value: col('current value'), cost: col('cost basis total'), type: col('type') };
  const accounts = new Map<string, Omit<PositionsAccount, 'total'>>();
  const skipped: string[] = [];
  for (const row of rows.slice(1)) {
    const number = (row[at.number] || '').trim();
    // The notes at the bottom are one long cell each.
    if (!number || row.length < 5) continue;
    const description = (row[at.description] || '').trim();
    const symbol = (row[at.symbol] || '').trim().replace(/\*+$/, '') || null;
    const value = money(row[at.value]);
    // A plan's line for its BrokerageLink only points at the BrokerageLink account,
    // which the file lists on its own; counting both would count the money twice.
    if (!symbol && /^brokeragelink$/i.test(description)) {
      skipped.push(`${(row[at.name] || number).trim()}: its BrokerageLink line (the BrokerageLink account is listed on its own)`);
      continue;
    }
    if (/^pending activity$/i.test(symbol || description) && !value) continue;
    if (!accounts.has(number)) accounts.set(number, { label: (row[at.name] || number).trim(), number, last4: lastFour(number), positions: [] });
    accounts.get(number)!.positions.push({
      symbol,
      description: description || symbol || 'Holding',
      quantity: money(row[at.quantity]),
      price: money(row[at.price]),
      value: value ?? 0,
      costBasis: money(row[at.cost]),
      hint: /held in money market/i.test(description) || /^pending activity$/i.test(symbol || '') ? 'Cash' : null,
    });
  }
  return { brokerage: 'fidelity', asOf: dateIn(text.slice(-400)), accounts: [...accounts.values()].map(finish), skipped };
}

// Schwab: a "Positions for account <name> as of …" line, then the table, for each account.
function readSchwab(rows: string[][]): PositionsFile {
  const accounts: PositionsAccount[] = [];
  let asOf: string | null = null;
  let current: Omit<PositionsAccount, 'total'> | null = null;
  let head: string[] | null = null;
  const done = () => {
    if (current) accounts.push(finish(current));
    current = null;
    head = null;
  };
  for (const row of rows) {
    const first = (row[0] || '').trim();
    const title = first.match(/^Positions for (?:account )?(.+?) as of (.+)$/i);
    if (title) {
      done();
      asOf = asOf ?? dateIn(title[2]);
      current = { label: title[1].trim(), number: title[1].trim(), last4: lastFour(title[1]), positions: [] };
      continue;
    }
    if (!current) continue;
    if (/^symbol$/i.test(first)) {
      head = row.map((c) => c.trim().toLowerCase());
      continue;
    }
    if (!head || !first) continue;
    if (/total$/i.test(first)) continue;
    const pick = (start: string) => row[head!.findIndex((h) => h.startsWith(start))];
    const cash = /^cash & cash investments$/i.test(first);
    current.positions.push({
      symbol: cash ? null : first,
      description: cash ? 'Cash and money market' : (pick('description') || first).trim(),
      quantity: money(pick('qty')),
      price: money(pick('price (')) ?? money(pick('price')),
      value: money(pick('mkt val')) ?? 0,
      costBasis: money(pick('cost basis')),
      hint: (pick('asset type') || '').trim() || (cash ? 'Cash' : null),
    });
  }
  done();
  return { brokerage: 'schwab', asOf, accounts, skipped: [] };
}

// E*Trade: an account summary naming the account, then a positions table, for each.
function readEtrade(rows: string[][], text: string): PositionsFile {
  const accounts: PositionsAccount[] = [];
  let current: Omit<PositionsAccount, 'total'> | null = null;
  let head: string[] | null = null;
  let summaryNext = false;
  const done = () => {
    if (current) accounts.push(finish(current));
    current = null;
    head = null;
  };
  for (const row of rows) {
    const first = (row[0] || '').trim();
    if (/^account$/i.test(first)) {
      summaryNext = true;
      continue;
    }
    if (summaryNext) {
      summaryNext = false;
      if (first) {
        done();
        const number = (first.match(/-?\s*(\d{3,})\s*$/) || [])[1] ?? null;
        current = { label: first.replace(/\s*-\s*\d{3,}\s*$/, '').trim() || first, number, last4: lastFour(number), positions: [] };
      }
      continue;
    }
    if (!current) continue;
    if (/^symbol$/i.test(first) && row.some((c) => /value/i.test(c))) {
      head = row.map((c) => c.trim().toLowerCase());
      continue;
    }
    if (!head || !first || /^total$/i.test(first)) continue;
    const pick = (start: string) => row[head!.findIndex((h) => h.startsWith(start))];
    const cash = /^cash$/i.test(first);
    // The footer ("Generated at …") and anything else without a value isn't a holding.
    if (!cash && money(pick('value')) === null) continue;
    const quantity = money(pick('qty'));
    const paid = money(pick('price paid'));
    current.positions.push({
      symbol: cash ? null : first,
      description: cash ? 'Cash' : first,
      quantity: cash ? null : quantity,
      price: cash ? null : money(pick('last price')),
      // The cash line puts its amount one column late, so it's the last number on the row.
      value: cash ? money([...row].reverse().find((c) => money(c) !== null)) ?? 0 : money(pick('value')) ?? 0,
      costBasis: cash || quantity === null || paid === null ? null : round(quantity * paid),
      hint: cash ? 'Cash' : null,
    });
  }
  done();
  return { brokerage: 'etrade', asOf: dateIn(text.slice(-200)), accounts, skipped: [] };
}

// Reads a positions file, or says it isn't one this knows.
export function readPositions(text: string): PositionsFile {
  const clean = text.replace(/^﻿/, '');
  const rows = parseCsvText(clean);
  const first = (rows[0] || []).map((c) => c.trim().toLowerCase());
  if (first.includes('account number') && first.includes('symbol') && first.includes('current value')) return readFidelity(rows, clean);
  if (/^positions for /i.test(rows[0]?.[0] || '') || rows.some((r) => /^positions for (account )?.+ as of /i.test(r[0] || ''))) return readSchwab(rows);
  if (/^account summary$/i.test((rows[0]?.[0] || '').trim()) || rows.some((r) => /^view summary/i.test(r[0] || ''))) return readEtrade(rows, clean);
  throw new Error("That doesn't look like a positions download from Fidelity, Schwab or E*Trade.");
}

// A fund holds many companies, so it isn't one company's risk however big it is.
export const isFund = (symbol: string | null, description: string) =>
  /\bFUND\b|\bFD\b|\bETF\b|\bINDEX\b|\bIDX\b|PORTFOLIO|ISHARES|VANGUARD|\bSPDR\b|\bTR\b|\bTRUST\b/.test(`${symbol ?? ''} ${description}`.toUpperCase());

// The asset class of a holding, from its name and what the brokerage calls it.
export function guessClass(symbol: string | null, description: string, hint: string | null = null): AssetClass {
  const text = `${symbol ?? ''} ${description}`.toUpperCase();
  if (/^cash/i.test(hint || '') || /MONEY MARKET|\bCASH\b|SWEEP|\bCORE POSITION|^(SPAXX|FDRXX|FCASH|SWVXX|SNVXX|VMFXX)\b/.test(text)) return 'cash';
  if (/TARGET ?RET|TARGET ?DATE|FREEDOM (INDEX )?20\d0|LIFEPATH|TARGET 20\d0|\bBALANCED\b|AGGRESSIVE|MODERATE|CONSERVATIVE|ASSET ALLOC|LIFE ?CYCLE|\bBLEND/.test(text)) return 'target_date';
  if (/fixed income|bond/i.test(hint || '') || /TREAS|T-BILL|\bBILLS?\b|\bNOTES?\b|\bNTS\b|BOND|\bMUNI|\bCD\b|CERT(IFICATE)? OF DEP|FIXED INC|AGGREGATE|\bTIPS\b|INCOME FUND/.test(text)) return 'bond';
  if (/\bREIT\b|REAL ESTATE/.test(text)) return 'real_estate';
  // Company names say International or World too (International Business Machines), so
  // only a fund counts as international from its name; a foreign company by its ADR.
  const fund = isFund(symbol, description);
  if ((fund && /INT'?L|INTERNATIONAL|EMERGING|\bEAFE\b|EX[- ]?U\.?S|DEVELOPED|\bGLOBAL\b|\bWORLD\b|\bEUROPE|\bPACIFIC\b/.test(text)) || /\bADR\b|\bADS\b/.test(text)) return 'intl_stock';
  return 'us_stock';
}

// What kind of investment account a name (and where it's held) describes, for accounts
// a feed creates. Null when it reads like a plain bank account.
const BROKERAGES = /fidelity|schwab|e\*?trade|vanguard|morgan stanley|merrill|ameritrade|robinhood|interactive brokers|wealthfront|betterment|edward jones|ameriprise|t\.? ?rowe|empower|principal|tiaa|computershare|equiniti|shareworks|at work|stock ?plan/i;
export function guessInvestType(name: string, institution: string | null = null): string | null {
  const n = name.toLowerCase();
  if (/\broth\b/.test(n)) return /\b401|\b403|\b457|brokeragelink|\bplan\b/.test(n) ? 'roth_401k' : 'roth_ira';
  if (/brokeragelink/.test(n)) return '401k';
  if (/excess (savings|401)|deferred comp|non-?qualified|supplemental (savings|retirement|401)/.test(n)) return 'deferred_comp';
  if (/\b401\s?\(?k\)?/.test(n)) return '401k';
  if (/\b403\s?\(?b\)?/.test(n)) return '403b';
  if (/\b457/.test(n)) return '457b';
  if (/pension|cash balance plan|\brba\b/.test(n)) return 'pension';
  if (/rollover/.test(n)) return 'rollover_ira';
  if (/\bsep\b/.test(n)) return 'sep_ira';
  if (/\bira\b/.test(n)) return 'ira';
  if (/health savings|\bhsa\b/.test(n)) return 'hsa';
  if (/\b529\b|college sav/.test(n)) return '529';
  if (/annuity/.test(n)) return 'annuity';
  if (/stock plan|share units|\brsus?\b|equity awards?|\bespp\b|stock purchase|long share|\boptions?\b/.test(n) || /at work|stock ?plan|equity ?award|shareworks|computershare|equiniti/i.test(institution || '')) return 'espp';
  if (/brokerage|individual|\bjoint\b|jtwros|\btod\b|investment|\btrust\b|corporation|custodial|\bugma\b|\butma\b/.test(n) && !/checking|saving|money market/.test(n)) return 'brokerage';
  if (BROKERAGES.test(institution || '') && !/checking|saving|money market|cash management|spending|card|visa|loan/.test(n)) return 'brokerage';
  return null;
}

// Whose an account is, when the name says.
export const guessHolder = (name: string): 'joint' | null => (/\bjoint\b|jtwros|\bjt ten\b/i.test(name) ? 'joint' : null);
