import { EthBridger, EthDepositMessageStatus, ParentTransactionReceipt } from '@arbitrum/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { Wallet, providers, utils } from 'ethers';
import { z } from 'zod';

import { CHAIN_INFO } from './default.js';
import { getTransactionExplorerLink } from './utils.js';

config({ quiet: true });

if (process.env.PRIVATE_KEY == undefined) {
  throw new Error(`Client private key required`);
}
const rpcProviders = new Map<number, providers.JsonRpcProvider>();

// Bad way but who cares for now
rpcProviders.set(
  CHAIN_INFO.ArbOne.chainID,
  new providers.JsonRpcProvider(CHAIN_INFO.ArbOne.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.ArbSepolia.chainID,
  new providers.JsonRpcProvider(CHAIN_INFO.ArbSepolia.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.EthSepolia.chainID,
  new providers.JsonRpcProvider(CHAIN_INFO.EthSepolia.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.EthMainnet.chainID,
  new providers.JsonRpcProvider(CHAIN_INFO.EthMainnet.RPC_URL),
);

if (process.env.ARB_SEPOLIA_RPC) {
  rpcProviders.set(
    CHAIN_INFO.ArbSepolia.chainID,
    new providers.JsonRpcProvider(process.env.ARB_SEPOLIA_RPC),
  );
}
if (process.env.ARB_ONE_RPC) {
  rpcProviders.set(
    CHAIN_INFO.ArbOne.chainID,
    new providers.JsonRpcProvider(process.env.ARB_ONE_RPC),
  );
}
if (process.env.ETH_MAINNET_RPC) {
  rpcProviders.set(
    CHAIN_INFO.EthMainnet.chainID,
    new providers.JsonRpcProvider(process.env.ETH_MAINNET_RPC),
  );
}
if (process.env.ETH_SEPOLIA_RPC) {
  rpcProviders.set(
    CHAIN_INFO.EthSepolia.chainID,
    new providers.JsonRpcProvider(process.env.ETH_SEPOLIA_RPC),
  );
}

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;

const wallet = new Wallet(privateKey);

const server = new McpServer({
  name: 'Arbgent',
  version: '1.0.0',
});

server.registerTool(
  'bridge_eth_L1_to_L2',
  {
    description: 'Bridges eth from L1 parent chain to L2 child chain',
    inputSchema: {
      l1ChainID: z.number().describe('The Parent chainID'),
      l2ChainID: z.number().describe('The Child chainID'),
      amount: z.string().describe('The amount of eth to bridge'),
    },
  },
  async ({ l1ChainID, l2ChainID, amount }) => {
    const l1Provider = rpcProviders.get(l1ChainID);
    const l2Provider = rpcProviders.get(l2ChainID);
    if (l1Provider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${l1ChainID}` }],
      };
    }
    if (l2Provider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${l2ChainID}` }],
      };
    }

    const ethBridger = await EthBridger.fromProvider(l2Provider);
    const parentSigner = wallet.connect(l1Provider);

    const depositTx = await ethBridger.deposit({
      amount: utils.parseEther(amount),
      parentSigner,
    });
    const link = await getTransactionExplorerLink(depositTx);
    if (link == undefined) console.error('Something very wrong happened');

    const depositReceipt = await depositTx.wait();
    return {
      content: [
        {
          type: 'text',
          text: `Bridged ${amount} ETH from chain ${l1ChainID} to ${l2ChainID}.\nParent (L1) tx: ${depositReceipt.transactionHash} (${depositReceipt.status === 1 ? 'success' : 'reverted'}, block ${depositReceipt.blockNumber}, gas used ${depositReceipt.gasUsed.toString()})\n\n ${link ? `\n\nView on explorer: ${link}` : ''}The ETH will arrive on the child chain once the retryable ticket is auto-redeemed (usually a few minutes).`,
        },
      ],
    };
  },
);

server.registerTool(
  'bridge_status',
  {
    description: 'check the status of a bridge transaction',
    inputSchema: {
      l1ChainID: z.number().describe('The Parent chainID'),
      l2ChainID: z.number().describe('The Child chainID'),
      transactionHash: z.string().describe('The bridge transaction'),
    },
  },
  async ({ l1ChainID, l2ChainID, transactionHash }) => {
    const l1Provider = rpcProviders.get(l1ChainID);
    const l2Provider = rpcProviders.get(l2ChainID);
    if (l1Provider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${l1ChainID}` }],
      };
    }
    if (l2Provider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${l2ChainID}` }],
      };
    }

    const hash = transactionHash as `0x${string}`;
    const txReceipt = await l1Provider.getTransactionReceipt(hash);
    if (txReceipt === null) {
      return {
        content: [
          {
            type: 'text',
            text: `No receipt found for ${hash} on chain ${l1ChainID}. The transaction may not be mined yet.`,
          },
        ],
      };
    }

    const parentReceipt = new ParentTransactionReceipt(txReceipt);
    const messages = await parentReceipt.getEthDeposits(l2Provider);

    if (messages.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No parent-to-child (L1->L2) messages found in ${hash}. This does not look like a bridge deposit transaction.`,
          },
        ],
      };
    }

    const lines: string[] = [];
    for (const [i, message] of messages.entries()) {
      const label = messages.length > 1 ? `Message ${i + 1}/${messages.length}` : `Bridge message`;
      const status = await message.status();

      switch (status) {
        case EthDepositMessageStatus.PENDING:
          lines.push(`${label}: EthDeposit is still pending, check back later`);
          break;
        case EthDepositMessageStatus.DEPOSITED:
          lines.push(`${label}: Eth has been deposited`);
          break;
        default:
          lines.push(`${label}: unknown status ${status}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

server.registerTool(
  'send_eth',
  {
    description: 'send eth to an address',
    inputSchema: {
      recipient: z.string().describe('The recipient of the tokens'),
      amount: z.string().describe('The amount of eth to send'),
      chain: z.number().describe('The chainID that you want to send eth on'),
    },
  },
  async ({ recipient, amount, chain }) => {
    const provider = rpcProviders.get(chain);
    if (provider === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `provider unavailable for chainID ${chain}`,
          },
        ],
      };
    }

    const connectedWallet = wallet.connect(provider);

    const sendValue = utils.parseEther(amount);

    // const result = await server.server.elicitInput({
    //   message: `About to send ${sendValue} ETH to ${recipient} on chain ${chain}. Proceed?`,
    //   requestedSchema: {
    //     type: 'object',
    //     properties: {
    //       confirm: {
    //         type: 'boolean',
    //         title: 'Confirm transaction',
    //         description: `Send ${amount} ETH to ${recipient}`,
    //       },
    //     },
    //     required: ['confirm'],
    //   },
    // });

    // if (result.action !== 'accept' || result.content?.confirm !== true) {
    //   return {
    //     content: [{ type: 'text', text: 'Transaction cancelled by user.' }],
    //   };
    // }

    const tx = await connectedWallet.sendTransaction({
      to: recipient,
      value: sendValue,
    });

    const link = await getTransactionExplorerLink(tx);
    if (link == undefined) console.error('Something very wrong happened');

    const receipt = await tx.wait();
    if (receipt === null) {
      return {
        content: [
          {
            type: 'text',
            text: `transaction ${tx.hash} was sent but no receipt is available`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Eth sent successfully: ${receipt.transactionHash} (${receipt.status === 1 ? 'success' : 'reverted'}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}`,
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Arbgent is Running');
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
