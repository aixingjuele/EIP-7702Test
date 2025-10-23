const { ethers } = require('hardhat');
require('dotenv').config();

// This script constructs an EIP-7702 style transaction so that:
// 1. tokenHolder (no ETH) authorizes BatchCallDelegation as its temporary code.
// 2. gasPayer (has ETH) signs & sends the transaction, paying the gas.
// 3. The transaction "to" field is the tokenHolder address; its code executes BatchCallDelegation.execute.
// 4. Inside BatchCallDelegation, msg.sender == tokenHolder, so ERC20.transfer spends tokenHolder's balance.

const main = async () => {
  const tokenHolderPk = process.env.TOKEN_HOLDER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const gasPayerPk = process.env.GAS_PAYER_PRIVATE_KEY;
  const recipient = process.env.RECIPIENT_ADDRESS;
  const ERC20_TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
  const BATCH_CALL_DELEGATION_ADDRESS = process.env.BATCH_CALL_DELEGATION_ADDRESS;

  if (!tokenHolderPk || !gasPayerPk) throw new Error('Missing TOKEN_HOLDER_PRIVATE_KEY or GAS_PAYER_PRIVATE_KEY in .env');
  if (!ERC20_TOKEN_ADDRESS) throw new Error('Missing TOKEN_ADDRESS');
  if (!recipient) throw new Error('Missing RECIPIENT_ADDRESS');
  if (!BATCH_CALL_DELEGATION_ADDRESS) throw new Error('Missing BATCH_CALL_DELEGATION_ADDRESS');

  const tokenHolder = new ethers.Wallet(tokenHolderPk, ethers.provider);
  const gasPayer = new ethers.Wallet(gasPayerPk, ethers.provider);

  console.log(`Token holder: ${tokenHolder.address}`);
  console.log(`Gas payer   : ${gasPayer.address}`);
  console.log(`BatchCallDelegation contract: ${BATCH_CALL_DELEGATION_ADDRESS}`);

  // Interface for ERC20.transfer
  const erc20Interface = new ethers.Interface([
    'function transfer(address to, uint256 amount)'
  ]);

  // Set transfer amount (adjust decimals properly; here assuming 6 per previous code comment looked wrong vs 18)
  // If your token has 18 decimals change second arg to 18.
  const transferAmount = ethers.parseUnits('1.12', 6);

  // Data for ERC20 transfer (msg.sender must be tokenHolder)
  const tokenTransferData = erc20Interface.encodeFunctionData('transfer', [recipient, transferAmount]);

  // Batch interface
  const batchInterface = new ethers.Interface([
    'function execute(tuple(bytes data, address to, uint256 value)[] calls)'
  ]);

  const calls = [
    { data: tokenTransferData, to: ERC20_TOKEN_ADDRESS, value: 0 }
  ];

  // calldata that will be executed as tokenHolder's temporary code
  const calldata = batchInterface.encodeFunctionData('execute', [calls]);

  // Fetch nonces separately
  const tokenHolderNonce = await ethers.provider.getTransactionCount(tokenHolder.address);
  const gasPayerNonce = await ethers.provider.getTransactionCount(gasPayer.address);
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // Authorization for tokenHolder -> BatchCallDelegation (EIP-7702 authorization list entry)
  // Use tokenHolder's current nonce (NOT +1). Incrementing incorrectly can invalidate authorization.
  const authorizationData = {
    chainId: ethers.toBeHex(chainId),
    address: BATCH_CALL_DELEGATION_ADDRESS,
    nonce: ethers.toBeHex(tokenHolderNonce) // tokenHolder account nonce used for authorization
  };

  // Encode authorization (magic + RLP per draft spec)
  const encodedAuthorizationData = ethers.concat([
    '0x05', // MAGIC for 7702 authorization object
    ethers.encodeRlp([
      authorizationData.chainId,
      authorizationData.address,
      authorizationData.nonce,
    ])
  ]);

  // Sign authorization with tokenHolder (no gas payment, only signature)
  const authorizationDataHash = ethers.keccak256(encodedAuthorizationData);
  const authorizationSignature = tokenHolder.signingKey.sign(authorizationDataHash);
  authorizationData.yParity = authorizationSignature.yParity === 0 ? '0x' : '0x01';
  authorizationData.r = authorizationSignature.r;
  authorizationData.s = authorizationSignature.s;

  // Fee data
  const feeData = await ethers.provider.getFeeData();
  let maxPriorityFeePerGas = ethers.toBeHex(feeData.maxPriorityFeePerGas || 0n);
  maxPriorityFeePerGas = maxPriorityFeePerGas === '0x00' ? '0x' : maxPriorityFeePerGas; // per 7702 spec representation for zero tip

  // Conservative gas limit (reduce from 10,000,000). BatchCallDelegation.execute + ERC20.transfer should be < 150k.
  const gasLimit = ethers.toBeHex(300000);

  // Transaction data (type 0x04 per EIP-7702 draft): sender implicitly = gasPayer (from its signature)
  // 'to' MUST be tokenHolder address whose code will be overridden by authorization entry.
  const txData = [
    ethers.toBeHex(chainId),
    ethers.toBeHex(gasPayerNonce), // transaction nonce of gasPayer
    maxPriorityFeePerGas,
    ethers.toBeHex(feeData.maxFeePerGas),
    gasLimit,
    tokenHolder.address, // to = tokenHolder (executes authorized code)
    '0x', // value
    calldata, // input
    [], // accessList
    [ // authorization list (array of authorizations)
      [
        authorizationData.chainId,
        authorizationData.address,
        authorizationData.nonce,
        authorizationData.yParity,
        authorizationData.r,
        authorizationData.s
      ]
    ]
  ];

  console.log('txData (pre-sign) =======================================');
  console.dir(txData, { depth: null });
  console.log('==========================================================');

  const encodedTxData = ethers.concat([
    '0x04', // transaction type identifier for 7702
    ethers.encodeRlp(txData)
  ]);

  // Sign transaction with GAS PAYER (this pays the gas)
  const txDataHash = ethers.keccak256(encodedTxData);
  const txSignature = gasPayer.signingKey.sign(txDataHash);

  const signedTx = ethers.hexlify(ethers.concat([
    '0x04',
    ethers.encodeRlp([
      ...txData,
      txSignature.yParity === 0 ? '0x' : '0x01',
      txSignature.r,
      txSignature.s
    ])
  ]));

  // Pre-flight: token balance of tokenHolder
  const erc20Contract = new ethers.Contract(ERC20_TOKEN_ADDRESS, [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
  ], ethers.provider);

  const [balance, decimals, symbol] = await Promise.all([
    erc20Contract.balanceOf(tokenHolder.address),
    erc20Contract.decimals(),
    erc20Contract.symbol()
  ]);

  console.log(`Current ${symbol} balance of tokenHolder: ${ethers.formatUnits(balance, decimals)}`);
  console.log(`Attempting to transfer: ${ethers.formatUnits(transferAmount, decimals)} ${symbol}`);
  if (balance < transferAmount) throw new Error('Insufficient token balance');

  // Send raw transaction
  const txHash = await ethers.provider.send('eth_sendRawTransaction', [signedTx]);
  console.log('Transaction sent (hash):', txHash);

  console.log('Waiting for transaction to be mined...');
  console.log('Waiting for transaction to be mined...');

  let receipt = null;
  while (!receipt) {
    receipt = await ethers.provider.getTransactionReceipt(txHash);
    if (!receipt) {
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }

  // Check transaction status
  if (receipt.status === 0) {
    console.error('Transaction failed!');
    
    // Try to get more information about the failure
    try {
      const tx = await ethers.provider.getTransaction(txHash);
      const code = await ethers.provider.call(tx, tx.blockNumber);
      console.error('Revert reason:', code);
    } catch (error) {
      console.error('Error getting revert reason:', error);
    }

    throw new Error(`Transaction failed. Hash: ${receipt.hash}`);
  }

  console.log('Transaction successful!');
  console.log('Transaction hash:', receipt.hash);
  console.log('Block number:', receipt.blockNumber);
  console.log('Gas used:', receipt.gasUsed.toString());

  // Check new balance of tokenHolder
  const newBalance = await erc20Contract.balanceOf(tokenHolder.address);
  console.log(`New ${symbol} balance of tokenHolder: ${ethers.formatUnits(newBalance, decimals)}`);
  console.log(`Gas payer ETH spent can be checked via explorer on ${gasPayer.address}`);
}

main().then(() => {
  console.log('Execution completed');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});