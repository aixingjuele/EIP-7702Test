const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  const recipient = process.env.RECIPIENT_ADDRESS;
  if (!recipient) throw new Error('RECIPIENT_ADDRESS missing');

  const tokenDeploymentPath = path.join(__dirname, '../deployments', `token-${network.name}.json`);
  if (!fs.existsSync(tokenDeploymentPath)) throw new Error('Token deployment file not found');
  const tokenInfo = JSON.parse(fs.readFileSync(tokenDeploymentPath, 'utf8'));
  const tokenAddress = tokenInfo.address;

  const token = await ethers.getContractAt('AuthorizationERC20Delegation', tokenAddress);

  const value = ethers.parseUnits('25', 18); // transfer 25 ADT
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60; // already valid
  const validBefore = now + 3600; // valid for 1h
  const nonceBytes = ethers.randomBytes(32);
  const nonce = ethers.hexlify(nonceBytes);

  // EIP712 domain
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: await token.name(),
    version: '1',
    chainId,
    verifyingContract: tokenAddress
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' }
    ]
  };

  const message = {
    from: wallet.address,
    to: recipient,
    value,
    validAfter,
    validBefore,
    nonce
  };

  // Sign typed data (ethers v6)
  const signature = await wallet.signTypedData(domain, types, message);
  const sigObj = ethers.Signature.from(signature);

  console.log('Signature:', signature);
  console.log('v:', sigObj.v, 'r:', sigObj.r, 's:', sigObj.s);
  console.log('nonce:', nonce);

  const tx = await token.transferWithAuthorization(
    wallet.address,
    recipient,
    value,
    validAfter,
    validBefore,
    nonce,
    sigObj.v,
    sigObj.r,
    sigObj.s
  );
  console.log('Sent transferWithAuthorization tx:', tx.hash);
  const receipt = await tx.wait();
  console.log('Mined in block', receipt.blockNumber);

  const balanceRecipient = await token.balanceOf(recipient);
  console.log('Recipient balance after:', balanceRecipient.toString());
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
