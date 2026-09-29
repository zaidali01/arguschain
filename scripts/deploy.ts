import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer, relayer, oracle] = await ethers.getSigners();
  const admin = deployer.address;
  const relayerAddr = (relayer ?? deployer).address;

  console.log(`network : ${network.name}`);
  console.log(`deployer: ${admin}`);
  console.log(`relayer : ${relayerAddr}`);

  const didRegistry = await (await ethers.getContractFactory("EthereumDIDRegistry")).deploy();
  await didRegistry.waitForDeployment();

  const roles = await (await ethers.getContractFactory("RoleRegistry")).deploy(admin);
  await roles.waitForDeployment();

  const identity = await (
    await ethers.getContractFactory("ArgusIdentity")
  ).deploy(await didRegistry.getAddress(), await roles.getAddress(), admin);
  await identity.waitForDeployment();

  const assets = await (
    await ethers.getContractFactory("AssetNFT")
  ).deploy(await identity.getAddress(), await roles.getAddress(), admin);
  await assets.waitForDeployment();

  const access = await (
    await ethers.getContractFactory("AccessRegistry")
  ).deploy(await identity.getAddress(), await roles.getAddress(), await assets.getAddress(), admin);
  await access.waitForDeployment();

  const workflow = await (
    await ethers.getContractFactory("GrantWorkflow")
  ).deploy(
    await identity.getAddress(),
    await roles.getAddress(),
    await assets.getAddress(),
    await access.getAddress(),
    admin
  );
  await workflow.waitForDeployment();

  const audit = await (await ethers.getContractFactory("AuditAnchor")).deploy(admin);
  await audit.waitForDeployment();

  // ---- wiring: the part that silently breaks everything if missed ----
  await (await assets.setAuthorizer(await access.getAddress())).wait();
  await (await access.grantRole(await access.ASSET_SEEDER_ROLE(), await assets.getAddress())).wait();

  await (await access.grantRole(await access.GRANT_EXECUTOR_ROLE(), await workflow.getAddress())).wait();
  await (await assets.grantRole(await assets.GRANT_EXECUTOR_ROLE(), await workflow.getAddress())).wait();
  await (await identity.grantRole(await identity.GRANT_EXECUTOR_ROLE(), await workflow.getAddress())).wait();
  await (await roles.grantRole(await roles.GRANT_EXECUTOR_ROLE(), await workflow.getAddress())).wait();

  // relayer: may submit ACL writes and workflow actions on a user's behalf
  // after the gateway PDP has run and a step-up signature has been verified
  await (await access.grantRole(await access.ACL_WRITER_ROLE(), relayerAddr)).wait();
  await (await workflow.grantRole(await workflow.RELAYER_ROLE(), relayerAddr)).wait();
  await (await audit.grantRole(await audit.ANCHOR_ROLE(), relayerAddr)).wait();

  // ---- bootstrap the first Admin, then the deployer renounces its own key ----
  const userMetamask = admin;
  
  // 1. Give the user's address the ERC-1155 Admin Role Token (gives platform powers)
  await (await roles.bootstrap(userMetamask)).wait();
  
  // 2. Grant the user's address DEFAULT_ADMIN_ROLE across all contracts
  await (await roles.grantRole(await roles.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();
  await (await identity.grantRole(await identity.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();
  await (await assets.grantRole(await assets.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();
  await (await access.grantRole(await access.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();
  await (await workflow.grantRole(await workflow.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();
  await (await audit.grantRole(await audit.DEFAULT_ADMIN_ROLE(), userMetamask)).wait();

  console.log("bootstrapped first Admin ->", userMetamask);
  console.log("Granted DEFAULT_ADMIN_ROLE on all contracts to ->", userMetamask);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    deployer: admin,
    relayer: relayerAddr,
    oracle: oracle ? oracle.address : undefined,
    contracts: {
      EthereumDIDRegistry: await didRegistry.getAddress(),
      RoleRegistry: await roles.getAddress(),
      ArgusIdentity: await identity.getAddress(),
      AssetNFT: await assets.getAddress(),
      AccessRegistry: await access.getAddress(),
      GrantWorkflow: await workflow.getAddress(),
      AuditAnchor: await audit.getAddress(),
    },
    startBlock: await ethers.provider.getBlockNumber(),
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.contracts, null, 2));
  console.log(`\nwritten -> deployments/${network.name}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
