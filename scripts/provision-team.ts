import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import {
  signRegister,
  empCommitment,
  FAR_FUTURE,
  ROLE
} from "./constants";

async function main() {
  if (network.name !== "sepolia") {
    throw new Error("This script is for Sepolia only. Use --network sepolia");
  }

  const dep = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", "sepolia.json"), "utf8")
  );

  const [deployer] = await ethers.getSigners();
  console.log("Admin (Deployer):", deployer.address);

  const identity = await ethers.getContractAt("ArgusIdentity", dep.contracts.ArgusIdentity);
  const roles = await ethers.getContractAt("RoleRegistry", dep.contracts.RoleRegistry);

  // Generate 4 new wallets for the rest of the team
  const manager = ethers.Wallet.createRandom().connect(ethers.provider);
  const auditor = ethers.Wallet.createRandom().connect(ethers.provider);
  const user = ethers.Wallet.createRandom().connect(ethers.provider);
  const officer = ethers.Wallet.createRandom().connect(ethers.provider);

  const team = [
    { name: "Manager", wallet: manager, role: ROLE.MANAGER },
    { name: "Auditor", wallet: auditor, role: ROLE.AUDITOR },
    { name: "User", wallet: user, role: ROLE.USER },
    { name: "Security Officer", wallet: officer, role: ROLE.SECURITY_OFFICER }
  ];

  console.log("\n--- Provisioning new identities ---");
  for (let i = 0; i < team.length; i++) {
    const p = team[i];
    console.log(`\nRegistering ${p.name}...`);
    
    // Check if by any chance the deployer is the only one
    const emp = empCommitment(`TEAM-00${i+2}`, "arguschain-sepolia");
    const clearance = 1; // RESTRICTED
    const validUntil = FAR_FUTURE;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = await identity.nonces(p.wallet.address);

    const sig = await signRegister(
      p.wallet,
      identity,
      p.wallet.address,
      emp,
      clearance,
      validUntil,
      nonce,
      deadline
    );

    // Admin submits the transaction and pays the gas
    const tx = await identity.registerIdentity(
      p.wallet.address,
      emp,
      clearance,
      validUntil,
      deadline,
      sig
    );
    await tx.wait();
    
    const newId = await identity.byController(p.wallet.address);
    console.log(`✅ ${p.name} registered as Identity #${newId}`);

    // Grant role token
    const roleTx = await roles.grantRoleToken(p.wallet.address, p.role);
    await roleTx.wait();
    console.log(`✅ Granted ${p.name} role token`);
    
    if (p.role === ROLE.SECURITY_OFFICER) {
      const boostTx = await identity.bootstrapClearance(newId, 4); // TOP_SECRET
      await boostTx.wait();
      console.log(`✅ Bootstrapped Security Officer to TOP_SECRET`);
    }
  }

  console.log("\n=======================================================");
  console.log("🎉 TEAM PROVISIONED SUCCESSFULLY!");
  console.log("No redeployment was necessary. Import these private keys into MetaMask:");
  console.log("=======================================================\n");

  team.forEach(p => {
    console.log(`${p.name} Private Key: ${p.wallet.privateKey}`);
    console.log(`Address: ${p.wallet.address}\n`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
