import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";
import { ROLE, justify } from "./constants";

/**
 * Gives a specified wallet the Admin role and local test ETH through the
 * actual Admin-grant workflow. It is intentionally local-only: two seeded
 * approvers form the temporary test committee and the local time is advanced
 * past the TOP_SECRET approval delay. The target's clearance remains unchanged.
 */
async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("This utility may only run on a local Hardhat network.");
  }
  const wallet = process.env.DEMO_WALLET;
  if (!wallet || !ethers.isAddress(wallet)) {
    throw new Error("Set DEMO_WALLET to the full address to provision.");
  }

  const dep = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"
  ));
  const signers = await ethers.getSigners();
  const [admin, , manager, , , officer] = signers;
  const identity = await ethers.getContractAt("ArgusIdentity", dep.contracts.ArgusIdentity);
  const roles = await ethers.getContractAt("RoleRegistry", dep.contracts.RoleRegistry);
  const workflow = await ethers.getContractAt("GrantWorkflow", dep.contracts.GrantWorkflow);

  const identityId = await identity.byDid(wallet);
  if (identityId === 0n) throw new Error("Wallet has no ArgusChain identity. Register it in the app first.");

  if ((await roles.balanceOf(wallet, ROLE.ADMIN)) === 0n) {
    const adminId = await identity.byDid(admin.address);
    const managerId = await identity.byDid(manager.address);
    const officerId = await identity.byDid(officer.address);

    // The seeded officer is already TOP_SECRET. Promote the seeded manager to
    // form a second local-only TOP_SECRET approver required by this workflow.
    if ((await identity.clearanceOf(managerId)) < 4n) {
      await (await identity.connect(admin).bootstrapClearance(managerId, 4)).wait();
    }
    const pid = await workflow.connect(admin).proposeAdminGrant.staticCall(
      wallet, justify("Local demo administrator provisioning"), adminId
    );
    await (await workflow.connect(admin).proposeAdminGrant(
      wallet, justify("Local demo administrator provisioning"), adminId
    )).wait();
    await (await workflow.connect(officer).approve(pid, officerId)).wait();
    await (await workflow.connect(manager).approve(pid, managerId)).wait();
    await ethers.provider.send("evm_increaseTime", [24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);
    await (await workflow.connect(admin).execute(pid)).wait();
  }
  await (await admin.sendTransaction({ to: wallet, value: ethers.parseEther("10") })).wait();
  console.log(`Provisioned ${wallet}: Identity #${identityId}, Admin role, 10 local ETH.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
