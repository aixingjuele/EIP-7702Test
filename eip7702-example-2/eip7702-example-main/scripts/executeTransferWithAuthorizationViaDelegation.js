const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// This script combines EIP-3009 style transferWithAuthorization with an EIP-7702 delegated code
// transaction that loads BatchCallDelegation as the EOA temporary code and calls execute() with
// a single transferWithAuthorization call.

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  const recipient = process.env.RECIPIENT_ADDRESS;
  if (!recipient) throw new Error('RECIPIENT_ADDRESS missing');

  // Load deployments
  const batchDeploymentPath = path.join(__dirname, '../deployments', `${network.name}.json`);
  if (!fs.existsSync(batchDeploymentPath)) throw new Error('BatchCallDelegation deployment file missing');
  const batchInfo = JSON.parse(fs.readFileSync(batchDeploymentPath, 'utf8'));
  const batchAddress = batchInfo.contractAddress;

  const tokenDeploymentPath = path.join(__dirname, '../deployments', `token-${network.name}.json`);
  if (!fs.existsSync(tokenDeploymentPath)) throw new Error('Token deployment file missing');
  const tokenInfo = JSON.parse(fs.readFileSync(tokenDeploymentPath, 'utf8'));
  const tokenAddress = tokenInfo.address;

  const token = await ethers.getContractAt('AuthorizationERC20Delegation', tokenAddress);

  // Prepare authorization for token transfer
  const value = ethers.parseUnits('10', 18);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 30;
  const validBefore = now + 1800; // 30 min
  const nonceBytes = ethers.randomBytes(32);
  const nonce = ethers.hexlify(nonceBytes);

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = { name: await token.name(), version: '1', chainId, verifyingContract: tokenAddress };
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
  const message = { from: wallet.address, to: recipient, value, validAfter, validBefore, nonce };
  const signature = await wallet.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(signature);

  // Encode token transferWithAuthorization call
  const tokenInterface = new ethers.Interface([
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)'
  ]);
  const encodedTokenCall = tokenInterface.encodeFunctionData('transferWithAuthorization', [
    wallet.address,
    recipient,
    value,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s
  ]);

  // Prepare BatchCallDelegation call payload
  const batchInterface = new ethers.Interface([
    'function execute(tuple(bytes data, address to, uint256 value)[] calls)'
  ]);
  const calls = [{ data: encodedTokenCall, to: tokenAddress, value: 0n }];
  const calldata = batchInterface.encodeFunctionData('execute', [calls]);

  // Build EIP-7702 transaction (type 0x04) with authorization delegating code to BatchCallDelegation
  const currentNonce = await ethers.provider.getTransactionCount(wallet.address);
  const auth = {
    chainId: ethers.toBeHex(chainId),
    address: batchAddress, // delegate code address
    nonce: ethers.toBeHex(currentNonce + 1) // future nonce for delegation
  };

  const encodedAuth = ethers.concat([
    '0x05',
    ethers.encodeRlp([auth.chainId, auth.address, auth.nonce])
  ]);
  const authHash = ethers.keccak256(encodedAuth);
  const authSig = wallet.signingKey.sign(authHash);
  const yParityAuth = authSig.yParity === 0 ? '0x' : '0x01';

  const feeData = await ethers.provider.getFeeData();
  let maxPriority = ethers.toBeHex(feeData.maxPriorityFeePerGas);
  maxPriority = maxPriority === '0x00' ? '0x' : maxPriority;

  const txData = [
    auth.chainId, // chainId
    ethers.toBeHex(currentNonce), // nonce for the main tx
    maxPriority, // maxPriorityFeePerGas
    ethers.toBeHex(feeData.maxFeePerGas), // maxFeePerGas
    ethers.toBeHex(1_500_000), // gas limit estimate
    wallet.address, // from
    '0x', // value
    calldata, // data (calling execute on batch)
    [], // access list
    [ // authorizations list
      [auth.chainId, auth.address, auth.nonce, yParityAuth, authSig.r, authSig.s]
    ]
  ];

  const encodedTxData = ethers.concat(['0x04', ethers.encodeRlp(txData)]);
  const txHash = ethers.keccak256(encodedTxData);
  const mainSig = wallet.signingKey.sign(txHash);
  const yParityMain = mainSig.yParity === 0 ? '0x' : '0x01';

  const signedRaw = ethers.hexlify(ethers.concat([
    '0x04',
    ethers.encodeRlp([...txData, yParityMain, mainSig.r, mainSig.s])
  ]));

  console.log('--- Prepared Delegated Authorization Transfer ---');
  console.log('Token:', tokenAddress);
  console.log('BatchCallDelegation:', batchAddress);
  console.log('Recipient:', recipient);
  console.log('Authorization nonce (token):', nonce);
  console.log('Delegation nonce (tx):', auth.nonce);

  const sentHash = await ethers.provider.send('eth_sendRawTransaction', [signedRaw]);
  console.log('Sent 0x04 tx hash:', sentHash);

  // Wait for receipt polling
  let receipt = null;
  while (!receipt) {
    receipt = await ethers.provider.getTransactionReceipt(sentHash);
    if (!receipt) await new Promise(r => setTimeout(r, 5000));
  }
  console.log('Mined in block', receipt.blockNumber);

  const bal = await token.balanceOf(recipient);
  console.log('Recipient balance after delegated transfer:', bal.toString());
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
