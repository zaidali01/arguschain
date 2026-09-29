/**
 * provision-sepolia-admin.ts
 *
 * Registers the deployer wallet as an identity in the live Sepolia deployment
 * of ArgusChain. Run this once after deploy:sepolia if the admin identity is
 * not yet registered.
 *
 * Usage:
 *   npx hardhat run scripts/provision-sepolia-admin.ts --network sepolia
 */

import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import {
  signRegister,
  empCommitment,
  FAR_FUTURE,
} from "./constants";

async function main() {
  if (network.name !== "sepolia") {
    throw new Error("This script is for Sepolia only. Use --network sepolia");
  }

  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")
  );

  const [deployer] = await ethers.getSigners();
  console.log("Deployer / Admin:", deployer.address);
  console.log("Network:", network.name);

  const identity = await ethers.getContractAt("ArgusIdentity", dep.contracts.ArgusIdentity);

  // Check if already registered
  const existing = await identity.byController(deployer.address);
  if (existing !== 0n) {
    console.log(`✅ Identity already registered! Identity ID: ${existing}`);
    return;
  }

  // Build the registration parameters
  // IMPORTANT: DIRECT_REGISTER_CEILING = 1 (RESTRICTED). We must register at
  // clearance ≤ 1, then call bootstrapClearance to elevate to TOP_SECRET.
  const did = deployer.address;
  const empHash = empCommitment("ADMIN-001", "arguschain-sepolia-admin");
  const clearance = 1; // RESTRICTED — max allowed by registerIdentity directly
  const validUntil = FAR_FUTURE;

  const nonce = await identity.nonces(did);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

  console.log("\nSigning EIP-712 registration message...");
  const sig = await signRegister(
    deployer,
    identity,
    did,
    empHash,
    clearance,
    validUntil,
    nonce,
    deadline
  );

  console.log("Submitting registerIdentity transaction (clearance=RESTRICTED)...");
  const tx = await identity.registerIdentity(
    did,
    empHash,
    clearance,
    validUntil,
    deadline,
    sig
  );
  const receipt = await tx.wait();
  console.log(`✅ Identity registered! Tx: ${receipt?.hash}`);

  // Confirm
  const newId = await identity.byController(deployer.address);
  console.log(`   Identity ID: ${newId}`);
  console.log(`   Initial Clearance: RESTRICTED (1)`);

  // Elevate to TOP_SECRET using bootstrapClearance (requires DEFAULT_ADMIN_ROLE which deployer holds)
  console.log("\nElevating clearance to TOP_SECRET via bootstrapClearance...");
  const tx2 = await identity.bootstrapClearance(newId, 4);
  await tx2.wait();
  console.log(`✅ Clearance elevated to TOP_SECRET (4)`);
  console.log(`\n🎉 You can now sign in at http://localhost:5173 with your wallet!`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
