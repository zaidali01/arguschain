import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BrowserProvider } from "ethers";

// EIP-4361 is a plain text format, so we build it directly rather than pulling
// in the siwe package, which needs Node's Buffer and breaks in the browser.
// The backend parses and verifies this with its own copy of the library.
function siweMessage(o: {
  domain: string; address: string; statement: string;
  uri: string; chainId: number; nonce: string;
}) {
  return [
    `${o.domain} wants you to sign in with your Ethereum account:`,
    o.address,
    "",
    o.statement,
    "",
    `URI: ${o.uri}`,
    "Version: 1",
    `Chain ID: ${o.chainId}`,
    `Nonce: ${o.nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join("\n");
}
export const API = (import.meta as any).env?.VITE_API_URL || "/api";

/** Wallet errors carry no `detail` — that field belongs to our own API. Reading
 *  only `detail` is what made a MetaMask fault render as a blank policy notice. */
function describeWalletError(e: any, fallbackCode: string): { code: string; detail: string } {
  const inner = e?.info?.error ?? e?.error ?? e?.info ?? null;
  const message = [inner?.message, inner?.data?.message, e?.shortMessage, e?.reason, e?.message].find(
    (x): x is string => typeof x === "string" && x.trim().length > 0
  );
  const code = String(e?.code ?? fallbackCode);
  return {
    code,
    detail: message
      ? `${message}${typeof inner?.code === "number" ? ` (wallet code ${inner.code})` : ""}`
      : "The wallet returned an error with no description.",
  };
}

export interface Session {
  identityId: string;
  address: string;
  did: string;
  roles: number[];
  clearance: number;
}

/** Thrown for any non-2xx, carrying the backend's reason code so screens can
 *  render the specific refusal rather than a generic failure. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: string, public risk?: any) {
    super(code);
  }
}

let token: string | null = sessionStorage.getItem("argus.token");

/** Reads the signed JWT expiry for display only. The API remains the authority
 * and independently validates the token on every request. */
function tokenExpiresAt(raw: string | null): number | null {
  try {
    const payload = raw?.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = JSON.parse(json).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch { return null; }
}

export async function api<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...init, headers });
  } catch (e: any) {
    throw new ApiError(0, "NETWORK_FAILED", e?.message);
  }
  const type = res.headers.get("content-type") || "";

  if (!res.ok) {
    const body = type.includes("json") ? await res.json().catch(() => ({})) : {};
    throw new ApiError(res.status, body.code || `HTTP_${res.status}`, body.detail, body.risk);
  }
  if (type.includes("json")) return res.json();
  return res as unknown as T;
}

/** Content needs the raw Response so headers (hash, risk score) survive. */
export async function apiRaw(path: string, stepUp = false): Promise<Response> {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (stepUp) headers.set("x-step-up", "verified");

  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.code || `HTTP_${res.status}`, body.detail, body.risk);
  }
  return res;
}

interface Ctx {
  session: Session | null;
  expiresAt: number | null;
  address: string | null;
  connecting: boolean;
  error: { code: string; detail?: string } | null;
  connect: () => Promise<void>;
  signIn: () => Promise<void>;
  registerLocalDemoUser: () => Promise<void>;
  signOut: () => void;
}

const SessionCtx = createContext<Ctx>(null as any);
export const useSession = () => useContext(SessionCtx);

const eth = () => (window as any).ethereum;

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = sessionStorage.getItem("argus.session");
    return raw ? JSON.parse(raw) : null;
  });
  const [expiresAt, setExpiresAt] = useState<number | null>(() => tokenExpiresAt(token));
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<{ code: string; detail?: string } | null>(null);

  const signOut = useCallback(() => {
    token = null;
    sessionStorage.removeItem("argus.token");
    sessionStorage.removeItem("argus.session");
    setSession(null);
    setExpiresAt(null);
  }, []);

  const connect = useCallback(async () => {
    if (!eth()) {
      setError({ code: "NO_WALLET", detail: "No wallet extension detected. Install MetaMask to continue." });
      return;
    }
    try {
      const accounts: string[] = await eth().request({ method: "eth_requestAccounts" });
      setAddress(accounts[0] ?? null);
    } catch (e: any) {
      setError(describeWalletError(e, "CONNECT_FAILED"));
    }
  }, []);


  const signIn = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      if (!eth()) throw new ApiError(0, "NO_WALLET", "No wallet extension detected.");
      const provider = new BrowserProvider(eth());
      const signer = await provider.getSigner();
      const who = await signer.getAddress();
      const { chainId } = await provider.getNetwork();

      const cfg = await api<{ chainId: number; network?: string }>("/config").catch(() => null);
      if (cfg && Number(chainId) !== cfg.chainId) {
        throw Object.assign(
          new Error(
            `Your wallet is on chain ${chainId}, but this server is configured for chain ` +
            `${cfg.chainId}${cfg.network ? ` (${cfg.network})` : ""}. Switch networks in ` +
            `MetaMask and sign in again.`
          ),
          { code: "WRONG_NETWORK" }
        );
      }

      const { nonce } = await api<{ nonce: string }>("/auth/nonce");
      const message = siweMessage({
        domain: window.location.host,
        address: who,
        statement: "Sign in to ArgusChain",
        uri: window.location.origin,
        chainId: Number(chainId),
        nonce,
      });

      const signature = await signer.signMessage(message);
      const out = await api<{ token: string; session: Session }>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ message, signature }),
      });

      token = out.token;
      sessionStorage.setItem("argus.token", out.token);
      sessionStorage.setItem("argus.session", JSON.stringify(out.session));
      setSession(out.session);
      setExpiresAt(tokenExpiresAt(out.token));
      setAddress(who);
    } catch (e: any) {
      if (e?.code === 4001 || e?.code === "ACTION_REJECTED") setError({ code: "SIGNATURE_REJECTED", detail: "You declined the signature." });
      else if (e instanceof ApiError) setError({ code: e.code, detail: e.detail });
      else setError(describeWalletError(e, "SIGN_IN_FAILED"));
    } finally {
      setConnecting(false);
    }
  }, []);

  const registerLocalDemoUser = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      if (!eth()) throw new ApiError(0, "NO_WALLET", "No wallet extension detected.");
      const provider = new BrowserProvider(eth());
      const signer = await provider.getSigner();
      const who = await signer.getAddress();
      const challenge = await api<{ domain: any; types: any; value: any }>(
        `/auth/register-challenge?address=${encodeURIComponent(who)}`
      );
      const signature = await signer.signTypedData(challenge.domain, challenge.types, challenge.value);
      await api("/auth/register", { method: "POST", body: JSON.stringify({ address: who, signature }) });
      setAddress(who);
      await signIn();
    } catch (e: any) {
      if (e?.code === 4001 || e?.code === "ACTION_REJECTED") setError({ code: "SIGNATURE_REJECTED", detail: "You declined the registration signature." });
      else if (e instanceof ApiError) setError({ code: e.code, detail: e.detail });
      else setError(describeWalletError(e, "REGISTRATION_FAILED"));
    } finally {
      setConnecting(false);
    }
  }, [signIn]);

  // Switching MetaMask accounts means acting as a different person, so the old
  // session must not survive: the demo depends on that being unambiguous.
  useEffect(() => {
    if (!eth()) return;
    const onAccounts = (accounts: string[]) => {
      setAddress(accounts[0] ?? null);
      signOut();
    };
    eth().on("accountsChanged", onAccounts);
    eth().request({ method: "eth_accounts" }).then((a: string[]) => setAddress(a[0] ?? null));
    return () => eth().removeListener?.("accountsChanged", onAccounts);
  }, [signOut]);

  const value = useMemo(
    () => ({ session, expiresAt, address, connecting, error, connect, signIn, registerLocalDemoUser, signOut }),
    [session, expiresAt, address, connecting, error, connect, signIn, registerLocalDemoUser, signOut]
  );

  return <SessionCtx.Provider value={value}>{children}</SessionCtx.Provider>;
}
