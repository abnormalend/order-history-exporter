// Income per unit, month by month: one chart with each month's units side by side, each
// in its unit's own colour, so what each earns can be compared at a glance.
import { useEffect, useRef, useState } from 'react';
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
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  return { top: Math.ceil(max / step) * step, step };
};

export function UnitIncomeCard() {
  const { business } = useBusiness();
  const data = useApi<{ months: string[]; units: Unit[] }>(`/api/pl/units?x=1${businessQuery(business)}`);
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const units = data.data?.units ?? [];
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(300, Math.floor(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, [units.length > 0]);
  if (!units.length) return null;

  const colours = unitColours(units.map((u) => u.name));
  const months = units[0].months.map((m) => m.month);
  const { top, step } = niceTop(Math.max(...units.flatMap((u) => u.months.map((m) => m.total))));
  // Rent is drawn lighter on top of stays only for a unit that has both.
  const both = units.map((u) => u.months.some((m) => m.stays) && u.months.some((m) => m.rent));
  const height = 300;
  const pad = { left: 62, right: 8, top: 12, bottom: 28 };
  const plot = height - pad.top - pad.bottom;
  const y = (v: number) => pad.top + plot * (1 - Math.max(0, v) / top);
  const slot = (width - pad.left - pad.right) / months.length;
  const group = slot * 0.82;
  const bar = group / units.length;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  const labelEvery = Math.ceil(58 / slot);
  const shown = active === null ? null : active;

  return (
    <Card title="Income per unit by month" className="mt-5">
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2">
        {units.map((u, i) => (
          <div key={u.key} className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <span className="size-2.5 rounded-sm" style={{ background: colours[i] }} aria-hidden />
              {u.name}
            </div>
            <div className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
              {wholeMoney(u.total)} a year · {wholeMoney(u.average)}/mo
            </div>
          </div>
        ))}
      </div>
      <div ref={holder} className="relative min-w-0">
        <svg width={width} height={height} role="img" aria-label="Income per unit by month" className="block">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} className={v === 0 ? 'stroke-slate-400 dark:stroke-slate-600' : 'stroke-slate-200 dark:stroke-slate-800'} />
              <text x={pad.left - 8} y={y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums dark:fill-slate-400">
                {wholeMoney(v)}
              </text>
            </g>
          ))}
          {months.map((month, mi) => {
            const left = pad.left + slot * mi + (slot - group) / 2;
            return (
              <g
                key={month}
                tabIndex={0}
                aria-label={`${monthLabel(month)}: ${units.map((u) => `${u.name} ${money(u.months[mi].total)}`).join(', ')}`}
                className="outline-none"
                onMouseEnter={() => setActive(mi)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(mi)}
                onBlur={() => setActive(null)}
                opacity={active === null || active === mi ? 1 : 0.5}
              >
                <rect x={pad.left + slot * mi} y={pad.top} width={slot} height={plot} fill="transparent" />
                {units.map((u, ui) => {
                  const m = u.months[mi];
                  const x = left + bar * ui;
                  const w = Math.max(1, bar - (bar > 4 ? 1 : 0));
                  return (
                    <g key={u.key}>
                      {m.stays > 0 && <rect x={x} y={y(m.stays)} width={w} height={y(0) - y(m.stays)} fill={colours[ui]} />}
                      {m.rent > 0 && <rect x={x} y={y(m.stays + m.rent)} width={w} height={y(m.stays) - y(m.stays + m.rent)} fill={colours[ui]} fillOpacity={both[ui] ? 0.45 : 1} />}
                    </g>
                  );
                })}
                {mi % labelEvery === 0 && (
                  <text x={pad.left + slot * mi + slot / 2} y={height - 8} textAnchor="middle" className="fill-slate-500 text-[11px] dark:fill-slate-400">
                    {monthLabel(month, true)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {shown !== null && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-56 rounded-md border border-slate-200 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900"
            style={{ left: Math.min(Math.max(pad.left + slot * shown + slot / 2 - 112, 0), width - 224) }}
          >
            <div className="mb-1 font-semibold">{monthLabel(months[shown])}</div>
            {units
              .map((u, i) => ({ u, i, m: u.months[shown] }))
              .sort((a, b) => b.m.total - a.m.total)
              .map(({ u, i, m }) => (
                <div key={u.key} className="flex justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: colours[i] }} aria-hidden /> {u.name}
                  </span>
                  <span className="tabular-nums">{money(m.total)}</span>
                </div>
              ))}
            <div className="mt-1 flex justify-between gap-2 border-t border-slate-100 pt-1 font-medium dark:border-slate-800">
              <span>All units</span>
              <span className="tabular-nums">{money(units.reduce((t, u) => t + u.months[shown].total, 0))}</span>
            </div>
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
        Each stay&apos;s payout is spread over the nights it covers; mid-term rent counts in the month it was received{both.some(Boolean) ? ' (shown lighter where a unit has both)' : ''}. The yearly total
        and monthly average are for the last 12 whole months.
      </p>
    </Card>
  );
}
