import React from "react";
import { api, useSession } from "../lib/session";
import { Loading, ErrorBox, Empty, useAsync } from "../components/ui";
import { approvalPolicy, TIERS } from "../lib/permissions";
import { BrowserProvider, Contract } from "ethers";

/* -------------------------------------------------------------------- risk */

export function Risk() {
  const { data, error, loading } = useAsync<any[]>(() => api("/decisions"), []);
  if (loading) return <Loading what="Reading the decision log" />;
  if (error) return <ErrorBox error={error} />;

  const flagged = (data ?? []).filter((d) => d.riskScore > 0 || d.reasonCode !== "ALLOW");

  return (
    <>
      <section className="panel stack">
        <span className="eyebrow">Behavioural monitoring</span>
        <h2>Unusual access, and why it was flagged</h2>
        <p className="lede">
          Rules score every request against the access log: activity outside working
          hours, many different files in a short window, repeated refusals, and the
          first time someone opens a file.
        </p>
        <div className="grid grid-3">
          <div className="stat" style={{ background: "var(--green)" }}>
            <div className="num">0–40</div><div className="cap">Allowed and logged</div>
          </div>
          <div className="stat" style={{ background: "var(--yellow)" }}>
            <div className="num">41–80</div><div className="cap">Allowed after re-confirmation</div>
          </div>
          <div className="stat" style={{ background: "var(--pink)" }}>
            <div className="num">81+</div><div className="cap">Refused and reported</div>
          </div>
        </div>
        <div className="panel panel-flat panel-tint">
          <h4>This layer only advises</h4>
          <p className="tiny" style={{ marginTop: 6 }}>
            It cannot grant access, revoke access, or suspend anyone. Fixed thresholds
            in the policy engine turn a score into an action, and suspension is always
            a human decision.
          </p>
        </div>
      </section>

      <section className="stack">
        <h3>Recent activity ({flagged.length})</h3>
        {!flagged.length ? (
          <Empty title="Nothing flagged" body="No scored or refused requests have been recorded yet." />
        ) : (
          <div className="timeline">
            {flagged.map((d) => (
              <div className={`tl-item ${d.reasonCode === "ALLOW" ? "" : "deny"}`} key={d.id}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <div className="row">
                    <span className={`chip mono ${d.riskScore > 80 ? "chip-bad" : d.riskScore > 40 ? "chip-warn" : "chip-ok"}`}>
                      Risk {d.riskScore}
                    </span>
                    <span className="chip mono">{d.reasonCode}</span>
                    <span className="tiny">Identity #{d.identityId}{d.tokenId ? ` · token #${d.tokenId}` : ""}</span>
                  </div>
                  <span className="tiny mono muted">{new Date(d.ts).toLocaleString()}</span>
                </div>
                {d.reasons?.length > 0 && (
                  <ul className="tiny" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                    {d.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/* --------------------------------------------------------------- proposals */

export function Proposals() {
  const { data, error, loading, mutate } = useAsync<any[]>(() => api("/proposals"), []);
  const config = useAsync<any>(() => api("/config"), []);
  const { session } = useSession();
  const [working, setWorking] = React.useState(0);

  async function handleAction(pid: number, type: "approve" | "execute") {
    try {
      setWorking(pid);
      const provider = new BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const workflow = new Contract(config.data!.contracts.GrantWorkflow, [
        "function approve(uint256 pid, uint256 approverId)",
        "function execute(uint256 pid)"
      ], signer);

      let tx;
      if (type === "approve") {
        tx = await workflow.approve(pid, session.identityId);
      } else {
        tx = await workflow.execute(pid);
      }
      await tx.wait();
      mutate();
    } catch (e: any) {
      alert(e.message || "Action failed");
    } finally {
      setWorking(0);
    }
  }

  if (loading || config.loading) return <Loading what="Reading proposals" />;
  if (error || config.error) return <ErrorBox error={error || config.error} />;

  const kindNames = ["Grant Access", "Mint & Allocate", "Transfer", "Clearance Uplift", "Admin Role Mint"];

  return (
    <>
      <section className="panel stack">
        <span className="eyebrow">Four-eyes approvals</span>
        <h2>Grants that need a second person</h2>
        <p className="lede">
          Above a classification threshold no one can grant access alone. The request
          becomes a proposal, someone else approves it, and only then can it execute.
        </p>
      </section>

      <section className="stack">
        <h3>What each classification requires</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Classification</th><th>Approvers besides the proposer</th><th>Security Officer</th><th>Waiting period</th></tr>
            </thead>
            <tbody>
              {TIERS.map((t, i) => {
                const p = approvalPolicy(i);
                return (
                  <tr key={t}>
                    <td><span className={`chip chip-t${i + 1}`}>{t}</span></td>
                    <td className="mono">{p.approvals === 0 ? "None — immediate" : p.approvals}</td>
                    <td className="mono">{p.officer ? "Required" : "Not required"}</td>
                    <td className="mono">{p.timelock}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack">
        <h3>Open Proposals</h3>
        {!data || data.length === 0 ? (
          <Empty title="No open proposals" body="There are currently no proposals waiting for approval or execution." />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Action</th>
                  <th>Proposer</th>
                  <th>Tier</th>
                  <th>Approvals</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => {
                  const policy = approvalPolicy(p.tier);
                  const isReady = p.readyAt <= Date.now() / 1000;
                  const hasApproved = p.approvers.includes(session?.identityId);
                  const canApprove = p.proposer !== session?.identityId && !hasApproved && p.approvers.length < policy.approvals;
                  const canExecute = p.approvers.length >= policy.approvals && isReady;

                  return (
                    <tr key={p.pid}>
                      <td className="mono">#{p.pid}</td>
                      <td>{kindNames[p.kind]}</td>
                      <td className="mono">Identity #{p.proposer}</td>
                      <td><span className={`chip chip-t${p.tier + 1}`}>{TIERS[p.tier]}</span></td>
                      <td className="mono">{p.approvers.length} / {policy.approvals}</td>
                      <td className="mono">
                        {!isReady ? `Waiting until ${new Date(p.readyAt * 1000).toLocaleString()}` : "Ready"}
                      </td>
                      <td>
                        <div className="row">
                          {canApprove && (
                            <button className="btn btn-sm btn-primary" onClick={() => handleAction(p.pid, "approve")} disabled={working === p.pid}>
                              {working === p.pid ? "..." : "Approve"}
                            </button>
                          )}
                          {canExecute && (
                            <button className="btn btn-sm btn-accent" onClick={() => handleAction(p.pid, "execute")} disabled={working === p.pid}>
                              {working === p.pid ? "..." : "Execute"}
                            </button>
                          )}
                          {!canApprove && !canExecute && <span className="tiny muted">N/A</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
