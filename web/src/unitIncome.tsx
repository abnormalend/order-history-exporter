// Income per unit, month by month: one small chart for each unit, all on the same
// scale so they can be compared, each in its unit's own colour.
import { useState } from 'react';
import { useApi } from './api';
import { businessQuery, useBusiness } from './business';
import { money, monthLabel, wholeMoney } from './format';
import { Card } from './ui';

interface UnitMonth {
  month: string;
  stays: number;
  rent: number;
  total: number;
}
interface Unit {
  key: string;
  name: string;
  months: UnitMonth[];
  total: number;
  average: number;
}

// A unit named for a colour is drawn in it; the others take one from this list.
const NAMED: [RegExp, string][] = [
  [/green/i, '#16a34a'],
  [/blue/i, '#2563eb'],
  [/red/i, '#dc2626'],
  [/orange/i, '#ea580c'],
  [/yellow/i, '#ca8a04'],
  [/purple|violet/i, '#9333ea'],
  [/pink/i, '#db2777'],
  [/brown/i, '#92400e'],
];
const OTHERS = ['#475569', '#0d9488', '#7c3aed', '#be185d', '#65a30d', '#0369a1', '#b45309', '#4338ca'];

export function unitColours(names: string[]) {
  let next = 0;
  return names.map((name) => NAMED.find(([pattern]) => pattern.test(name))?.[1] ?? OTHERS[next++ % OTHERS.length]);
}

const niceTop = (max: number) => {
  if (max <= 0) return { top: 1000, step: 250 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
};

export function UnitIncomeCard() {
  const { business } = useBusiness();
  const data = useApi<{ months: string[]; units: Unit[] }>(`/api/pl/units?x=1${businessQuery(business)}`);
  const [own, setOwn] = useState(false);
  if (!data.data?.units.length) return null;
  const units = data.data.units;
  const colours = unitColours(units.map((u) => u.name));
  const shared = niceTop(Math.max(...units.flatMap((u) => u.months.map((m) => m.total))));
  const mixed = units.some((u) => u.months.some((m) => m.rent) && u.months.some((m) => m.stays));
  const toggle = (value: boolean, label: string) => (
    <button
      type="button"
      onClick={() => setOwn(value)}
      aria-pressed={own === value}
      className={`rounded px-2 py-1 ${own === value ? 'bg-white font-medium shadow-sm dark:bg-slate-700' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}
    >
      {label}
    </button>
  );
  return (
    <Card
      title="Income per unit by month"
      className="mt-5"
      actions={
        <div className="flex rounded-md bg-slate-100 p-0.5 text-xs dark:bg-slate-800">
          {toggle(false, 'Same scale')}
          {toggle(true, 'Own scale')}
        </div>
      }
    >
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
        {units.map((u, i) => {
          const { top, step } = own ? niceTop(Math.max(...u.months.map((m) => m.total))) : shared;
          return <UnitChart key={u.key} unit={u} colour={colours[i]} top={top} step={step} />;
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Each stay&apos;s payout is spread over the nights it covers; mid-term rent counts in the month it was received{mixed ? ' (shown lighter where a unit has both)' : ''}.{' '}
        {own ? 'Each chart on its own scale, to show its ups and downs.' : 'All on the same scale, to compare units.'} The total and average are for the last 12 whole months.
      </p>
    </Card>
  );
}

function UnitChart({ unit, colour, top, step }: { unit: Unit; colour: string; top: number; step: number }) {
  const [active, setActive] = useState<number | null>(null);
  const W = 320;
  const H = 150;
  const pad = { left: 44, right: 4, top: 8, bottom: 20 };
  const plot = H - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plot * (1 - Math.max(0, v) / top);
  const slot = (W - pad.left - pad.right) / unit.months.length;
  const bar = Math.min(18, slot * 0.68);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const shown = active === null ? null : unit.months[active];
  const both = unit.months.some((m) => m.stays) && unit.months.some((m) => m.rent);
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <span className="size-2.5 rounded-sm" style={{ background: colour }} aria-hidden />
          {unit.name}
        </h3>
        <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
          {shown
            ? `${monthLabel(shown.month, true)}: ${money(shown.total)}${shown.rent && shown.stays ? ` (${wholeMoney(shown.stays)} stays, ${wholeMoney(shown.rent)} rent)` : ''}`
            : `${wholeMoney(unit.total)} a year · ${wholeMoney(unit.average)}/mo`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${unit.name}: income by month`}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={W - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-slate-400 dark:stroke-slate-600' : 'stroke-slate-200 dark:stroke-slate-800'} />
            <text x={pad.left - 6} y={y(v) + 3.5} textAnchor="end" className="fill-slate-500 text-[10px] tabular-nums dark:fill-slate-400">
              {v >= 1000 ? `$${Math.round(v / 100) / 10}K` : `$${v}`}
            </text>
          </g>
        ))}
        {unit.months.map((m, i) => {
          const x = pad.left + slot * i + (slot - bar) / 2;
          return (
            <g key={m.month} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)} opacity={active === null || active === i ? 1 : 0.55}>
              <title>{`${monthLabel(m.month)}: ${money(m.total)}`}</title>
              <rect x={pad.left + slot * i} y={pad.top} width={slot} height={plot} fill="transparent" />
              {m.stays > 0 && <rect x={x} y={y(m.stays)} width={bar} height={y(0) - y(m.stays)} fill={colour} />}
              {m.rent > 0 && <rect x={x} y={y(m.stays + m.rent)} width={bar} height={y(m.stays) - y(m.stays + m.rent)} fill={colour} fillOpacity={both ? 0.45 : 1} />}
              {(i % 3 === 0 || i === unit.months.length - 1) && (
                <text x={pad.left + slot * i + slot / 2} y={H - 6} textAnchor="middle" className="fill-slate-500 text-[10px] dark:fill-slate-400">
                  {monthLabel(m.month, true)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
