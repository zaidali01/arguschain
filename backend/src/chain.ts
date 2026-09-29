import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const BACKEND_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, "..");
const NETWORK = process.env.CHAIN_NETWORK || "localhost";

const deployment = JSON.parse(
  fs.readFileSync(path.join(PROJECT_ROOT, "deployments", `${NETWORK}.json`), "utf8")
);

const CONTRACT_NAMES = [
  "EthereumDIDRegistry",
  "ArgusIdentity",
  "RoleRegistry",
  "AssetNFT",
  "AccessRegistry",
  "GrantWorkflow",
  "AuditAnchor",
] as const;

function abiOf(name: string) {
  // Use pre-extracted ABIs committed in backend/abis/
  const file = path.join(BACKEND_ROOT, "abis", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");

const at = (name: string) => new ethers.Contract(deployment.contracts[name], abiOf(name), provider);

export const contracts = {
  didRegistry: at("EthereumDIDRegistry"),
  identity: at("ArgusIdentity"),
  roles: at("RoleRegistry"),
  assets: at("AssetNFT"),
  access: at("AccessRegistry"),
  workflow: at("GrantWorkflow"),
  audit: at("AuditAnchor"),
};

export const addresses = deployment.contracts; // the frontend will need these too
export const startBlock: number = deployment.startBlock ?? 0;