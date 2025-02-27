import {
  JsonRpcProvider,
  RawSigner,
  Ed25519Keypair,
  Connection
} from '@mysten/sui';
import {
  CetusClmmSDK,
  SdkOptions,
  TickMath,
  Pool,
  TokenInfo,
  SwapParams,
  CoinAsset
} from '@cetusprotocol/cetus-sui-clmm-sdk';
import BN from 'bn.js';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
interface Config {
  rpcUrl: string;
  privateKey: string;
  coinTypeA: string;
  coinTypeB: string;
  slippage: number;
  tradeCount: number;
  amountToTrade: string;
  delayBetweenTradesMs: number;
}

const config: Config = {
  rpcUrl: process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443',
  privateKey: process.env.PRIVATE_KEY || '',
  coinTypeA: process.env.COIN_TYPE_A || '0x2::sui::SUI',
  coinTypeB: process.env.COIN_TYPE_B || '',
  slippage: Number(process.env.SLIPPAGE) || 1,
  tradeCount: Number(process.env.TRADE_COUNT) || 3,
  amountToTrade: process.env.AMOUNT_TO_TRADE || '1000000',
  delayBetweenTradesMs: Number(process.env.DELAY_BETWEEN_TRADES_MS) || 5000
};

// Initialize provider and signer
const provider = new JsonRpcProvider(new Connection({
  fullnode: config.rpcUrl
}));

// Create a wallet from the private key
const keypair = Ed25519Keypair.fromSecretKey(
  Uint8Array.from(Buffer.from(config.privateKey.replace('0x', ''), 'hex'))
);
const signer = new RawSigner(keypair, provider);

// Utility function for delay
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize Cetus SDK
async function initCetusSDK() {
  const walletAddress = await signer.getAddress();

  const sdkOptions: SdkOptions = {
    fullRpcUrl: config.rpcUrl,
    faucetURL: "",
    simulationAccount: {
      address: walletAddress
    },
    cetus_config: undefined,
    cacheTime: 10 * 1000, // 10 seconds
  };

  const sdk = new CetusClmmSDK(sdkOptions);
  await sdk.refreshPools();

  return sdk;
}

// Get token information
async function getTokenInfo(sdk: CetusClmmSDK, coinType: string): Promise<TokenInfo> {
  const tokenList = await sdk.getTokenInfos();
  const tokenInfo = Object.values(tokenList).find(token => token.address === coinType);

  if (!tokenInfo) {
    throw new Error(`Token information not found for ${coinType}`);
  }

  return tokenInfo;
}

// Find pool for token pair
async function findPool(sdk: CetusClmmSDK, coinTypeA: string, coinTypeB: string): Promise<Pool> {
  const pools = await sdk.getPools();

  // Find the pool that matches our token pair (in either order)
  const pool = pools.find(p =>
    (p.coinTypeA === coinTypeA && p.coinTypeB === coinTypeB) ||
    (p.coinTypeA === coinTypeB && p.coinTypeB === coinTypeA)
  );

  if (!pool) {
    throw new Error(`Pool not found for token pair ${coinTypeA} and ${coinTypeB}`);
  }

  return pool;
}

// Execute a swap (buy or sell)
async function executeSwap(
  sdk: CetusClmmSDK,
  isBuy: boolean,
  amount: string
) {
  try {
    const walletAddress = await signer.getAddress();
    console.log(`Executing ${isBuy ? 'BUY' : 'SELL'} for ${amount} units`);

    // Get token information
    const tokenA = await getTokenInfo(sdk, config.coinTypeA);
    const tokenB = await getTokenInfo(sdk, config.coinTypeB);

    // Find pool for token pair
    const pool = await findPool(sdk, config.coinTypeA, config.coinTypeB);

    // Determine input and output tokens based on buy or sell
    const [inputCoinType, outputCoinType] = isBuy
      ? [config.coinTypeA, config.coinTypeB]
      : [config.coinTypeB, config.coinTypeA];

    const [inputToken, outputToken] = isBuy
      ? [tokenA, tokenB]
      : [tokenB, tokenA];

    // Create amount in BN
    const amountIn = new BN(amount);

    // Get pool data
    const poolData = await sdk.getPool(pool.poolAddress);

    // Determine if aToB based on token order in pool
    const aToB = inputCoinType === poolData.coinTypeA;

    // Calculate expected output amount
    const sqrtPrice = TickMath.getSqrtPriceFromTick(poolData.currentTickIndex);
    const { estimatedAmountOut } = sdk.calculateRates({
      decimalsA: poolData.coinA.decimals,
      decimalsB: poolData.coinB.decimals,
      a2b: aToB,
      amount: amountIn.toString(),
      currentSqrtPrice: sqrtPrice,
      slippage: config.slippage,
    });

    // Calculate minimum amount out with slippage
    const slippageMultiplier = 1 - (config.slippage / 100);
    const minAmountOut = new BN(
      (Number(estimatedAmountOut) * slippageMultiplier).toFixed(0)
    );

    // Get wallet coins
    const coinAssets = await sdk.getOwnerCoinAssets(walletAddress);

    // Build swap parameters
    const swapParams: SwapParams = {
      pool: poolData,
      a2b: aToB,
      byAmountIn: true,
      amount: amountIn.toString(),
      amountSpecifiedIsInput: true,
      squeezeAmount: '0',
      walletAddress,
      coinTypeA: poolData.coinTypeA,
      coinTypeB: poolData.coinTypeB,
      slippage: config.slippage,
    };

    // Create swap transaction
    const transactionPayload = await sdk.swap(swapParams, coinAssets);

    // Execute the transaction
    const transferTxn = await signer.signAndExecuteTransactionBlock({
      transactionBlock: transactionPayload.blockTransaction,
      options: {
        showEffects: true,
        showEvents: true,
      },
    });

    console.log(`Transaction successful: ${transferTxn.digest}`);
    return transferTxn.digest;
  } catch (error) {
    console.error('Swap failed:', error);
    throw error;
  }
}

