import { Request, Response, Router } from "express";
import { generateNonce, SiweMessage } from "siwe";
import jwt from "jsonwebtoken";
import { ethers } from "ethers";
import crypto from "crypto";
import { contracts } from "../chain";
import { ROLE_IDS, STATUS } from "../constants";
import { jwtSecret, requireAuth } from "../middleware/auth";

const router = Router();
const NONCE_TTL_MS = 5 * 60 * 1000;
const nonces = new Map<string, number>(); // nonce -> expiry timestamp

// This is deliberately a local-demo convenience, not a production enrolment
// mechanism. The wallet still signs the exact EIP-712 registration payload
// required by ArgusIdentity; the API only relays it using the local Admin key.
const registrationChallenges = new Map<string, {
  did: string; empCommitment: string; clearance: number; validUntil: string;
  deadline: string; nonce: string; expiresAt: number;
}>();
const REGISTER_TYPES = {
  Register: [
    { name: "did", type: "address" },
    { name: "empCommitment", type: "bytes32" },
    { name: "clearance", type: "uint8" },
    { name: "validUntil", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

function localRegistrationEnabled() {
  return process.env.LOCAL_DEMO_SELF_REGISTRATION === "true";
}

router.get("/nonce", (_req, res) => {
  const nonce = generateNonce();
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  res.json({ nonce });
});

/** Creates a short-lived EIP-712 payload for a wallet to self-register in the
 * local demo. Production deployments must leave this feature disabled. */
router.get("/register-challenge", async (req, res) => {
  if (!localRegistrationEnabled()) return res.status(404).json({ code: "NOT_FOUND" });
  const did = String(req.query.address || "");
  if (!ethers.isAddress(did)) return res.status(422).json({ code: "BAD_ADDRESS" });

  const existing = await contracts.identity.byDid(did);
  if (existing !== 0n) return res.status(409).json({ code: "IDENTITY_EXISTS" });

  const now = Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 5 * 60);
  const validUntil = BigInt(now + 365 * 24 * 60 * 60);
  const nonce = await contracts.identity.nonces(did);
  const empCommitment = ethers.keccak256(
    ethers.toUtf8Bytes(`local-demo:${did.toLowerCase()}:${crypto.randomUUID()}`)
  );
  const key = did.toLowerCase();
  const challenge = {
    did, empCommitment, clearance: 1, validUntil: validUntil.toString(),
    deadline: deadline.toString(), nonce: nonce.toString(), expiresAt: Date.now() + NONCE_TTL_MS,
  };
  registrationChallenges.set(key, challenge);

  const network = await contracts.identity.runner!.provider!.getNetwork();
  res.json({
    domain: { name: "ArgusIdentity", version: "4", chainId: Number(network.chainId), verifyingContract: await contracts.identity.getAddress() },
    types: REGISTER_TYPES,
    value: {
      did, empCommitment, clearance: 1, validUntil: challenge.validUntil,
      nonce: challenge.nonce, deadline: challenge.deadline,
    },
  });
});

router.post("/register", async (req, res) => {
  if (!localRegistrationEnabled()) return res.status(404).json({ code: "NOT_FOUND" });
  const { address, signature } = req.body ?? {};
  if (!ethers.isAddress(address) || typeof signature !== "string") {
    return res.status(422).json({ code: "BAD_REQUEST" });
  }
  const key = address.toLowerCase();
  const challenge = registrationChallenges.get(key);
  registrationChallenges.delete(key); // one attempt per challenge; prevents replay
  if (!challenge || challenge.expiresAt < Date.now()) return res.status(401).json({ code: "REGISTRATION_EXPIRED" });

  const network = await contracts.identity.runner!.provider!.getNetwork();
  const domain = { name: "ArgusIdentity", version: "4", chainId: Number(network.chainId), verifyingContract: await contracts.identity.getAddress() };
  const value = {
    did: challenge.did, empCommitment: challenge.empCommitment, clearance: challenge.clearance,
    validUntil: challenge.validUntil, nonce: challenge.nonce, deadline: challenge.deadline,
  };
  try {
    if (ethers.verifyTypedData(domain, REGISTER_TYPES, value, signature).toLowerCase() !== key) {
      return res.status(401).json({ code: "BAD_SIGNATURE" });
    }
    const relayerKey = process.env.LOCAL_DEMO_ADMIN_PRIVATE_KEY;
    if (!relayerKey) return res.status(503).json({ code: "REGISTRATION_UNAVAILABLE" });
    const relayer = new ethers.Wallet(relayerKey, contracts.identity.runner!.provider!);
    const tx = await (contracts.identity.connect(relayer) as any).registerIdentity(
      challenge.did, challenge.empCommitment, challenge.clearance, challenge.validUntil, challenge.deadline, signature
    );
    await tx.wait();
    const identityId = await contracts.identity.byDid(challenge.did);
    res.status(201).json({ identityId: identityId.toString(), clearance: challenge.clearance });
  } catch (error: any) {
    res.status(400).json({ code: "REGISTRATION_FAILED", detail: error.shortMessage || error.message });
  }
});

router.post("/verify", async (req: Request, res: Response) => {
  const { message, signature } = req.body ?? {};
  if (!message || !signature) return res.status(422).json({ code: "BAD_REQUEST" });

  // 1. Cryptographic proof: signature, domain, time window, single-use nonce
  let signer: string;
  try {
    const siwe = new SiweMessage(message);
    const expiry = nonces.get(siwe.nonce);
    if (!expiry || expiry < Date.now()) return res.status(401).json({ code: "NONCE_INVALID" });
    nonces.delete(siwe.nonce); // burned before verifying: no replay, even of a failed attempt
    const { data } = await siwe.verify({ signature, nonce: siwe.nonce, domain: process.env.SIWE_DOMAIN });
    signer = data.address;
  } catch {
    return res.status(401).json({ code: "BAD_SIGNATURE" });
  }

    // 2. Which identity does this key control *right now*? Read live from ERC-1056.
  const identityId: bigint = await contracts.identity.byController(signer);
  if (identityId === 0n) return res.status(401).json({ code: "IDENTITY_NOT_FOUND" });

  const record = await contracts.identity.identities(identityId);
  const liveOwner: string = await contracts.didRegistry.identityOwner(record.did);
  if (liveOwner.toLowerCase() !== signer.toLowerCase()) {
    return res.status(401).json({ code: "IDENTITY_NOT_FOUND" }); // rotated-away key
  }

    // 3. Status and tenure
  if (!(await contracts.identity.isActive(identityId))) {
    const status = Number(record.status);
    if (status === STATUS.SUSPENDED) return res.status(423).json({ code: "IDENTITY_SUSPENDED" });
    if (status === STATUS.REVOKED) return res.status(403).json({ code: "IDENTITY_REVOKED" });
    return res.status(403).json({ code: "IDENTITY_EXPIRED" });
  }

    // 4. Authorization context, only after authentication has passed
  const balances: bigint[] = await Promise.all(
    ROLE_IDS.map((r) => contracts.roles.balanceOf(signer, r))
  );
  const roles = ROLE_IDS.filter((_, i) => balances[i] > 0n);

  const session = {
    identityId: identityId.toString(),
    address: signer,
    did: `did:ethr:${record.did}`,
    roles,
    clearance: Number(record.clearance),
  };
  const token = jwt.sign(session, jwtSecret(), { expiresIn: "15m" });
  res.json({ token, session });
});

router.get("/me", requireAuth, (req, res) => res.json(req.user));

export default router;
