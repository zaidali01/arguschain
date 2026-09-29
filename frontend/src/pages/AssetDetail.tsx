import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, apiRaw, ApiError, useSession, API } from "../lib/session";
import { BITS, P, TIERS, approvalPolicy, toMask, maskHex, has } from "../lib/permissions";
import { Tier, BitGrid, BitStrip, Loading, ErrorBox, Empty, Refusal, useAsync } from "../components/ui";
import { ethers, Contract, BrowserProvider } from "ethers";

type Tab = "overview" | "trace" | "access" | "audit";

/* ------------------------------------------------------------------ viewer */

function ContentViewer({ tokenId }: { tokenId: string }) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "error"; error: ApiError }
    | { kind: "ok"; text: string; hash: string | null; risk: string | null; url: string; mime: string }
  >({ kind: "idle" });

  async function open(stepUp: boolean, download = false) {
    setState({ kind: "loading" });
    try {
      const res = await apiRaw(`/assets/${tokenId}/content${download ? "?download=1" : ""}`, stepUp);
      const blob = await res.blob();
      const mime = res.headers.get("content-type") || "application/octet-stream";
      const url = URL.createObjectURL(blob);
      if (download) { const a = document.createElement("a"); a.href = url; a.download = `asset-${tokenId}`; a.click(); }
      const text = mime.startsWith("text/") || mime.includes("json") ? await blob.text() : "";
      setState({ kind: "ok", text, mime, url, hash: res.headers.get("x-content-hash"), risk: res.headers.get("x-risk-score") });
    } catch (e: any) {
      setState({ kind: "error", error: e });
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <button className="btn btn-accent" onClick={() => open(false)} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "Checking policy…" : "Open the file"}
        </button>
        <button className="btn" onClick={() => open(true, true)}>Download a copy</button>
      </div>

      {state.kind === "error" && (
        <div className="stack">
          <Refusal error={state.error} />
          {state.error.code === "STEP_UP_REQUIRED" && (
            <button className="btn btn-primary" onClick={() => open(true)}>
              Confirm it's me and continue
            </button>
          )}
        </div>
      )}

      {state.kind === "ok" && (
        <div className="panel panel-flat stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h4>File released</h4>
            <div className="row">
              {state.risk && <span className="chip chip-warn mono">Risk {state.risk}/100</span>}
              <span className="chip chip-ok mono">Hash verified against chain</span>
            </div>
          </div>
          {state.text ? (
            <pre className="hash" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{state.text}</pre>
          ) : state.mime.startsWith("image/") ? (
            <img src={state.url} alt="" style={{ maxWidth: "100%", border: "3px solid var(--line)" }} />
          ) : (
            <p className="tiny muted">This file type cannot be previewed here. Use “Download a copy”.</p>
          )}
          <p className="tiny muted">
            Decrypted server-side, re-hashed, and compared with the hash on chain before release.
            The decision was written to the log.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- trace */

function Trace({ tokenId }: { tokenId: string }) {
  const { session } = useSession();
  const { data, error, loading } = useAsync<any>(() => api(`/assets/${tokenId}/effective`), [tokenId]);

  if (loading) return <Loading what="Resolving permissions on chain" />;
  if (error) return <ErrorBox error={error} />;

  const mask = toMask(data.effective);
  const gated = session ? session.clearance < data.classification : false;
  // Bits the clearance gate would have removed, shown so the override is visible
  // rather than implied by their absence.
  const stripped = gated ? (P.READ | P.DOWNLOAD | P.WRITE | P.READ_META | P.SHARE) & ~mask : 0;

  const steps = [
    { n: "Identity", ok: true, b: `Identity #${data.identityId} is active and in tenure.` },
    { n: "Grants collected", ok: true, b: "Every access entry for this person and their roles was read from the registry." },
    { n: "Allow minus deny", ok: true, b: "Denied bits were subtracted. A deny always wins, even against a direct grant." },
    {
      n: "Clearance gate", ok: !gated,
      b: gated
        ? `Clearance ${TIERS[data.clearance]} is below classification ${TIERS[data.classification]}. Content permissions were stripped here.`
        : `Clearance ${TIERS[data.clearance]} meets classification ${TIERS[data.classification]}. Nothing stripped.`,
    },
    {
      n: "Role rules", ok: true,
      b: "Auditors and Security Officers gain metadata and audit permissions and can never hold content permissions, whatever a grant says.",
    },
  ];

  return (
    <div className="stack-lg">
      <section className="panel stack">
        <span className="eyebrow">Effective access</span>
        <h3>Why this person has exactly this access to this file</h3>
        <p className="lede">
          The answer is a sequence, not a verdict. A permission can be granted at one
          step and removed at a later one.
        </p>
        <div className="grid grid-2">
          <div className="spec-row"><span>Clearance</span><span>{TIERS[data.clearance]}</span></div>
          <div className="spec-row"><span>Classification</span><span>{TIERS[data.classification]}</span></div>
        </div>
      </section>

      <section className="pipeline">
        {steps.map((s, i) => (
          <div className={`stage ${!s.ok ? "stage-strip" : ""}`} key={s.n}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="tiny mono muted">Step {i + 1}</span>
              <span className="tiny mono"><b>{s.ok ? "Passed" : "Stripped"}</b></span>
            </div>
            <h4 style={{ margin: "8px 0" }}>{s.n}</h4>
            <p className="tiny">{s.b}</p>
          </div>
        ))}
      </section>

      <section className="panel stack">
        <div className="panel-head">
          <h3>Resulting permissions</h3>
          <span className="chip mono">{maskHex(mask)}</span>
        </div>
        <BitGrid mask={mask} stripped={stripped} />
        {data.denialCode && (
          <p className="tiny mono"><b>Refusal code if content were requested:</b> {data.denialCode}</p>
        )}
        <p className="tiny muted">
          This value comes straight from the contract's resolver. The interface computes nothing.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ access */

function AccessList({ tokenId, classification }: { tokenId: string; classification: number }) {
  const { session } = useSession();
  const [revision, setRevision] = useState(0);
  const { data, error, loading } = useAsync<any[]>(() => api(`/assets/${tokenId}/acl`), [tokenId, revision]);
  const identities = useAsync<any[]>(() => api("/assets/identities"), []);
  const [target, setTarget] = useState("");
  const [allow, setAllow] = useState(0);
  const [deny, setDeny] = useState(0);
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const policy = approvalPolicy(classification);

  const toggle = (kind: "allow" | "deny", bit: number) => {
    const current = kind === "allow" ? allow : deny;
    const next = current ^ bit;
    if (kind === "allow") { setAllow(next); setDeny(deny & ~bit); }
    else { setDeny(next); setAllow(allow & ~bit); }
  };

  async function save() {
    setSaving(true); setSaveError(null); setSaved(null);
    try {
      const expiresAt = expiry ? Math.floor(new Date(`${expiry}T23:59:59`).getTime() / 1000) : 0;
      
      let txHash;
      if (classification >= 2) {
        // High clearance requires on-chain proposal via GrantWorkflow
        const provider = new BrowserProvider((window as any).ethereum);
        const signer = await provider.getSigner();
        const configReq = await fetch(API + "/config");
        const configJson = await configReq.json();
        
        const workflow = new Contract(configJson.contracts.GrantWorkflow, [
          "function proposeGrant(uint256 assetId, bytes32 principal, uint32 allow, uint32 deny, uint64 expiresAt, uint8 delegationDepth, bytes32 justificationHash, uint256 proposerId) external returns (uint256)"
        ], signer);
        
        // Principal formatting based on backend/contracts logic (PrincipalType.IDENTITY = 1)
        const principal = ethers.solidityPackedKeccak256(["uint8", "uint256"], [1, target]);
        const tx = await workflow.proposeGrant(
          tokenId, principal, allow, deny, expiresAt, 0, ethers.keccak256(ethers.toUtf8Bytes(reason)), session!.identityId
        );
        await tx.wait();
        txHash = tx.hash;
      } else {
        // Direct grant for PUBLIC/RESTRICTED via backend relayer
        const out = await api<{ txHash: string }>(`/assets/${tokenId}/access`, {
          method: "POST",
          body: JSON.stringify({ targetIdentity: target, allowMask: allow, denyMask: deny, expiresAt, reason }),
        });
        txHash = out.txHash;
      }
      
      setSaved(txHash);
      setReason(""); setExpiry(""); setAllow(0); setDeny(0);
      setRevision((value) => value + 1);
    } catch (e: any) {
      setSaveError(e?.detail || e?.code || "The access rule could not be saved.");
    } finally { setSaving(false); }
  }

  if (loading) return <Loading what="Reading the access list" />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div className="stack-lg">
      <section className={`panel stack ${policy.approvals > 0 ? "panel-tint" : ""}`}>
        <span className="eyebrow">Grant routing</span>
        <h3>{policy.approvals === 0
          ? "A grant on this file takes effect immediately"
          : "A grant on this file becomes a proposal"}</h3>
        <p>{policy.note}{policy.timelock !== "none" && ` A ${policy.timelock} waiting period applies before it can execute.`}</p>
        <p className="tiny mono">
          Whoever proposes a grant can never approve it. That rule is in the contract.
        </p>
      </section>

      {session?.roles.includes(1) && (
        <section className="panel stack">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Access management</span>
              <h3 style={{ marginTop: 6 }}>Grant individual permissions</h3>
            </div>
            <span className="chip chip-ok mono">Immediate</span>
          </div>
          <p className="tiny muted">Choose one identity, set only the permissions they need, and record why the access is justified.</p>

          <label className="stack" style={{ gap: 6 }}>
            <b className="tiny">Person</b>
            <select className="btn btn-block" value={target} onChange={(event) => setTarget(event.target.value)} disabled={identities.loading}>
              <option value="">Select an identity…</option>
              {identities.data?.filter((item) => item.identityId !== session.identityId && item.active).map((item) => (
                <option key={item.identityId} value={item.identityId}>
                  Identity #{item.identityId} · {item.controller.slice(0, 8)}…{item.controller.slice(-4)} · {TIERS[item.clearance]}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-2">
            <div className="stack">
              <h4>Allow</h4>
              {BITS.map((permission) => (
                <label className="spec-row" key={`allow-${permission.bit}`}>
                  <span><b>{permission.name}</b><small className="muted"> · {permission.desc}</small></span>
                  <input type="checkbox" checked={(allow & permission.bit) !== 0} onChange={() => toggle("allow", permission.bit)} />
                </label>
              ))}
            </div>
            <div className="stack">
              <h4>Deny</h4>
              {BITS.map((permission) => (
                <label className="spec-row" key={`deny-${permission.bit}`}>
                  <span><b>{permission.name}</b><small className="muted"> · overrides any grant</small></span>
                  <input type="checkbox" checked={(deny & permission.bit) !== 0} onChange={() => toggle("deny", permission.bit)} />
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-2">
            <label className="stack" style={{ gap: 6 }}>
              <b className="tiny">Expires on <span className="muted">(optional)</span></b>
              <input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} />
            </label>
            <label className="stack" style={{ gap: 6 }}>
              <b className="tiny">Written reason</b>
              <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why does this person need access?" />
            </label>
          </div>

          <button className="btn btn-primary btn-lg" onClick={save}
            disabled={saving || !target || (!allow && !deny) || !reason.trim()}>
            {saving ? "Recording access rule…" : "Save access rule"}
          </button>
          {saved && <p className="tiny mono" style={{ color: "var(--green)" }}>Recorded on chain · {saved}</p>}
          {saveError && <div className="panel panel-alert panel-flat"><p className="tiny">{saveError}</p></div>}
        </section>
      )}

      <section className="stack">
        <h3>Who has access ({data?.length ?? 0})</h3>
        {!data?.length ? (
          <Empty title="No access entries" body="Nobody holds a grant on this file yet." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Principal</th><th>Allowed</th><th>Denied</th>
                  <th>Expires</th><th>Granted by</th><th>Written reason</th>
                </tr>
              </thead>
              <tbody>
                {data.map((e, i) => (
                  <tr key={i}>
                    <td className="mono tiny">{e.principal.slice(0, 18)}…</td>
                    <td><BitStrip mask={e.allow} /><div className="tiny mono">{e.allow}</div></td>
                    <td>
                      {toMask(e.deny) ? <span className="chip chip-bad mono">{e.deny}</span>
                        : <span className="tiny muted">None</span>}
                    </td>
                    <td className="tiny mono">
                      {e.expiresAt ? new Date(e.expiresAt * 1000).toLocaleDateString() : "No expiry"}
                    </td>
                    <td className="tiny mono">
                      {e.grantedBy.length > 20 ? "System (on mint)" : `Identity #${e.grantedBy}`}
                    </td>
                    <td className="tiny mono" title={e.justificationHash}>
                      {e.justificationHash.slice(0, 14)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="tiny muted">
          Every entry carries a written reason, hash-committed on chain. The contract
          refuses a grant without one.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- audit */

function AuditTimeline({ tokenId }: { tokenId: string }) {
  const { data, error, loading } = useAsync<any>(() => api(`/audit/${tokenId}`), [tokenId]);
  if (loading) return <Loading what="Reading events and decisions" />;
  if (error) return <ErrorBox error={error} />;

  const events = data.onChain ?? [];
  const decisions = data.decisions ?? [];

  return (
    <div className="stack-lg">
      <section className="stack">
        <h3>Recorded on chain ({events.length})</h3>
        <p className="lede">State changes. Each one is an event with a transaction hash anyone can verify.</p>
        {!events.length ? <Empty title="No events" body="Nothing has been recorded against this token." /> : (
          <div className="timeline">
            {events.map((e: any, i: number) => (
              <div className="tl-item chain" key={i}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <b>{e.type}</b>
                  <span className="chip mono tiny">Block {e.block}</span>
                </div>
                <div className="tiny mono muted" style={{ marginTop: 4 }}>{e.txHash}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="stack">
        <h3>Access decisions ({decisions.length})</h3>
        <p className="lede">
          Every read and every refusal. Each row is hashed together with the one before
          it, so removing or altering a line breaks the chain.
        </p>
        {!decisions.length ? <Empty title="No decisions yet" body="Nobody has requested this file's contents." /> : (
          <div className="timeline">
            {decisions.map((d: any) => (
              <div className={`tl-item ${d.reasonCode === "ALLOW" ? "" : "deny"}`} key={d.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <span className={`chip ${d.reasonCode === "ALLOW" ? "chip-ok" : "chip-bad"} mono`}>{d.reasonCode}</span>
                    <span className="tiny">Identity #{d.identityId}</span>
                  </div>
                  <span className="tiny mono muted">{new Date(d.ts).toLocaleString()}</span>
                </div>
                {d.reasons?.length > 0 && (
                  <ul className="tiny" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {d.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
                  </ul>
                )}
                <div className="tiny mono muted" style={{ marginTop: 6 }}>
                  {d.rowHash.slice(0, 20)}… links to {d.prevHash.slice(0, 14)}…
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- page */

export default function AssetDetail() {
  const { id = "" } = useParams();
  const [tab, setTab] = useState<Tab>("overview");
  const { data, error, loading } = useAsync<any>(() => api(`/assets/${id}`), [id]);

  if (loading) return <Loading what="Reading asset metadata" />;
  if (error) return (
    <div className="stack">
      <ErrorBox error={error} />
      <Link className="btn" to="/console">Back to files</Link>
    </div>
  );

  const mask = toMask(data.effective);
  const TABS: [Tab, string][] = [
    ["overview", "Overview"], ["trace", "Effective access"],
    ["access", "Who has access"], ["audit", "History"],
  ];

  return (
    <>
      <section className="panel stack">
        <div className="spread">
          <div className="stack">
            <div className="row">
              <span className="chip mono">Token #{id}</span>
              <Tier level={data.classification} />
              <span className="chip mono">v{data.version}</span>
            </div>
            <h2>{data.name ?? `Asset ${id}`}</h2>
            <p className="muted mono tiny">
              Owner: identity #{data.ownerIdentity}
              {data.size ? ` · ${(data.size / 1024).toFixed(1)} KB` : ""}
              {data.mimeType ? ` · ${data.mimeType}` : ""}
            </p>
          </div>
          <Link className="btn" to="/console">All files</Link>
        </div>

        {data.metadataRestricted ? (
          <div className="panel panel-tint panel-flat">
            <h4>Management view</h4>
            <p className="tiny" style={{ marginTop: 6 }}>
              You can manage this file’s access list, but its name, hash and other metadata are hidden by your role rule.
            </p>
          </div>
        ) : (
          <div className="stack">
            <h4>Content hash recorded on chain</h4>
            <div className="hash">{data.contentHash}</div>
            <p className="tiny muted">
              The file is re-hashed on every read and compared with this value. A mismatch
              stops the transfer instead of serving the file.
            </p>
          </div>
        )}
      </section>

      <div className="row">
        {TABS.map(([k, label]) => (
          <button key={k} className={`btn btn-sm ${tab === k ? "btn-accent" : ""}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <section className="panel stack">
          <div className="panel-head">
            <h3>What you may do</h3>
            <span className="chip mono">{maskHex(mask)}</span>
          </div>
          <BitGrid mask={mask} />
          <div className="stack">
            {has(mask, P.READ) ? <ContentViewer tokenId={id} /> : (
              <p className="lede">
                You do not hold the read permission on this file. Open “Effective access”
                to see exactly which step removed it.
              </p>
            )}
          </div>
        </section>
      )}

      {tab === "trace" && <Trace tokenId={id} />}
      {tab === "access" && <AccessList tokenId={id} classification={data.classification} />}
      {tab === "audit" && <AuditTimeline tokenId={id} />}
    </>
  );
}
