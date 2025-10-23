const { ethers } = require('hardhat');
require('dotenv').config();

const main = async () => {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, ethers.provider);
  
  const BATCH_CALL_DELEGATION_ADDRESS = process.env.BATCH_CALL_DELEGATION_ADDRESS;
  if (!BATCH_CALL_DELEGATION_ADDRESS) {
    throw new Error('BATCH_CALL_DELEGATION_ADDRESS not set in environment');
  }
  
  console.log(`Using BatchCallDelegation at: ${BATCH_CALL_DELEGATION_ADDRESS}`);

  // Define ERC20 interface with transfer function signature
  const erc20Interface = new ethers.Interface([
    "function transfer(address to, uint256 amount)"
  ]);
    
  // Define ERC20 transfer parameters
  const ERC20_TOKEN_ADDRESS = process.env.TOKEN_ADDRESS; // ERC20代币地址
  const transferAmount = ethers.parseUnits("1.0", 6); // 转账1个代币，假设decimals为18

  // 编码ERC20 transfer函数调用
  const tokenTransferData = erc20Interface.encodeFunctionData("transfer", [
    process.env.RECIPIENT_ADDRESS,
    transferAmount
  ]);

  // 将ERC20转账打包到BatchCallDelegation的调用中
  const batchInterface = new ethers.Interface([
    "function execute(tuple(bytes data, address to, uint256 value)[] calls)"
  ]);

  const calls = [
    {
      data: tokenTransferData,
      to: ERC20_TOKEN_ADDRESS,
      value: 0 // ERC20转账不需要发送ETH
    }
  ];

  // Encode the execute function call with parameters
  const calldata = batchInterface.encodeFunctionData("execute", [calls]);

  const currentNonce = await ethers.provider.getTransactionCount(wallet.address);
  const chainId = await ethers.provider.getNetwork().then(network => network.chainId);

  const authorizationData = {
    chainId: ethers.toBeHex(chainId),
    address: BATCH_CALL_DELEGATION_ADDRESS,
    nonce: ethers.toBeHex(currentNonce + 1),
  }

  // Encode authorization data according to EIP-712 standard
  const encodedAuthorizationData = ethers.concat([
    '0x05', // MAGIC code for EIP7702
    ethers.encodeRlp([
      authorizationData.chainId,
      authorizationData.address,
      authorizationData.nonce,
    ])
  ]);

  // Generate and sign authorization data hash
  const authorizationDataHash = ethers.keccak256(encodedAuthorizationData);
  const authorizationSignature = wallet.signingKey.sign(authorizationDataHash);

  // Store signature components
  authorizationData.yParity = authorizationSignature.yParity == 0 ? '0x' : '0x01';
  authorizationData.r = authorizationSignature.r;
  authorizationData.s = authorizationSignature.s;

  // Get current gas fee data from the network
  const feeData = await ethers.provider.getFeeData();

  let maxPriorityFeePerGas = ethers.toBeHex(feeData.maxPriorityFeePerGas);
  maxPriorityFeePerGas = maxPriorityFeePerGas === '0x00'? '0x' : maxPriorityFeePerGas;

  // Prepare complete transaction data structure
  const txData = [
    authorizationData.chainId,
    ethers.toBeHex(currentNonce),
    maxPriorityFeePerGas, // Priority fee (tip)
    ethers.toBeHex(feeData.maxFeePerGas), // Maximum total fee willing to pay
    ethers.toBeHex(10000000), // Gas limit
    wallet.address, // Sender address
    '0x', // Value (no ETH being sent)
    calldata, // Encoded function call
    [], // Access list (empty for this transaction)
    [
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


  console.log("txData=======================================================");
  console.log("txData====",txData);
  console.log("txData======================================================");
  // Encode final transaction data with version prefix
  const encodedTxData = ethers.concat([
    '0x04', // Transaction type identifier
    ethers.encodeRlp(txData)
  ]);

  // Sign the complete transaction
  const txDataHash = ethers.keccak256(encodedTxData);
  const txSignature = wallet.signingKey.sign(txDataHash);

  // Construct the fully signed transaction
  const signedTx = ethers.hexlify(ethers.concat([
    '0x04',
    ethers.encodeRlp([
      ...txData,
      txSignature.yParity == 0 ? '0x' : '0x01',
      txSignature.r,
      txSignature.s
    ])
  ]));

  // Before sending, check if we have enough balance
  const erc20Contract = new ethers.Contract(ERC20_TOKEN_ADDRESS, [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)"
  ], ethers.provider);

  const [balance, decimals, symbol] = await Promise.all([
    erc20Contract.balanceOf(wallet.address),
    erc20Contract.decimals(),
    erc20Contract.symbol()
  ]);

  console.log(`Current ${symbol} balance: ${ethers.formatUnits(balance, decimals)}`);
  console.log(`Attempting to transfer: ${ethers.formatUnits(transferAmount, decimals)} ${symbol}`);

  if (balance < transferAmount) {
    throw new Error(`Insufficient balance. Have ${ethers.formatUnits(balance, decimals)} ${symbol}, need ${ethers.formatUnits(transferAmount, decimals)} ${symbol}`);
  }

  // Send the raw transaction to the network
  const txHash = await ethers.provider.send('eth_sendRawTransaction', [signedTx]);
  
  console.log('Transaction sent: ', txHash);

  // Wait for transaction using polling
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

  // Check new balance
  const newBalance = await erc20Contract.balanceOf(wallet.address);
  console.log(`New ${symbol} balance: ${ethers.formatUnits(newBalance, decimals)}`);
}

main().then(() => {
  console.log('Execution completed');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});