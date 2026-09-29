import { Router } from "express";
import multer from "multer";
import { ethers } from "ethers";
import { contracts } from "../chain";
import { requireAuth } from "../middleware/auth";
import { authorize } from "../pdp";
import { P } from "../constants";
import { encryptAndStore, loadAndDecrypt, sha256 } from "../storage";
import { logDecision, prisma } from "../audit";
import { scoreRequest } from "../risk";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const BITS: [string, number][] = [
  ["P_LIST", P.LIST], ["P_READ_META", P.READ_META], ["P_READ", P.READ], ["P_DOWNLOAD", P.DOWNLOAD],
  ["P_WRITE", P.WRITE], ["P_SHARE", P.SHARE], ["P_ADMIN", P.ADMIN], ["P_AUDIT", P.AUDIT],
];
const idOf = (raw: any) => (/^\d+$/.test(String(raw)) ? String(raw) : null);
const resourceOf = (tokenId: string) => ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
const principalOf = (identityId: string) => ethers.solidityPackedKeccak256(
  ["uint8", "uint256"], [1, BigInt(identityId)]
);

router.get("/", requireAuth, async (req, res) => {
  const total = Number(await contracts.assets.totalMinted());
  const out = [];
  for (let id = 1; id <= total; id++) {
    const d = await authorize(req.user!, String(id), P.LIST);
    if (!d.allow) continue; // invisible: more than one level above clearance
    const a = await contracts.assets.assets(id);
    const file = await prisma.storedFile.findUnique({ where: { tokenId: String(id) } });
    out.push({
      tokenId: String(id),
      name: file?.name ?? `asset-${id}`,
      classification: Number(a.classification),
      ownerIdentity: a.ownerIdentity.toString(),
      version: Number(a.version),
      effective: `0x${d.effective.toString(16).padStart(2, "0")}`,
      locked: d.effective === P.LIST, // greyed entry, request-access only
    });
  }
  res.json(out);
});

// The access editor needs a compact, current list of identities without
// exposing employee commitments or other credential data.
router.get("/identities", requireAuth, async (_req, res) => {
  const total = Number(await contracts.identity.totalIssued());
  const identities = await Promise.all(Array.from({ length: total }, async (_, index) => {
    const identityId = BigInt(index + 1);
    const record = await contracts.identity.identities(identityId);
    return {
      identityId: identityId.toString(),
      controller: await contracts.identity.controllerOf(identityId),
      clearance: Number(record.clearance),
      active: await contracts.identity.isActive(identityId),
    };
  }));
  res.json(identities);
});

/** Relayed direct grant for PUBLIC/RESTRICTED assets. The gateway first checks
 * the caller's live P_ADMIN permission; the contract independently refuses
 * CONFIDENTIAL+ assets, which must use GrantWorkflow. */
router.post("/:id/access", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });

  const { targetIdentity, allowMask = 0, denyMask = 0, expiresAt = 0, reason } = req.body ?? {};
  const target = idOf(targetIdentity);
  const validMask = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
  if (!target || !validMask(allowMask) || !validMask(denyMask) || typeof reason !== "string" || !reason.trim()) {
    return res.status(422).json({ code: "BAD_REQUEST", detail: "Choose an identity, permissions, and a written reason." });
  }
  if (target === req.user!.identityId) return res.status(422).json({ code: "BAD_REQUEST", detail: "You cannot grant permissions to yourself." });
  if (!Number.isInteger(expiresAt) || expiresAt < 0) return res.status(422).json({ code: "BAD_REQUEST", detail: "Expiry must be a valid date." });

  const decision = await authorize(req.user!, tokenId, P.ADMIN);
  if (!decision.allow) return res.status(decision.status).json({ code: decision.code, detail: decision.detail });
  if (!(await contracts.identity.isActive(target))) return res.status(422).json({ code: "IDENTITY_INACTIVE" });
  if (Number(await contracts.assets.classificationOf(tokenId)) >= 2) {
    return res.status(409).json({ code: "REQUIRES_WORKFLOW", detail: "CONFIDENTIAL and higher grants require a proposal and approvals." });
  }

  const relayerKey = process.env.ACL_RELAYER_PRIVATE_KEY;
  if (!relayerKey) return res.status(503).json({ code: "ACL_RELAY_UNAVAILABLE" });
  try {
    const relayer = new ethers.Wallet(relayerKey, contracts.access.runner!.provider!);
    const tx = await (contracts.access.connect(relayer) as any).setAce(
      resourceOf(tokenId), principalOf(target), allowMask, denyMask, 0, expiresAt, 0,
      BigInt(req.user!.identityId), ethers.keccak256(ethers.toUtf8Bytes(reason.trim()))
    );
    const receipt = await tx.wait();
    res.status(201).json({ ok: true, txHash: receipt.hash });
  } catch (error: any) {
    res.status(400).json({ code: "ACCESS_GRANT_FAILED", detail: error.shortMessage || error.message });
  }
});

