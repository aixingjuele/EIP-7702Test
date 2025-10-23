const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  const Token = await ethers.getContractFactory('AuthorizationERC20Delegation', wallet);

  // Initial supply: 1,000,000 tokens (18 decimals)
  const initialSupply = ethers.parseUnits('1000000', 18);
  console.log('Deploying AuthorizationERC20Delegation ...');
  const token = await Token.deploy('AuthDelegationToken', 'ADT', 18, initialSupply);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log('Token deployed at:', tokenAddress);

  // Persist deployment info (separate file from batch contract)
  const deploymentsDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const filePath = path.join(deploymentsDir, `token-${network.name}.json`);
  const info = {
    address: tokenAddress,
    deployer: wallet.address,
    network: network.name,
    time: new Date().toISOString()
  };
  fs.writeFileSync(filePath, JSON.stringify(info, null, 2));
  console.log('Saved token deployment to', filePath);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
