// Settings: family members with their own accounts and budgets in My money, and
// logins for them that see only their own money.
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, Plus, ShieldCheck, Trash2, UserRound, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { post, useApi } from './api';
import { BankBadge } from './banks';
import { Banner, Button, Card, Confirm, Field, Input } from './ui';

interface FamilyAccount {
  id: number;
  name: string;
  institution: string | null;
  owner: string;
  personId: number | null;
}
interface FamilyPerson {
  id: number;
  name: string;
  accounts: number[];
  login: { id: number; username: string; totpEnabled: boolean } | null;
}
interface FamilyData {
  people: FamilyPerson[];
  accounts: FamilyAccount[];
}

export function FamilyCard() {
  const { data, error, reload } = useApi<FamilyData>('/api/people');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // Arriving from My money's "Manage" link: bring this card into view.
  const loaded = Boolean(data);
  useEffect(() => {
    if (loaded && window.location.hash === '#family') document.getElementById('family')?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem('');
    try {
      await action();
      reload();
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (await run(() => post('/api/people', { name: name.trim() }))) setName('');
  }

  return (
    <Card
      title={
        <span id="family" className="inline-flex items-center gap-2">
          <Users className="size-4" aria-hidden />
          Family and logins
        </span>
      }
      className="lg:col-span-2"
    >
      <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
        Add family members to give them their own accounts and budgets in <Link to="/personal" className="underline">My money</Link>. Their accounts then leave yours. A login for them
        sees only their own money, read-only: no businesses, transactions or settings.
      </p>
      {(error || problem) && <Banner>{problem || error?.message}</Banner>}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.people.map((p) => <PersonCard key={p.id} person={p} accounts={data.accounts} busy={busy} run={run} />)}
      </div>
      <Admins />
      <h3 className="mt-6 mb-2 text-sm font-semibold">Family members</h3>
      <form onSubmit={add} className="mt-4 flex max-w-md items-end gap-2">
        <Field label="Add someone">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" maxLength={60} />
        </Field>
        <Button type="submit" busy={busy} disabled={!name.trim()}>
          <Plus className="size-4" aria-hidden />
          Add
        </Button>
      </form>
    </Card>
  );
}

interface Admin {
  id: number;
  username: string;
  totpEnabled: boolean;
}

// Admins see and change everything, the same as you. Each signs in with their own
// username, so the activity log says who did what.
function Admins() {
  const { data, error, reload } = useApi<{ admins: Admin[]; selfId: number }>('/api/admins');
  const [form, setForm] = useState<null | { mode: 'add' } | { mode: 'reset'; admin: Admin }>(null);
  const [fields, setFields] = useState({ username: '', password: '' });
  const [removing, setRemoving] = useState<Admin | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem('');
    try {
      await action();
      reload();
      return true;
    } catch (e) {
      setProblem((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    const ok =
      form.mode === 'add'
        ? await run(() => post('/api/admins', { username: fields.username.trim(), password: fields.password }))
        : await run(() => post(`/api/admins/${form.admin.id}/password`, { password: fields.password }));
    if (ok) {
      setForm(null);
      setFields({ username: '', password: '' });
    }
  }

  return (
    <section aria-label="Admins" className="mb-2 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-800 dark:bg-emerald-900/60 dark:text-emerald-200">
          <ShieldCheck className="size-4" aria-hidden />
        </span>
        <h3 className="flex-1 font-semibold">Admins</h3>
        {form?.mode !== 'add' && (
          <Button onClick={() => setForm({ mode: 'add' })}>
            <Plus className="size-4" aria-hidden />
            Add an admin
          </Button>
        )}
      </div>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Full access, the same as yours: every business, account, setting and family member. For your spouse, say.</p>
      {(error || problem) && <Banner>{problem || error?.message}</Banner>}
      <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
        {data?.admins.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <KeyRound className="size-4 text-slate-500" aria-hidden />
            <span className="font-medium">{a.username}</span>
            {a.id === data.selfId && <span className="text-xs text-slate-500">you</span>}
            {a.totpEnabled && <span className="text-xs text-slate-500">two-factor on</span>}
            <span className="flex-1" />
            {a.id !== data.selfId && (
              <>
                <Button onClick={() => setForm({ mode: 'reset', admin: a })}>Reset password</Button>
                <Button variant="danger" onClick={() => setRemoving(a)}>
                  Remove
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {form && (
        <form onSubmit={save} className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:bg-slate-800/60">
          {form.mode === 'add' ? (
            <Field label="Username">
              <Input autoFocus value={fields.username} onChange={(e) => setFields({ ...fields, username: e.target.value })} autoComplete="off" maxLength={60} />
            </Field>
          ) : (
            <p className="self-center text-sm">
              New password for <strong>{form.admin.username}</strong>
            </p>
          )}
          <Field label={form.mode === 'add' ? 'Password (10 or more characters)' : 'New password'}>
            <Input type="password" value={fields.password} onChange={(e) => setFields({ ...fields, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" busy={busy} disabled={fields.password.length < 10 || (form.mode === 'add' && !fields.username.trim())}>
              {form.mode === 'add' ? 'Create' : 'Reset'}
            </Button>
            <Button type="button" onClick={() => setForm(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-3">
            {form.mode === 'add'
              ? 'Give them the password yourself. They should change it and turn on two-factor from their own Settings.'
              : 'Signs them out everywhere and turns off their two-factor, in case a phone was lost.'}
          </p>
        </form>
      )}
      <Confirm
        open={Boolean(removing)}
        title={`Remove ${removing?.username}?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await run(() => post(`/api/admins/${removing.id}/delete`));
          setRemoving(null);
        }}
      >
        They're signed out and can't sign in again. Nothing they changed is undone.
      </Confirm>
    </section>
  );
}

function PersonCard({ person, accounts, busy, run }: { person: FamilyPerson; accounts: FamilyAccount[]; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean> }) {
  const [removing, setRemoving] = useState(false);
  const [loginForm, setLoginForm] = useState<null | 'add' | 'reset'>(null);
  const [form, setForm] = useState({ username: '', password: '' });
  const [revoking, setRevoking] = useState(false);
  // Accounts that are theirs or nobody else's.
  const choices = accounts.filter((a) => a.personId === null || a.personId === person.id);
  const toggle = (id: number) => {
    const next = person.accounts.includes(id) ? person.accounts.filter((a) => a !== id) : [...person.accounts, id];
    run(() => post(`/api/people/${person.id}`, { accounts: next }));
  };

  async function saveLogin(event: FormEvent) {
    event.preventDefault();
    const ok =
      loginForm === 'add'
        ? await run(() => post(`/api/people/${person.id}/login`, { username: form.username.trim(), password: form.password }))
        : await run(() => post(`/api/people/${person.id}/login/password`, { password: form.password }));
    if (ok) {
      setLoginForm(null);
      setForm({ username: '', password: '' });
    }
  }

  return (
    <section aria-label={person.name} className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
      <div className="flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-teal-100 text-teal-800 dark:bg-teal-900/60 dark:text-teal-200">
          <UserRound className="size-4" aria-hidden />
        </span>
        <h3 className="flex-1 font-semibold">{person.name}</h3>
        <Link to={`/personal?person=${person.id}`} className="text-sm text-emerald-700 hover:underline dark:text-emerald-400">
          See their money
        </Link>
        <button type="button" onClick={() => setRemoving(true)} className="rounded p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label={`Remove ${person.name}`}>
          <Trash2 className="size-4" aria-hidden />
        </button>
      </div>

      <h4 className="mt-4 mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">Their accounts</h4>
      {!choices.length ? (
        <p className="text-sm text-slate-500">No personal accounts are free. Each account belongs to one person.</p>
      ) : (
        <ul className="space-y-1">
          {choices.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <input type="checkbox" checked={person.accounts.includes(a.id)} disabled={busy} onChange={() => toggle(a.id)} className="size-4 accent-teal-600" />
                <BankBadge institution={a.institution} accountName={a.name} className="!size-5 !text-[8px]" />
                <span className="truncate">{a.name}</span>
                {a.owner === 'mixed' && <span className="text-xs text-slate-500">shared</span>}
              </label>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-4 mb-1.5 text-xs font-medium tracking-wide text-slate-500 uppercase">Login</h4>
      {person.login ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <KeyRound className="size-4 text-slate-500" aria-hidden />
          <span className="font-medium">{person.login.username}</span>
          {person.login.totpEnabled && <span className="text-xs text-slate-500">two-factor on</span>}
          <span className="flex-1" />
          <Button onClick={() => setLoginForm(loginForm === 'reset' ? null : 'reset')}>Reset password</Button>
          <Button variant="danger" onClick={() => setRevoking(true)}>
            Remove login
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          No login.
          {loginForm !== 'add' && <Button onClick={() => setLoginForm('add')}>Give {person.name} a login</Button>}
        </div>
      )}
      {loginForm && (
        <form onSubmit={saveLogin} className="mt-3 grid gap-2 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end dark:bg-slate-800/60">
          {loginForm === 'add' && (
            <Field label="Username">
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" maxLength={60} />
            </Field>
          )}
          <Field label={loginForm === 'add' ? 'Password (10 or more characters)' : 'New password'}>
            <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" busy={busy} disabled={form.password.length < 10 || (loginForm === 'add' && !form.username.trim())}>
              {loginForm === 'add' ? 'Create' : 'Reset'}
            </Button>
            <Button type="button" onClick={() => setLoginForm(null)}>
              Cancel
            </Button>
          </div>
          <p className="text-xs text-slate-500 sm:col-span-3">
            {loginForm === 'add'
              ? 'Give them the password yourself. They can change it, and turn on two-factor, from their own Settings.'
              : 'Signs them out everywhere and turns off their two-factor, in case a phone was lost.'}
          </p>
        </form>
      )}

      <Confirm
        open={removing}
        title={`Remove ${person.name}?`}
        confirmLabel="Remove"
        busy={busy}
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          await run(() => post(`/api/people/${person.id}/delete`));
          setRemoving(false);
        }}
      >
        Their accounts come back to you, and their budgets{person.login ? ' and login' : ''} are removed. No transactions are changed.
      </Confirm>
      <Confirm
        open={revoking}
        title={`Remove ${person.name}'s login?`}
        confirmLabel="Remove login"
        busy={busy}
        onCancel={() => setRevoking(false)}
        onConfirm={async () => {
          await run(() => post(`/api/people/${person.id}/login/delete`));
          setRevoking(false);
        }}
      >
        They're signed out and can't sign in again until you give them a new login.
      </Confirm>
    </section>
  );
}