router.get("/:id", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });

  const d = await authorize(req.user!, tokenId, P.READ_META);
  // An Admin is deliberately seeded with LIST + ADMIN, not READ_META. Let
  // that role reach the ACL editor without widening its effective permissions
  // or exposing the file name, hash, size, or MIME type.
  if (!d.allow) {
    const [admin, audit] = await Promise.all([
      authorize(req.user!, tokenId, P.ADMIN), authorize(req.user!, tokenId, P.AUDIT),
    ]);
    if (!admin.allow && !audit.allow) return res.status(d.status).json({ code: d.code, detail: d.detail });
    const a = await contracts.assets.assets(tokenId);
    return res.json({
      tokenId, name: null, size: null, mimeType: null, contentHash: null,
      classification: Number(a.classification), version: Number(a.version),
      ownerIdentity: a.ownerIdentity.toString(), effective: `0x${d.effective.toString(16).padStart(2, "0")}`,
      metadataRestricted: true,
    });
  }

  const a = await contracts.assets.assets(tokenId);
  const file = await prisma.storedFile.findUnique({ where: { tokenId } });
  res.json({
    tokenId, name: file?.name, size: file?.size, mimeType: file?.mimeType,
    contentHash: a.contentHash, classification: Number(a.classification),
    version: Number(a.version), ownerIdentity: a.ownerIdentity.toString(),
    effective: `0x${d.effective.toString(16).padStart(2, "0")}`,
    metadataRestricted: false,
  });
});

router.get("/:id/effective", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });

  const d = await authorize(req.user!, tokenId, P.LIST);
  res.json({
    tokenId, identityId: req.user!.identityId, clearance: req.user!.clearance,
    classification: Number(await contracts.assets.classificationOf(tokenId)),
    effective: `0x${d.effective.toString(16).padStart(2, "0")}`,
    denialCode: d.allow ? null : d.code,
    bits: BITS.map(([name, bit]) => ({ name, granted: (d.effective & bit) !== 0 })),
  });
});
router.get("/:id/acl", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });

  const d = await authorize(req.user!, tokenId, P.ADMIN);
  const audit = await authorize(req.user!, tokenId, P.AUDIT);
  if (!d.allow && !audit.allow) return res.status(403).json({ code: "NO_ACL_ACCESS" });

  const resourceId = "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  const principals: string[] = await contracts.access.principalsOnResource(resourceId);
  const entries = await Promise.all(principals.map(async (p) => {
    const ace = await contracts.access.getAce(resourceId, p);
    return {
      principal: p,
      allow: `0x${Number(ace.allowMask).toString(16).padStart(2, "0")}`,
      deny: `0x${Number(ace.denyMask).toString(16).padStart(2, "0")}`,
      expiresAt: Number(ace.expiresAt) || null,
      grantedBy: ace.grantedBy.toString(),
      justificationHash: ace.justificationHash,
    };
  }));
  res.json(entries);
});
router.post("/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.user!.roles.includes(1)) return res.status(403).json({ code: "NOT_ADMIN" });
  if (!req.file) return res.status(400).json({ code: "NO_FILE" });

  const { contentHash, storagePath, wrappedDek } = encryptAndStore(req.file.buffer);
  res.json({
    contentHash, storagePath, wrappedDek,
    name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size,
    next: "Sign the mint transaction with this contentHash, then POST /assets/:id/link",
  });
});

