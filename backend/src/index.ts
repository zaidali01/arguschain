import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(cors());
app.use(morgan("dev"));
app.use(express.json());

import authRoutes from "./controllers/auth";
import assetRoutes from "./controllers/assets";
import auditRoutes from "./controllers/audit";
import proposalRoutes from "./controllers/proposals";
import { contracts, provider, addresses } from "./chain";
import { prisma } from "./audit";
import { requireAuth } from "./middleware/auth";

// Routes
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/health/chain", async (_req, res) => {
  try {
    const [block, minted, issued] = await Promise.all([
      provider.getBlockNumber(),
      contracts.assets.totalMinted(),
      contracts.identity.totalIssued(),
    ]);
    res.json({ block, assets: Number(minted), identities: Number(issued) });
  } catch (e: any) {
    res.status(503).json({ code: "CHAIN_UNAVAILABLE", detail: e?.shortMessage || e?.message });
  }
});
// The browser signs its own mint transactions, so it needs the addresses.
// Addresses are public on chain; no secret leaves the server here.
app.get("/config", (_req, res) => {
  const deployment = require("fs").readFileSync(require("path").join(__dirname, "../..", "deployments", `${process.env.CHAIN_NETWORK || "localhost"}.json`), "utf8");
  console.log("Config requested. CHAIN_NETWORK:", process.env.CHAIN_NETWORK, "AssetNFT:", JSON.parse(deployment).contracts.AssetNFT);
  res.json({ contracts: addresses, chainId: JSON.parse(deployment).chainId });
});

console.log("BOOTING. CHAIN_NETWORK:", process.env.CHAIN_NETWORK);
console.log("RPC_URL:", process.env.RPC_URL);
console.log("Addresses currently loaded in chain.ts:", addresses);

app.get("/decisions", requireAuth, async (_req, res) => {
  const rows = await prisma.decision.findMany({ orderBy: { id: "desc" }, take: 100 });
  res.json(rows.map((d) => ({ ...d, reasons: JSON.parse(d.reasons) })));
});

app.use("/auth", authRoutes);
app.use("/assets", assetRoutes);
app.use("/audit", auditRoutes);
app.use("/proposals", proposalRoutes);

app.use((_req, res) => res.status(404).json({ code: "NOT_FOUND" }));

// Every refusal in this system carries its own reason code, so an unexpected
// throw must not degrade into a bodyless 500 that reads like a policy decision.
app.use((err: any, _req: any, res: any, _next: any) => {
  const status = typeof err?.status === "number" ? err.status : 500;
  if (status === 400 && err?.type === "entity.parse.failed") {
    return res.status(400).json({ code: "BAD_REQUEST", detail: "Malformed JSON body." });
  }
  if (status < 500) {
    return res.status(status).json({ code: err?.code || "BAD_REQUEST", detail: err?.message });
  }
  console.error("[unhandled]", err?.stack || err);
  const chainy = /network|ECONN|ETIMEDOUT|socket|json-rpc|missing response|insufficient funds/i.test(
    `${err?.code || ""} ${err?.message || ""}`
  );
  return res.status(503).json({
    code: chainy ? "CHAIN_UNAVAILABLE" : "INTERNAL_ERROR",
    detail: err?.shortMessage || err?.message,
  });
});

app.listen(PORT, () => {
  console.log(`[PEP API] ArgusChain v4 backend running on http://localhost:${PORT}`);
});
