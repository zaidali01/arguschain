import React from "react";
import { BITS, TIERS, ROLES, REFUSALS, refusalFor, toMask, maskHex } from "../lib/permissions";
import { ApiError } from "../lib/session";

export function Tier({ level }: { level: number }) {
  return <span className={`chip chip-t${level + 1}`}>{TIERS[level] ?? "UNKNOWN"}</span>;
}

export function RoleChips({ roles }: { roles: number[] }) {
  if (!roles.length) return <span className="chip">No role</span>;
  return <>{roles.map((r) => <span key={r} className="chip chip-role">{ROLES[r] ?? `Role ${r}`}</span>)}</>;
}

/** Compact 8-slot readout used in dense table rows. */
export function BitStrip({ mask }: { mask: string | number }) {
  const m = toMask(mask);
  return (
    <span className="bit-inline" title={maskHex(m)}>
      {BITS.map((b) => (
        <span key={b.key} className={m & b.bit ? "on" : ""}>{b.key}</span>
      ))}
    </span>
  );
}

/** Full grid. `stripped` marks bits a grant gave but a later rule removed. */
export function BitGrid({ mask, stripped = 0 }: { mask: string | number; stripped?: number }) {
  const m = toMask(mask);
  return (
    <div className="bits">
      {BITS.map((b, i) => {
        const on = (m & b.bit) !== 0;
        const cut = !on && (stripped & b.bit) !== 0;
        return (
          <div key={b.key} className={`bit ${on ? "bit-on" : cut ? "bit-stripped" : ""}`}>
            <div className="tiny mono muted">Bit {i}</div>
            <div className="bit-name">{b.name}</div>
            <div className="bit-label">{b.desc}</div>
            <div className="tiny mono" style={{ marginTop: 6, fontWeight: 700 }}>
              {on ? "Granted" : cut ? "Stripped by rule" : "Not granted"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Refusal({ error }: { error: ApiError }) {
  const r = refusalFor(error.code, error.status);
  const isFault = !REFUSALS[error.code] && (error.status >= 500 || !error.code);
  return (
    <div className="panel panel-alert stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>{r.title}</h3>
        <span className="chip mono">{error.code}</span>
      </div>
      <p>{error.detail || r.body}</p>
      {isFault && <p className="tiny muted">This was a server or connection fault, not a decision about your access.</p>}
      {r.action && <p className="mono tiny"><b>What to do:</b> {r.action}</p>}
      {error.risk && (
        <div className="panel panel-flat">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4>Why this was flagged</h4>
            <span className="chip chip-warn mono">Risk {error.risk.score}/100</span>
          </div>
          <ul style={{ margin: "10px 0 0", paddingLeft: 20 }}>
            {error.risk.reasons?.map((x: string, i: number) => <li key={i}>{x}</li>)}
          </ul>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            This score only advises. It cannot grant or revoke access on its own.
          </p>
        </div>
      )}
    </div>
  );
}

export function Loading({ what = "Loading" }: { what?: string }) {
  return <div className="state mono">{what}…</div>;
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="state stack">
      <h3>{title}</h3>
      <p className="muted" style={{ marginInline: "auto" }}>{body}</p>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (error instanceof ApiError) return <Refusal error={error} />;
  return (
    <div className="panel panel-alert">
      <h3>Something went wrong</h3>
      <p className="mono tiny">{String((error as any)?.message ?? error)}</p>
    </div>
  );
}

/** Small hook so every screen handles load / refuse / show the same way. */
export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [tick, setTick] = React.useState(0);

  React.useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