/// Called after the mint transaction confirms, to bind the tokenId to the stored file.
router.post("/:id/link", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });

  const onChain = await contracts.assets.assets(tokenId);
  if (onChain.contentHash.toLowerCase() !== String(req.body.contentHash).toLowerCase()) {
    return res.status(409).json({ code: "HASH_MISMATCH" }); // the chain is the authority
  }
  const { name, mimeType, size, contentHash, storagePath, wrappedDek } = req.body;
    const row = { tokenId, name, mimeType, size, contentHash, storagePath, wrappedDek };
  await prisma.storedFile.upsert({ where: { tokenId }, update: row, create: row });
  res.json({ ok: true });
});
router.get("/:id/content", requireAuth, async (req, res) => {
  const tokenId = idOf(req.params.id);
  if (!tokenId) return res.status(400).json({ code: "BAD_TOKEN_ID" });
  const identityId = req.user!.identityId;
  const wantsDownload = req.query.download === "1";

  const d = await authorize(req.user!, tokenId, wantsDownload ? P.DOWNLOAD : P.READ);
  if (!d.allow) {
    await logDecision({ identityId, tokenId, action: "READ", reasonCode: d.code });
    return res.status(d.status).json({ code: d.code, detail: d.detail });
  }

  const risk = await scoreRequest(identityId, tokenId);
  if (risk.score > 80) {
    await logDecision({ identityId, tokenId, action: "READ", reasonCode: "ANOMALY_SCORE_HIGH", riskScore: risk.score, reasons: risk.reasons });
    return res.status(403).json({ code: "ANOMALY_SCORE_HIGH", risk });
  }
  if (risk.score > 40 && req.headers["x-step-up"] !== "verified") {
    await logDecision({ identityId, tokenId, action: "READ", reasonCode: "STEP_UP_REQUIRED", riskScore: risk.score, reasons: risk.reasons });
    return res.status(401).json({ code: "STEP_UP_REQUIRED", risk });
  }

  const file = await prisma.storedFile.findUnique({ where: { tokenId } });
  if (!file) return res.status(404).json({ code: "FILE_NOT_STORED" });

    const onChainHash = (await contracts.assets.assets(tokenId)).contentHash;

  // Two ways a tampered file shows up: the GCM auth tag fails (bytes changed in
  // place), or it decrypts but the plaintext hash no longer matches the chain
  // (the whole object was swapped). Both are the same incident.
  let plaintext: Buffer;
  try {
    plaintext = loadAndDecrypt(file.storagePath, file.wrappedDek);
    } catch (e: any) {
    const missing = e?.code === "ENOENT"; // storage gone, not altered: a different incident
    const code = missing ? "FILE_NOT_STORED" : "TAMPER_DETECTED";
    await logDecision({ identityId, tokenId, action: "READ", reasonCode: code });
    return res.status(missing ? 404 : 409).json({
      code,
      detail: missing ? "No stored ciphertext for this asset." : "Stored ciphertext failed integrity check.",
    });
  }
  if (sha256(plaintext).toLowerCase() !== onChainHash.toLowerCase()) {
    await logDecision({ identityId, tokenId, action: "READ", reasonCode: "TAMPER_DETECTED" });
    return res.status(409).json({ code: "TAMPER_DETECTED", detail: "File hash does not match the on-chain hash." });
  }

  await logDecision({ identityId, tokenId, action: "READ", reasonCode: "ALLOW", riskScore: risk.score, reasons: risk.reasons });
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("X-Content-Hash", onChainHash);
  res.setHeader("X-Risk-Score", String(risk.score));
  if (wantsDownload) res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
  res.send(plaintext);
});

export default router;
