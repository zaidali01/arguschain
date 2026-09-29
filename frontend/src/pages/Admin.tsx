import React, { useState } from "react";
import { BrowserProvider, Contract, keccak256, toUtf8Bytes } from "ethers";
import { Link } from "react-router-dom";
import { api, useSession } from "../lib/session";
import { TIERS } from "../lib/permissions";
import { ErrorBox, useAsync, Loading } from "../components/ui";

// Only the one function the browser needs to call. Keeping the ABI minimal
// avoids shipping the whole artifact to the client.
const ASSET_ABI = [
  "function mint(uint256 toIdentity, bytes32 contentHash, uint8 classification, bytes32 justificationHash) returns (uint256)",
  "function totalMinted() view returns (uint256)",
];

type Step =
  | { s: "idle" }
  | { s: "uploading" }
  | { s: "signing"; hash: string }
  | { s: "mining"; hash: string; tx: string }
  | { s: "linking"; tokenId: string }
  | { s: "done"; tokenId: string }
  | { s: "failed"; stage: string; message: string; code?: string };

function explain(e: any): { message: string; code?: string } {
  if (e?.walletRpc) return { message: e.message, code: e.code };
  const inner = e?.info?.error ?? e?.error ?? e?.cause ?? null;
  const parts = [
    e?.reason,
    inner?.message,
    inner?.data?.message,
    e?.shortMessage,
    e?.detail,
    e?.message,
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
  const unique = Array.from(new Set(parts));
  return { message: unique[0] ?? "Unknown failure", code: e?.code ?? inner?.code };
}

/** MetaMask answers eth_chainId from its own config, so a dead RPC for the
 *  selected network only surfaces at the first real read — which is the mint.
 *  That arrives as an opaque "Internal JSON-RPC error", so probe it first. */
async function assertProviderReachable(provider: BrowserProvider, chainId: number) {
  try {
    await provider.send("eth_getBlockByNumber", ["latest", false]);
  } catch (e: any) {
    const inner = e?.info?.error ?? e?.error ?? e?.info ?? e;
    throw Object.assign(
      new Error(
        `MetaMask cannot reach an RPC node for chain ${chainId}, so the transaction cannot be ` +
        `estimated. Open MetaMask → Settings → Networks → ${chainId === 11155111 ? "Sepolia" : chainId} ` +
        `and set the RPC URL to https://ethereum-sepolia-rpc.publicnode.com ` +
        `(MetaMask's built-in default, https://rpc.sepolia.org, currently returns a 404).`
      ),
      { code: inner?.code ?? "RPC_UNREACHABLE", walletRpc: true }
    );
  }
}

export default function Admin() {
  const { session } = useSession();
  const config = useAsync<{ contracts: Record<string, string>; chainId: number }>(() => api("/config"), []);
  const [file, setFile] = useState<File | null>(null);
  const [owner, setOwner] = useState("2");
  const [classification, setClassification] = useState(1);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState<Step>({ s: "idle" });

  const isAdmin = session?.roles.includes(1);
  const needsWorkflow = classification >= 2;

  async function run() {
    if (!file || !reason.trim()) return;
    let stage = "Encrypt and store";
    try {
      setStep({ s: "uploading" });
      const form = new FormData();
      form.append("file", file);
      const up = await api<any>("/assets/upload", { method: "POST", body: form });

      stage = "Switch MetaMask to the right network";
      setStep({ s: "signing", hash: up.contentHash });
      const provider = new BrowserProvider((window as any).ethereum);

      // Ensure MetaMask is on the correct chain before submitting
      const targetChainId: number = config.data!.chainId;
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== targetChainId) {
        try {
          await (window as any).ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: `0x${targetChainId.toString(16)}` }],
          });
        } catch (switchErr: any) {
          // Chain not added to MetaMask — add it (only needed for non-standard chains)
          if (switchErr.code === 4902) {
            throw new Error(`Please add chain ${targetChainId} to MetaMask manually and try again.`);
          }
          throw switchErr;
        }
      }

      stage = "Estimate and sign the mint in your wallet";
      await assertProviderReachable(provider, targetChainId);
      const signer = await provider.getSigner();
      const assets = new Contract(config.data!.contracts.AssetNFT, ASSET_ABI, signer);

      const tx = await assets.mint(owner, up.contentHash, classification, keccak256(toUtf8Bytes(reason)));
      stage = "Wait for the transaction to confirm";
      setStep({ s: "mining", hash: up.contentHash, tx: tx.hash });
      await tx.wait();

      stage = "Bind the stored file to the token";
      const tokenId = (await assets.totalMinted()).toString();
      setStep({ s: "linking", tokenId });
      await api(`/assets/${tokenId}/link`, { method: "POST", body: JSON.stringify(up) });
      setStep({ s: "done", tokenId });
    } catch (e: any) {
      const { message, code } = explain(e);
      setStep({
        s: "failed",
        stage,
        code,
        message: code === "ACTION_REJECTED" ? "You declined the signature in your wallet." : message,
      });
    }
  }

  if (!isAdmin) {
    return (
      <div className="panel panel-alert stack">
        <h3>Administrators only</h3>
        <p>Registering files and identities needs the Admin role token. Switch to an
          administrator account in your wallet to continue.</p>
      </div>
    );
  }

  if (config.loading) return <Loading what="Reading contract addresses" />;
  if (config.error) return <ErrorBox error={config.error} />;

  const busy = ["uploading", "signing", "mining", "linking"].includes(step.s);

  return (
    <>
      <section className="panel stack">
        <span className="eyebrow">Administration</span>
        <h2>Register a file</h2>
        <p className="lede">
          The file is encrypted here, but the asset itself is created by a transaction
          you sign in your own wallet. The server never signs on your behalf.
        </p>
      </section>

      <section className="grid grid-2">
        <div className="panel stack">
          <h3>1. The file</h3>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          {file && <p className="tiny mono">{file.name} · {(file.size / 1024).toFixed(1)} KB</p>}

          <h3>2. Who owns it</h3>
          <select className="btn btn-block" value={owner} onChange={(e) => setOwner(e.target.value)}>
            {[["1", "Admin"], ["2", "Manager"], ["3", "Auditor"], ["4", "User"], ["5", "Security Officer"]].map(([v, l]) => (
              <option key={v} value={v}>Identity #{v} — {l}</option>
            ))}
          </select>

          <h3>3. Classification</h3>
          <div className="row">
            {TIERS.map((t, i) => (
              <button key={t} className={`btn btn-sm ${classification === i ? "btn-accent" : ""}`}
                onClick={() => setClassification(i)}>{t}</button>
            ))}
          </div>
          {needsWorkflow && (
            <div className="panel panel-tint panel-flat">
              <h4>This classification cannot be created directly</h4>
              <p className="tiny" style={{ marginTop: 6 }}>
                At {TIERS[classification]} the contract refuses a direct mint. It must go
                through propose, approve and execute with a second person involved.
                Use a lower classification here, or run the workflow from the console.
              </p>
            </div>
          )}

          <h3>4. Written reason</h3>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="Why this file is being registered, and for whom"
            style={{ width: "100%", border: "3px solid var(--line)", padding: 10, fontFamily: "inherit" }} />
          <p className="tiny muted">Required. The contract reverts without it, and its hash is kept permanently.</p>

          <button className="btn btn-primary btn-lg btn-block"
            onClick={run} disabled={!file || !reason.trim() || busy || needsWorkflow}>
            {busy ? "Working…" : "Register and sign"}
          </button>
        </div>

        <div className="panel stack">
          <h3>Progress</h3>
          {[
            ["Encrypt and store", ["uploading"], ["signing", "mining", "linking", "done"]],
            ["Sign the transaction", ["signing"], ["mining", "linking", "done"]],
            ["Wait for confirmation", ["mining"], ["linking", "done"]],
            ["Bind the file to the token", ["linking"], ["done"]],
          ].map(([label, active, past]: any) => {
            const state = active.includes(step.s) ? "now" : past.includes(step.s) ? "done" : "wait";
            return (
              <div className="spec-row" key={label}>
                <span>{label}</span>
                <span className={`chip ${state === "done" ? "chip-ok" : state === "now" ? "chip-warn" : ""}`}>
                  {state === "done" ? "Done" : state === "now" ? "In progress" : "Waiting"}
                </span>
              </div>
            );
          })}

          {step.s === "mining" && <div className="hash">{step.tx}</div>}

          {step.s === "done" && (
            <div className="panel panel-flat stack" style={{ background: "var(--green)" }}>
              <h4>Registered as token #{step.tokenId}</h4>
              <Link className="btn btn-sm" to={`/console/asset/${step.tokenId}`}>Open it</Link>
            </div>
          )}

          {step.s === "failed" && (
            <div className="panel panel-alert panel-flat stack">
              <h4>Registration stopped</h4>
              <p className="tiny">Failed while trying to: <strong>{step.stage}</strong></p>
              <p className="tiny mono">{step.message}</p>
              {step.code && <p className="tiny mono">code: {step.code}</p>}
              <p className="tiny">
                If this says the content is a duplicate, the same bytes are already
                registered under another token. The same file can never be registered twice.
              </p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
