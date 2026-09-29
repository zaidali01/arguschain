/** The eight bits, in the fixed order the contract defines them. */
export const BITS = [
  { bit: 1 << 0, key: "L", name: "LIST", desc: "Appears in the file list" },
  { bit: 1 << 1, key: "M", name: "READ_META", desc: "Size, hash, version, owner" },
  { bit: 1 << 2, key: "R", name: "READ", desc: "View the file in the app" },
  { bit: 1 << 3, key: "D", name: "DOWNLOAD", desc: "Export the raw file" },
  { bit: 1 << 4, key: "W", name: "WRITE", desc: "Upload a new version" },
  { bit: 1 << 5, key: "S", name: "SHARE", desc: "Delegate part of your access" },
  { bit: 1 << 6, key: "A", name: "ADMIN", desc: "Edit the access list" },
  { bit: 1 << 7, key: "U", name: "AUDIT", desc: "Full history and others' access" },
] as const;

export const P = {
  LIST: 1, READ_META: 2, READ: 4, DOWNLOAD: 8,
  WRITE: 16, SHARE: 32, ADMIN: 64, AUDIT: 128,
};

export const TIERS = ["PUBLIC", "RESTRICTED", "CONFIDENTIAL", "SECRET", "TOP SECRET"];

export const ROLES: Record<number, string> = {
  1: "Admin", 2: "Manager", 3: "Auditor", 4: "User", 5: "Security Officer",
};

export const toMask = (hex: string | number) =>
  typeof hex === "number" ? hex : parseInt(String(hex).replace(/^0x/, ""), 16) || 0;

export const maskHex = (m: number) => `0x${m.toString(16).padStart(2, "0")}`;

export const has = (mask: string | number, bit: number) => (toMask(mask) & bit) !== 0;

/** Approvals a grant needs, mirroring GrantWorkflow's policy table. */
export function approvalPolicy(classification: number) {
  switch (classification) {
    case 0:
    case 1: return { approvals: 0, officer: false, timelock: "none", note: "Takes effect immediately." };
    case 2: return { approvals: 1, officer: false, timelock: "none", note: "Needs one other approver." };
    case 3: return { approvals: 2, officer: true, timelock: "1 hour", note: "Needs two approvers, one a Security Officer." };
    default: return { approvals: 2, officer: true, timelock: "24 hours", note: "Needs two Security-Officer-cleared approvers." };
  }
}

/** Every refusal the backend can return, in the interface's own words. */
export const REFUSALS: Record<string, { title: string; body: string; action?: string }> = {
  NO_SESSION: { title: "Not signed in", body: "Sign in with your wallet to continue." },
  SESSION_EXPIRED: { title: "Session expired", body: "Sessions last 15 minutes. Sign in again." },
  IDENTITY_NOT_FOUND: { title: "Wallet not registered", body: "This address does not control a registered identity. An administrator must register it first." },
  IDENTITY_SUSPENDED: { title: "Identity suspended", body: "A Security Officer has suspended this identity." },
  IDENTITY_REVOKED: { title: "Identity revoked", body: "This identity has been revoked and holds no access anywhere." },
  IDENTITY_EXPIRED: { title: "Tenure lapsed", body: "This identity's validity period has ended." },
  IDENTITY_INACTIVE: { title: "Identity not active", body: "Access is withheld until the identity is active again." },
  ASSET_NOT_FOUND: { title: "No such asset", body: "Nothing is registered under this token id." },
  NO_ACE_ON_ASSET: { title: "No access granted", body: "Nobody has granted you access to this file yet.", action: "Ask the file's owner or an administrator for a grant." },
  EXPLICIT_DENY: { title: "Access explicitly denied", body: "A deny rule blocks this permission. Deny always wins, even against a grant you hold." },
  ACE_EXPIRED: { title: "Your access expired", body: "The grant had a time limit and it has passed.", action: "Request a renewal." },
  PERMISSION_BIT_MISSING: { title: "Permission not held", body: "You hold access to this file, but not this particular permission." },
  INSUFFICIENT_CLEARANCE: { title: "Clearance too low", body: "Your clearance is below this file's classification. Nothing about its contents is shown.", action: "Request a clearance review." },
  SOD_VIOLATION: { title: "Role may not read content", body: "Your role sees everything about a file except the file itself. That separation is enforced by the contract." },
  STEP_UP_REQUIRED: { title: "Confirm it's you", body: "This request scored as unusual. Re-confirm before it proceeds." },
  ANOMALY_SCORE_HIGH: { title: "Request refused and reported", body: "This request scored above the refusal threshold. A record has been filed." },
  TAMPER_DETECTED: { title: "Integrity check failed", body: "The stored file no longer matches the hash recorded on chain. It will not be served." },
  FILE_NOT_STORED: { title: "No file behind this token", body: "The token exists on chain but no file is stored against it." },
  NOT_ADMIN: { title: "Administrators only", body: "This action needs the Admin role token." },
  NO_ACL_ACCESS: { title: "Access list hidden", body: "Viewing the access list needs the ADMIN or AUDIT permission on this file." },
  HASH_MISMATCH: { title: "Hash does not match", body: "The uploaded file's hash differs from the one recorded on chain." },
  CHAIN_UNAVAILABLE: { title: "Cannot reach the chain", body: "The server could not read the blockchain. This is a connection fault, not a decision about you. It usually clears on its own.", action: "Wait a moment and try again." },
  INTERNAL_ERROR: { title: "Server error", body: "The request failed because of a fault on the server, not because of a policy decision about you." },
  NETWORK_FAILED: { title: "Cannot reach the server", body: "The request never reached the API. Check that the backend is running." },
  WRONG_NETWORK: { title: "Wrong network in your wallet", body: "Your wallet is on a different chain than this server expects. Nothing about your access was assessed." },
  UNKNOWN_ERROR: { title: "Wallet error", body: "MetaMask returned an error this app could not classify, so nothing was evaluated and no policy check was reached.", action: "Check that MetaMask is unlocked and on the expected network, then try again." },
  WALLET_ERROR: { title: "Wallet error", body: "Your wallet refused or failed the request. This is not a decision about your access." },
  SIGN_IN_FAILED: { title: "Sign-in failed", body: "Signing in did not complete. This is a fault, not a policy decision." },
};

/** A 5xx or a transport failure is a fault, not a refusal, and must never be
 *  dressed up as one — the whole point of the reason codes is that they mean
 *  something specific. */
export const refusalFor = (code?: string, status?: number): { title: string; body: string; action?: string } => {
  if (code && REFUSALS[code]) return REFUSALS[code];
  if (!code || /^HTTP_5\d\d$/.test(code)) {
    return status && status >= 500
      ? REFUSALS.INTERNAL_ERROR
      : { title: "Request failed", body: `The server responded ${status ?? "with an error"}. This was a fault, not a policy decision.` };
  }
  return {
    title: code,
    body: "This app does not recognise this error code, so it cannot say what caused it. An unrecognised code is not a statement about your access.",
    action: "Quote this code when reporting it.",
  };
};