// Get token balance
async function getTokenBalance(sdk: CetusClmmSDK, tokenType: string): Promise<BN> {
  const walletAddress = await signer.getAddress();
  const coinAssets = await sdk.getOwnerCoinAssets(walletAddress);

  // Find coins of the specified type
  const tokenCoins = coinAssets.filter(coin => coin.coinType === tokenType);

  // Sum up the balances
  return tokenCoins.reduce((total, coin) => total.add(new BN(coin.balance)), new BN(0));
}

// Main function to execute trades
async function executeTrades() {
  console.log(`Starting Cetus trading bot for ${config.tradeCount} cycles...`);
  console.log(`Trading pair: ${config.coinTypeA} <-> ${config.coinTypeB}`);

  // Initialize SDK
  const sdk = await initCetusSDK();
  const address = await signer.getAddress();
  console.log(`Using wallet: ${address}`);

  // Execute specified number of buy-sell cycles
  for (let i = 0; i < config.tradeCount; i++) {
    console.log(`\n==== Trade Cycle ${i + 1}/${config.tradeCount} ====`);

    try {
      // Check initial balances
      const initialBaseBalance = await getTokenBalance(sdk, config.coinTypeA);
      const initialTargetBalance = await getTokenBalance(sdk, config.coinTypeB);

      console.log(`Initial ${config.coinTypeA} balance: ${initialBaseBalance.toString()}`);
      console.log(`Initial ${config.coinTypeB} balance: ${initialTargetBalance.toString()}`);

      // Buy token
      console.log('Executing BUY transaction...');
      await executeSwap(sdk, true, config.amountToTrade);

      // Wait between transactions
      console.log(`Waiting ${config.delayBetweenTradesMs / 1000} seconds before selling...`);
      await sleep(config.delayBetweenTradesMs);

      // Get updated balance to sell
      const updatedTargetBalance = await getTokenBalance(sdk, config.coinTypeB);
      const amountToSell = updatedTargetBalance.sub(initialTargetBalance);

      console.log(`Amount of ${config.coinTypeB} to sell: ${amountToSell.toString()}`);

      if (amountToSell.lten(0)) {
        console.log('No tokens to sell, skipping sell transaction');
        continue;
      }

      // Sell token
      console.log('Executing SELL transaction...');
      await executeSwap(sdk, false, amountToSell.toString());

      // Wait before next cycle
      if (i < config.tradeCount - 1) {
        console.log(`Waiting ${config.delayBetweenTradesMs / 1000} seconds before next cycle...`);
        await sleep(config.delayBetweenTradesMs);
      }
    } catch (error) {
      console.error(`Error in trade cycle ${i + 1}:`, error);
      console.log('Continuing to next cycle...');
    }
  }

  // Final balance check
  try {
    const finalBaseBalance = await getTokenBalance(sdk, config.coinTypeA);
    const finalTargetBalance = await getTokenBalance(sdk, config.coinTypeB);

    console.log(`\nFinal ${config.coinTypeA} balance: ${finalBaseBalance.toString()}`);
    console.log(`Final ${config.coinTypeB} balance: ${finalTargetBalance.toString()}`);
  } catch (error) {
    console.error('Error checking final balances:', error);
  }

  console.log('\nTrading completed!');
}

// Start the bot
executeTrades().catch(error => {
  console.error('Bot crashed:', error);
  process.exit(1);
});