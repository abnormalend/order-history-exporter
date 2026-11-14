// Reads PayPal's monthly statement PDFs.
//
// A statement has two lists. The first, the PayPal account, shows everything,
// including payments PayPal took straight from a card or bank account: those are
// already in that card's or bank's own transactions, so importing them here would
// count them twice. The second, the PayPal Balance account, is only money that went
// into or out of the balance PayPal holds. That is the list read here, and the
// statement's opening and closing balances check that nothing was missed.
import { getDocumentProxy } from 'unpdf';
import type { IncomingTransaction } from './types';

export interface PaypalStatement {
  periodStart: string | null;
  periodEnd: string | null;
  // The PayPal account ID (an email address), only to recognise the account next time.
  accountId: string | null;
  beginning: number | null;
  ending: number | null;
  transactions: IncomingTransaction[];
  // Rows left out: money held in another currency, which isn't in the dollar balance.
  skipped: { posted: string; description: string; reason: string }[];
  // Whether the rows add up to the change in the balance.
  balanced: boolean;
}

export const looksLikePdf = (data: Uint8Array) => data.length > 4 && String.fromCharCode(...data.subarray(0, 5)) === '%PDF-';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const number = (text: string) => Number(text.replace(/,/g, ''));
const AMOUNT = String.raw`-?[\d,]+\.\d{2}`;
const cents = (n: number) => Math.round(n * 100);

// The page's text, line by line, in the order PayPal wrote it.
async function linesOf(data: Uint8Array) {
  const pdf = await getDocumentProxy(data);
  const pages: string[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    const lines: string[] = [];
    let line = '';
    let y: number | null = null;
    const end = () => {
      const text = line.replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
      line = '';
    };
    for (const item of content.items) {
      if (!('str' in item)) continue;
      const top = item.transform[5];
      if (y !== null && Math.abs(top - y) > 2 && item.str.trim()) end();
      line += line && !line.endsWith(' ') && !item.str.startsWith(' ') ? ` ${item.str}` : item.str;
      if (item.str.trim()) y = top;
      if (item.hasEOL) end();
    }
    end();
    pages.push(lines);
  }

  return pages;
}

function isoFrom(text: string) {
  // "Aug 1, 2026"
  const m = text.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  return month ? `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

export async function parsePaypalStatement(data: Uint8Array): Promise<PaypalStatement> {
  let pages: string[][];
  try {
    pages = await linesOf(data);
  } catch {
    throw new Error('This PDF could not be read.');
  }
  const all = pages.flat();
  if (!all.some((l) => /^PAYPAL BALANCE ACCOUNT$/.test(l)) || !all.some((l) => /PayPal Account ID/i.test(l))) {
    throw new Error('This PDF is not a PayPal account statement.');
  }

  // The period, from "Statement Period" (the end date can wrap onto the next line).
  const at = all.findIndex((l) => /Statement Period/i.test(l));
  const near = all.slice(at + 1, at + 4).join(' ');
  const period = near.match(/([A-Za-z]{3} \d{1,2}, \d{4}) - ([A-Za-z]{3} \d{1,2},) ?(\d{4})?/);
  const periodStart = period ? isoFrom(period[1]) : null;
  const periodEnd = period ? isoFrom(`${period[2]} ${period[3] ?? near.match(/\b(\d{4})\b(?!.*\d{4})/)?.[1] ?? ''}`) : null;
  const accountId = near.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] ?? null;

  const transactions: IncomingTransaction[] = [];
  const skipped: PaypalStatement['skipped'] = [];
  let beginning: number | null = null;
  let ending: number | null = null;

  // Only the PayPal Balance part, from its heading on.
  let inBalance = false;
  let inActivity = false;
  let tx: { date: string; lines: string[]; balance: number | null; id: string | null; ref: string | null } | null = null;
  const datePattern = /^(\d{2})\/(\d{2})\/(\d{2,4})(?: (.*))?$/;
  const amountLine = new RegExp(`^([A-Z]{3}) (${AMOUNT}) (${AMOUNT}) (${AMOUNT})$`);

  for (const lines of pages) {
    let header = false; // between a page's top and its activity table
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === 'PAYPAL BALANCE ACCOUNT') {
        inBalance = true;
        continue;
      }
      if (!inBalance) continue;
      const opening = line.match(new RegExp(`^Available beginning (${AMOUNT})`));
      if (opening && beginning === null) beginning = number(opening[1]);
      const closing = line.match(new RegExp(`^Available ending (${AMOUNT})`));
      if (closing && ending === null) ending = number(closing[1]);
      if (/^DATE DESCRIPTION/.test(line)) {
        inActivity = true;
        header = false;
        continue;
      }
      if (!inActivity) continue;
      // A page's footer and the next page's heading, which can fall inside a row.
      if (line === 'ACCOUNT STATEMENTS' || /^Page \d+$/.test(line) || /^Statement Period/.test(line) || /^[º*]/.test(line) || /^In case of errors/.test(line)) {
        header = true;
        continue;
      }
      const date = line.match(datePattern);
      // The table carries on at the next row, or at the rest of a row the page split.
      if (header && (date || (tx && (/^(ID|Ref ID): /.test(line) || /^PayPal Balance /.test(line) || amountLine.test(line))))) header = false;
      if (header) continue;

      if (date && !tx) {
        let year = date[3];
        let rest = date[4] ?? '';
        // A wrapped year: "08/06/202" then "6 Express Checkout…"
        if (year.length < 4) {
          const next = lines[i + 1]?.match(/^(\d{1,2})(?: (.*))?$/);
          if (next && year.length + next[1].length === 4) {
            year += next[1];
            rest = next[2] ?? '';
            i++;
          }
        }
        tx = { date: `${year}-${date[1]}-${date[2]}`, lines: rest ? [rest] : [], balance: null, id: null, ref: null };
        continue;
      }
      if (!tx) continue;
      const money = line.match(amountLine);
      if (money) {
        const [, currency, , , total] = money;
        const description = tx.lines.join(' ').replace(/\s+/g, ' ').trim() || 'PayPal';
        // What it did to the dollar balance: the balance line when there is one (it's in
        // dollars even when the payment was in another currency), otherwise the total.
        const amount = tx.balance ?? (currency === 'USD' ? number(total) : null);
        if (amount === null) skipped.push({ posted: tx.date, description, reason: `Held in ${currency}, not dollars` });
        else
          transactions.push({
            externalId: tx.id ? `paypal:${tx.id}` : null,
            posted: tx.date,
            amount,
            description,
            memo: [currency !== 'USD' ? `${total} ${currency}` : '', tx.ref ? `Ref ${tx.ref}` : ''].filter(Boolean).join(' · ') || null,
            payee: description.includes(':') ? description.slice(description.indexOf(':') + 1).trim() || null : null,
          });
        tx = null;
        continue;
      }
      const balance = line.match(new RegExp(`^PayPal Balance (${AMOUNT})`));
      if (balance) tx.balance = number(balance[1]);
      else if (/^ID: /.test(line)) tx.id = line.slice(4).trim();
      else if (/^Ref ID: /.test(line)) tx.ref = line.slice(8).trim();
      else tx.lines.push(line);
    }
  }

  const change = transactions.reduce((sum, t) => sum + cents(t.amount), 0);
  const balanced = beginning !== null && ending !== null && cents(ending) - cents(beginning) === change;
  return { periodStart, periodEnd, accountId, beginning, ending, transactions, skipped, balanced };
}
