// Sorts personal transactions into everyday groups for the personal money dashboard:
// money earned, money spent, and money only moved (to savings, investments, a
// business, or between the owner's own accounts), which is neither. The category the
// owner chose comes first; otherwise the bank's description decides.

export type Flow = 'in' | 'out' | 'move';

export const SPENDING_GROUPS = ['home', 'bills', 'food', 'car', 'shopping', 'health', 'education', 'travel', 'subscriptions', 'people', 'family', 'taxes', 'cash', 'other'] as const;
export const INCOME_GROUPS = ['pay', 'reimbursed', 'refunds', 'people_in', 'family_in', 'side', 'deposits', 'other_in'] as const;
export const MOVE_GROUPS = ['invested', 'from_savings', 'business', 'between'] as const;
export type SpendingGroup = (typeof SPENDING_GROUPS)[number];
export type IncomeGroup = (typeof INCOME_GROUPS)[number];
export type MoveGroup = (typeof MOVE_GROUPS)[number];
export type Group = SpendingGroup | IncomeGroup | MoveGroup;

// Moves first: these are never income or spending, whatever their category.
const MOVES: [RegExp, MoveGroup | ((amount: number) => MoveGroup)][] = [
  [/\b(fid bkg|fidelity|schwab|vanguard|mspbna|morgan stanley|robinhood|e\*?trade|brokerage|moneyline|moneylink|wealthfront|betterment|acorns)\b/i, (amount) => (amount < 0 ? 'invested' : 'from_savings')],
  [/online (banking )?transfer (to|from)|ext trnsfr|citixfr|transfer (to|from) (chk|sav|checking|savings)|real time payment credit/i, 'between'],
];

// Money in.
const INCOME: [RegExp, IncomeGroup][] = [
  [/tax ?ref|taxrfd|treas 310|tax refund/i, 'refunds'],
  [/payroll|direct ?dep|direct-pay|salary|dfas|defense finance/i, 'pay'],
  [/navan|claim|via benefits|reimburs|expense report|corporation payments/i, 'reimbursed'],
  [/refund|return|reversal|credit voucher/i, 'refunds'],
  [/zelle (payment|transfer) from|venmo|cash ?out|paypal/i, 'people_in'],
  [/mobile deposit|online deposit|check deposit|remote online|\bdepo(sit)?\b|atm deposit/i, 'deposits'],
];

