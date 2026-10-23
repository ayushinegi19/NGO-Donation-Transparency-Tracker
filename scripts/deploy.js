const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const signers = await hre.ethers.getSigners();

  // Roles in the local demo (see README): #0 owner/admin, #1 NGO, #3 donor, #4 recipient (supplier).
  // The contract is deployed by account #19, which is never imported into MetaMask. That way the
  // accounts you use in MetaMask never send transactions outside it, so MetaMask's transaction
  // counter (nonce) never goes out of date ("nonce has already been used").
  const deployer = signers[19];
  const owner = signers[0];

  const tracker = await hre.ethers.deployContract("NGODonationTracker", [owner.address], deployer);
  await tracker.waitForDeployment();

  const address = await tracker.getAddress();
  console.log(`NGODonationTracker deployed to: ${address}`);
  console.log(`Deployed by account #19 ${deployer.address}`);
  console.log(`Owner (admin):        #0  ${owner.address}`);

  // Save address + ABI so the frontend can connect to the deployed contract
  const artifact = await hre.artifacts.readArtifact("NGODonationTracker");
  const config = { address, abi: artifact.abi };
  const outPath = path.join(__dirname, "..", "frontend", "contract-config.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(`Contract address and ABI written to ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