// Money out, first match wins.
const SPENDING: [RegExp, SpendingGroup][] = [
  [/tuition|universit|college|school|daycare|child ?care|tutor|kumon|education/i, 'education'],
  [/\birs\b|tax pymt|tax payment|dept revenue|treasury|corporate filings|tax1099|\bfee\b|interest charge|late charge/i, 'taxes'],
  [/zelle|venmo|metapay|cash ?app|wise inc|remitly|western union|paypal \*[a-z]+ [a-z]+$/i, 'people'],
  [/rent\b|managego|mortgage|\bhoa\b|property mgmt|apartments?|home ?depot|lowe'?s|menards|ikea|wayfair|furniture|bed bath/i, 'home'],
  [/con ?ed|duke ?energy|comed|nicor|peoples gas|electric|water (bill|util|dept)|\bgas co|comcast|xfinity|verizon|at&t|t-mobile|spectrum|internet|wireless|utility|utilities/i, 'bills'],
  [/netflix|spotify|hulu|disney|apple\.com|itunes|google|youtube|1password|icloud|prime video|audible|patreon|substack|openai|anthropic|chatgpt|adobe|microsoft/i, 'subscriptions'],
  [/whole ?f|wholefds|trader joe|aldi|jewel|mariano|kroger|safeway|publix|wegmans|h-?mart|patel brothers|grocery|market|bakery|restaurant|cafe|coffee|starbucks|dunkin|doordash|uber ?eats|grubhub|chipotle|pizza|domino|subway|mcdonald|burger|taco|sushi|kitchen|grill|bar & |tst\*|sq \*|toast/i, 'food'],
  [/bmw|toyota|honda|tesla|auto ?(pay|loan)|toll|ilsos|\bdmv\b|shell oil|\bbp\b|exxon|chevron|mobil|marathon|speedway|citgo|fuel|gas station|parking|park mobile|progressive|state farm|geico|allstate|car wash|jiffy|uber|lyft/i, 'car'],
  [/airline|\bair\b|airways|ryanair|allegi?a?n?t|united|delta|southwest|american air|jetblue|frontier|spirit|hotel|marriott|hilton|hyatt|inn\b|expedia|booking\.com|airbnb|vrbo|travel|cruise|amtrak|ticketmaster|museum|cinema|amc /i, 'travel'],
  [/cvs|walgreens|pharmacy|doctor|dental|dentist|clinic|hospital|medical|health|optical|vision|lab corp|quest diag|insurance|new york life|life ins/i, 'health'],
  [/withdr|atm|cash|\bcheck\b|check #/i, 'cash'],
  [/amazon|amzn|target|wal-?mart|costco|sam'?s club|ebay|best buy|apple store|macy|nordstrom|kohl|old navy|gap\b|zara|h&m|nike|tj ?maxx|marshalls|etsy|temu|shein|newegg/i, 'shopping'],
];

// The owner's own categories, mapped to the same groups.
const BY_CATEGORY: Record<string, Group> = {
  Grocery: 'food',
  Meals: 'food',
  'Kitchen & Dining': 'home',
  'Furniture & Decor': 'home',
  'Building & Repair Materials': 'home',
  'Tools & Hardware': 'home',
  'Garden & Outdoor': 'home',
  'Linens & Bedding': 'home',
  Appliances: 'home',
  'Cleaning & Maintenance Services': 'home',
  'Contractor Repairs': 'home',
  'Lawn Care': 'home',
  'Loan & Mortgage Payments': 'home',
  'Mortgage Interest': 'home',
  'Property Tax': 'taxes',
  'Rent & Lease': 'home',
  Utilities: 'bills',
  'Phone & Internet': 'bills',
  Water: 'bills',
  'Trash Collection': 'bills',
  Propane: 'bills',
  'Automotive & Fuel': 'car',
  Travel: 'travel',
  'Health & Medicine': 'health',
  Insurance: 'health',
  'Software & Subscriptions': 'subscriptions',
  'Taxes & Licenses': 'taxes',
  'Bank & Card Fees': 'taxes',
  'Platform & Merchant Fees': 'taxes',
  'Professional Services': 'other',
  'Charitable donations': 'people',
  Clothing: 'shopping',
  'Electronics & Computers': 'shopping',
  'Household Paper & Disposables': 'shopping',
  'Cleaning Supplies': 'shopping',
  'Bath & Personal Care': 'shopping',
  'Pet Supplies': 'shopping',
  'Baby & Kids': 'shopping',
  'Toys & Games': 'shopping',
  'Books & Media': 'shopping',
  'Sports & Fitness': 'shopping',
  'Office Supplies': 'shopping',
  'Rental Income': 'side',
  'Other Income': 'other_in',
  'Owner Contribution': 'business',
  'Owner Withdrawal': 'business',
};

const flowOf = (group: Group): Flow =>
  (SPENDING_GROUPS as readonly string[]).includes(group) ? 'out' : (INCOME_GROUPS as readonly string[]).includes(group) ? 'in' : 'move';

export interface Classified {
  flow: Flow;
  group: Group;
  // Whether the group came from a guess at the description rather than a category.
  guessed: boolean;
}

// Money sent to or from one of the owner's business accounts, named by its last four
// digits in the description ("Online transfer to CHK ...1234").
export function businessPattern(last4s: string[]): RegExp | null {
  const digits = last4s.filter((d) => /^\d{4}$/.test(d));
  return digits.length ? new RegExp(`\\b(chk|checking|acct|account|sav|savings)\\s*\\.{0,3}\\s*(${digits.join('|')})\\b`, 'i') : null;
}

export function classify(tx: { amount: number; description: string; payee?: string | null; category?: string | null }, business: RegExp | null = null): Classified {
  const text = `${tx.description} ${tx.payee ?? ''}`;
  if (business?.test(text)) return { flow: 'move', group: 'business', guessed: true };
  for (const [pattern, group] of MOVES) if (pattern.test(text)) return { flow: 'move', group: typeof group === 'function' ? group(tx.amount) : group, guessed: true };
  const category = tx.category && tx.category !== 'Uncategorized' ? tx.category : null;
  if (category === 'Refunds & Returns' || (tx.amount > 0 && category && flowOf(BY_CATEGORY[category] ?? 'other') === 'out')) {
    // Money back on a purchase: less spending in the group it came from.
    const back = category === 'Refunds & Returns' ? spendingGroup(text) : (BY_CATEGORY[category] as SpendingGroup);
    return tx.amount > 0 ? { flow: 'out', group: back, guessed: category === 'Refunds & Returns' } : { flow: 'out', group: back, guessed: false };
  }
  if (category && BY_CATEGORY[category]) {
    const group = BY_CATEGORY[category];
    const flow = flowOf(group);
    // A category for spending on money in is a refund; one for income on money out is odd, so the description decides.
    if (flow === 'in' && tx.amount > 0) return { flow, group, guessed: false };
    if (flow === 'out' && tx.amount < 0) return { flow, group, guessed: false };
    if (flow === 'move') return { flow, group, guessed: false };
  }
  if (tx.amount > 0) {
    for (const [pattern, group] of INCOME) if (pattern.test(text)) return { flow: 'in', group, guessed: true };
    return { flow: 'in', group: 'other_in', guessed: true };
  }
  return { flow: 'out', group: spendingGroup(text), guessed: true };
}

function spendingGroup(text: string): SpendingGroup {
  for (const [pattern, group] of SPENDING) if (pattern.test(text)) return group;
  return 'other';
}

// A name for the payee that stays the same from month to month, for spotting regular
// payments: "EXAMPLE CORP PAYROLL PPD ID: 21…" and next month's are both "example corp payroll".
export function seriesKey(description: string, payee?: string | null): string {
  // Payments to and from people: who, not the app that sent it.
  const person = description.match(/\b(?:zelle|venmo)\b.*?\b(?:to|from)\s+([a-z]+(?: [a-z]+)?)/i);
  if (person) return `person ${person[1].toLowerCase()}`;
  const base = (payee || description).toLowerCase();
  return base
    .replace(/\b(des|id|indn|ppd|ccd|web|co|entry|descr|conf|ref|confirmation)\b:?.*$/i, '')
    .replace(/[^a-z& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}
