import {
  ChildToParentMessageStatus,
  ChildTransactionReceipt,
  Erc20Bridger,
  EthBridger,
  EthDepositMessageStatus,
  ParentToChildMessageStatus,
  ParentTransactionReceipt,
} from '@arbitrum/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { Contract, Wallet, providers, utils } from 'ethers';
import { z } from 'zod';

import { CHAIN_INFO, ERC20_ABI } from './default.js';
import { getTransactionExplorerLink } from './utils.js';

config({ quiet: true });

if (process.env.PRIVATE_KEY == undefined) {
  throw new Error(`Client private key required`);
}
const rpcProviders = new Map<number, providers.JsonRpcProvider>();

// Much better
rpcProviders.set(
  CHAIN_INFO.ArbOne.chainID,
  new providers.JsonRpcProvider(process.env.ARB_ONE_RPC ?? CHAIN_INFO.ArbOne.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.ArbSepolia.chainID,
  new providers.JsonRpcProvider(process.env.ARB_SEPOLIA_RPC ?? CHAIN_INFO.ArbSepolia.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.EthSepolia.chainID,
  new providers.JsonRpcProvider(process.env.ETH_SEPOLIA_RPC ?? CHAIN_INFO.EthSepolia.RPC_URL),
);
rpcProviders.set(
  CHAIN_INFO.EthMainnet.chainID,
  new providers.JsonRpcProvider(process.env.ETH_MAINNET_RPC ?? CHAIN_INFO.EthMainnet.RPC_URL),
);

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;

const wallet = new Wallet(privateKey);

const server = new McpServer({
  name: 'Arbgent',
  version: '1.0.0',
});
// This is good
server.registerTool(
  'get_eth_balance',
  {
    description:
      'Returns the balances of eth on each chain supplied (ArbOne, ArbSepolia, EthMainnet, EthSepolia).',
    inputSchema: {
      ChainIDs: z
        .optional(z.array(z.number()))
        .describe(
          'The chains that you want eth balance information on, Returns all chain balances if left blank',
        ),
      Address: z
        .optional(z.string())
        .describe(
          'The address to get the balance of, uses the address of the privatekey if left blank',
        ),
    },
  },
  async ({ ChainIDs, Address }) => {
    const checkAddress = Address ?? wallet.address;
    const ids = ChainIDs ?? rpcProviders.keys();
    const info: string[] = [];
    info.push(`Eth balance for address: ${checkAddress}`);
    for (const id of ids) {
      const provider = rpcProviders.get(id);
      if (provider === undefined) {
        info.push(`ChainID: ${id} provider unavailable`);
        continue
      }
      try {
        const balance = await provider.getBalance(checkAddress);
        info.push(`ChainID: ${id}, Eth Balance: ${balance}`);
      }
      catch (err) {
        info.push(`Unable to get eth balance info on Chain: ${id}, error: ${err}`)
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: info.join('\n'),
        },
      ],
    };
  },
);
// Looks good
server.registerTool(
  'get_erc20_balance',
  {
    description:
      'Returns the balances of erc20s on one of the supplied chains (ArbOne, ArbSepolia, EthMainnet, EthSepolia).',
    inputSchema: {
      ChainID: z.number().describe('The chains that you want erc20 balance information on'),
      Address: z
        .optional(z.string())
        .describe(
          'The address to get the balance of, uses the address of the privatekey if left blank',
        ),
      TokenAddress: z.string().describe('The address of the erc20 token'),
    },
  },
  async ({ ChainID, Address, TokenAddress }) => {
    const checkAddress = Address ?? wallet.address;
    const provider = rpcProviders.get(ChainID);
    const info: string[] = [];
    if (provider === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `ChainID: ${ChainID}, provider unavailable`,
          },
        ],
      };
    }
    try {
      const token = new Contract(TokenAddress, ERC20_ABI, provider);
      const [balance, decimals, symbol] = await Promise.all([
        token.balanceOf(checkAddress),
        token.decimals(),
        token.symbol(),
      ]);
      info.push(`ChainID: ${ChainID}, Balance: ${utils.formatUnits(balance, decimals)} ${symbol}`);
    } catch (error) {
      info.push(
        `ChainID: ${ChainID}, error reading token (it may not be deployed on this chain): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      content: [
        {
          type: 'text',
          text: info.join('\n'),
        },
      ],
    };
  },
);

server.registerTool(
  'bridge_erc20_Parent_to_Child',
  {
    description: 'Bridges an ERC20 token from the L1 parent chain to the L2 child chain',
    inputSchema: {
      ParentChainID: z.number().describe('The Parent chainID'),
      ChildChainID: z.number().describe('The Child chainID'),
      tokenAddress: z.string().describe('The parent-chain address of the ERC20 token to bridge'),
      amount: z.string().describe('The amount of tokens to bridge (in human readable units)'),
      destinationAddress: z
        .optional(z.string())
        .describe('Optional parent chain destination address'),
    },
  },
  async ({ ParentChainID, ChildChainID, tokenAddress, amount, destinationAddress }) => {
    const parentProvider = rpcProviders.get(ParentChainID);
    const childProvider = rpcProviders.get(ChildChainID);

    if (parentProvider === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `Parent chain: ${ParentChainID} is unavailable`,
          },
        ],
      };
    }
    if (childProvider === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `Child chain: ${ChildChainID} is unavailable`,
          },
        ],
      };
    }

    const connectedWallet = wallet.connect(parentProvider);
    const token = new Contract(tokenAddress, ERC20_ABI, connectedWallet);

    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    const sendValue = utils.parseUnits(amount, decimals);

    const erc20Bridger = await Erc20Bridger.fromProvider(childProvider);

    const approveTx = await erc20Bridger.approveToken({
      erc20ParentAddress: tokenAddress,
      amount: sendValue,
      parentSigner: connectedWallet,
    });
    await approveTx.wait();

    const depositTransaction = await erc20Bridger.deposit({
      amount: sendValue,
      erc20ParentAddress: tokenAddress,
      childProvider: childProvider,
      parentSigner: connectedWallet,
      destinationAddress: destinationAddress ?? wallet.address,
    });

    const link = await getTransactionExplorerLink(depositTransaction);
    if (link == undefined) console.error('Something very wrong happened');
    const receipt = await depositTransaction.wait();

    return {
      content: [
        {
          type: 'text',
          text: `Bridged ${amount} ${symbol} (${tokenAddress}) from chain ${ParentChainID} to ${ChildChainID}.\nParent (L1) tx: ${receipt.transactionHash} (${receipt.status === 1 ? 'success' : 'reverted'}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}\n\nThe tokens will arrive on the child chain once the retryable ticket is redeemed (usually a few minutes). If the auto-redeem fails, run bridge_status_and_redeem with this transaction hash to redeem it manually.`,
        },
      ],
    };
  },
);

server.registerTool(
  'bridge_eth_Parent_to_Child',
  {
    description: 'Bridges eth from L1 parent chain to L2 child chain',
    inputSchema: {
      ParentChainID: z.number().describe('The Parent chainID'),
      ChildChainID: z.number().describe('The Child chainID'),
      amount: z.string().describe('The amount of eth to bridge (in human readable units)'),
    },
  },
  async ({ ParentChainID, ChildChainID, amount }) => {
    const parentProvider = rpcProviders.get(ParentChainID);
    const childProvider = rpcProviders.get(ChildChainID);
    if (parentProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ParentChainID}` }],
      };
    }
    if (childProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ChildChainID}` }],
      };
    }

    const ethBridger = await EthBridger.fromProvider(childProvider);
    const parentSigner = wallet.connect(parentProvider);

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
          text: `Bridged ${amount} ETH from chain ${ParentChainID} to ${ChildChainID}.\nParent (L1) tx: ${depositReceipt.transactionHash} (${depositReceipt.status === 1 ? 'success' : 'reverted'}, block ${depositReceipt.blockNumber}, gas used ${depositReceipt.gasUsed.toString()})\n\n ${link ? `\n\nView on explorer: ${link}` : ''}The ETH will arrive on the child chain once the retryable ticket is auto-redeemed (usually a few minutes).`,
        },
      ],
    };
  },
);
// Can remove the ParentChainID field as there is only one parent chain
server.registerTool(
  'bridge_eth_Child_to_Parent',
  {
    description: 'Bridges eth from L2 child chain to L1 parent chain',
    inputSchema: {
      ParentChainID: z.number().describe('The Parent chainID'),
      ChildChainID: z.number().describe('The Child chainID'),
      amount: z.string().describe('The amount of eth to bridge (in human readable units)'),
      destinationAddress: z
        .optional(z.string())
        .describe('Optional parent chain destination address'),
    },
  },
  async ({ ParentChainID, ChildChainID, amount, destinationAddress }) => {
    const parentProvider = rpcProviders.get(ParentChainID);
    const childProvider = rpcProviders.get(ChildChainID);
    if (parentProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ParentChainID}` }],
      };
    }
    if (childProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ChildChainID}` }],
      };
    }

    const ethBridger = await EthBridger.fromProvider(childProvider);
    const childSigner = wallet.connect(childProvider);

    const withdrawTx = await ethBridger.withdraw({
      amount: utils.parseEther(amount),
      childSigner,
      from: wallet.address,
      destinationAddress: destinationAddress ?? wallet.address,
    });

    const link = await getTransactionExplorerLink(withdrawTx);
    if (link == undefined) console.error('Something very wrong happened');

    const withdrawReceipt = await withdrawTx.wait();
    return {
      content: [
        {
          type: 'text',
          text: `Initiated withdrawal of ${amount} ETH from chain ${ChildChainID} to ${ParentChainID} (recipient ${destinationAddress ?? wallet.address}).\nChild (L2) tx: ${withdrawReceipt.transactionHash} (${withdrawReceipt.status === 1 ? 'success' : 'reverted'}, block ${withdrawReceipt.blockNumber}, gas used ${withdrawReceipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}\n\nThe withdrawal must clear the dispute window (~1 week on mainnet, ~1 hour on Sepolia) before it can be claimed. Once confirmed, run execute_withdrawal with this transaction hash to claim the ETH on the parent chain.`,
        },
      ],
    };
  },
);
// Can remove the ParentChainID field as there is only one parent chain
server.registerTool(
  'bridge_erc20_Child_to_Parent',
  {
    description: 'Bridges an ERC20 token from the L2 child chain back to the L1 parent chain',
    inputSchema: {
      ParentChainID: z.number().describe('The Parent chainID'),
      ChildChainID: z.number().describe('The Child chainID'),
      tokenAddress: z.string().describe('The parent-chain address of the ERC20 token to bridge'),
      amount: z.string().describe('The amount of tokens to bridge (in human readable units)'),
      destinationAddress: z
        .optional(z.string())
        .describe('Optional parent chain destination address'),
    },
  },
  async ({ ParentChainID, ChildChainID, tokenAddress, amount, destinationAddress }) => {
    const parentProvider = rpcProviders.get(ParentChainID);
    const childProvider = rpcProviders.get(ChildChainID);
    if (parentProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ParentChainID}` }],
      };
    }
    if (childProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ChildChainID}` }],
      };
    }

    // Token decimals are shared across the parent and child representations, so we
    // read them from the parent-chain token contract using the supplied parent address.
    const token = new Contract(tokenAddress, ERC20_ABI, parentProvider);
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    const sendValue = utils.parseUnits(amount, decimals);

    const erc20Bridger = await Erc20Bridger.fromProvider(childProvider);
    const childSigner = wallet.connect(childProvider);

    const withdrawTx = await erc20Bridger.withdraw({
      amount: sendValue,
      erc20ParentAddress: tokenAddress,
      childSigner,
      destinationAddress: destinationAddress ?? wallet.address,
    });

    const link = await getTransactionExplorerLink(withdrawTx);
    if (link == undefined) console.error('Something very wrong happened');

    const withdrawReceipt = await withdrawTx.wait();
    return {
      content: [
        {
          type: 'text',
          text: `Initiated withdrawal of ${amount} ${symbol} (${tokenAddress}) from chain ${ChildChainID} to ${ParentChainID} (recipient ${destinationAddress ?? wallet.address}).\nChild (L2) tx: ${withdrawReceipt.transactionHash} (${withdrawReceipt.status === 1 ? 'success' : 'reverted'}, block ${withdrawReceipt.blockNumber}, gas used ${withdrawReceipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}\n\nThe withdrawal must clear the dispute window (~1 week on mainnet, ~1 hour on Sepolia) before it can be claimed. Once confirmed, run bridge_status_and_redeem with this transaction hash to claim the tokens on the parent chain.`,
        },
      ],
    };
  },
);
// This one can use some tidying for sure
server.registerTool(
  'bridge_status_and_redeem',
  {
    description:
      'check the status of a bridge transaction, either deposit or withdraw, will redeem if possible',
    inputSchema: {
      ParentChainID: z.number().describe('The Parent chainID'),
      ChildChainID: z.number().describe('The Child chainID'),
      transactionHash: z.string().describe('The bridge transaction'),
    },
  },
  async ({ ParentChainID, ChildChainID, transactionHash }) => {
    const parentProvider = rpcProviders.get(ParentChainID);
    const childProvider = rpcProviders.get(ChildChainID);
    if (parentProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ParentChainID}` }],
      };
    }
    if (childProvider === undefined) {
      return {
        content: [{ type: 'text', text: `provider unavailable for chainID ${ChildChainID}` }],
      };
    }

    const hash = transactionHash as `0x${string}`;
    const ParentTxReceipt = await parentProvider.getTransactionReceipt(hash);
    const ChildTxReceipt = await childProvider.getTransactionReceipt(hash);

    if (ParentTxReceipt === null && ChildTxReceipt === null) {
      return {
        content: [
          {
            type: 'text',
            text: `No receipt found for ${hash} on chain either L1 or L2. The transaction may not be mined yet.`,
          },
        ],
      };
    }
    if (ParentTxReceipt) {
      const parentReceipt = new ParentTransactionReceipt(ParentTxReceipt);
      const lines: string[] = [];

      // ETH deposits are delivered directly (not via a retryable ticket).
      const ethDeposits = await parentReceipt.getEthDeposits(childProvider);
      for (const [i, message] of ethDeposits.entries()) {
        const label =
          ethDeposits.length > 1
            ? `ETH deposit message ${i + 1}/${ethDeposits.length}`
            : `ETH deposit message`;
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

      // ERC20 (and other contract-call) deposits arrive as retryable tickets that
      // may need a manual redeem if the auto-redeem failed. Connect a child signer
      // so we get message writers capable of redeeming.
      const childSigner = wallet.connect(childProvider);
      const retryables = await parentReceipt.getParentToChildMessages(childSigner);
      for (const [i, message] of retryables.entries()) {
        const label =
          retryables.length > 1
            ? `Token deposit (retryable) ${i + 1}/${retryables.length}`
            : `Token deposit (retryable)`;
        const status = await message.status();

        switch (status) {
          case ParentToChildMessageStatus.NOT_YET_CREATED:
            lines.push(`${label}: retryable ticket not yet created, check back later`);
            break;
          case ParentToChildMessageStatus.CREATION_FAILED:
            lines.push(
              `${label}: retryable ticket creation failed (likely insufficient submission cost). The deposit cannot complete.`,
            );
            break;
          case ParentToChildMessageStatus.FUNDS_DEPOSITED_ON_CHILD:
            {
              const redeemTx = await message.redeem();
              const link = await getTransactionExplorerLink(redeemTx);
              const redeemReceipt = await redeemTx.waitForRedeem();
              lines.push(
                `${label}: auto-redeem had not completed, manually redeemed on chain ${ChildChainID}. Child (L2) tx: ${redeemReceipt.transactionHash} (${redeemReceipt.status === 1 ? 'success' : 'reverted'}, block ${redeemReceipt.blockNumber}, gas used ${redeemReceipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}`,
              );
            }
            break;
          case ParentToChildMessageStatus.REDEEMED:
            lines.push(`${label}: tokens have been redeemed and are available on the child chain`);
            break;
          case ParentToChildMessageStatus.EXPIRED:
            lines.push(`${label}: retryable ticket expired, the funds can no longer be redeemed`);
            break;
          default:
            lines.push(`${label}: unknown status ${status}`);
        }
      }

      if (lines.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No parent-to-child (L1->L2) messages found in ${hash}. This does not look like a bridge deposit transaction.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text', text: lines.join('\n') }],
      };
    } else {
      const childReceipt = new ChildTransactionReceipt(ChildTxReceipt);
      const messages = await childReceipt.getChildToParentMessages(wallet.connect(parentProvider));
      if (messages.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No child-to-parent (L2->L1) messages found in ${hash}. This does not look like a bridge withdraw transaction.`,
            },
          ],
        };
      }
      const lines: string[] = [];
      for (const [i, message] of messages.entries()) {
        const label =
          messages.length > 1 ? `Withdraw message ${i + 1}/${messages.length}` : `Withdraw message`;
        const status = await message.status(childProvider);
        switch (status) {
          case ChildToParentMessageStatus.UNCONFIRMED:
            lines.push(
              `${label} is still unconfirmed, check back later (takes around 1 week for mainnet and 1 hour for sepolia)`,
            );
            break;
          case ChildToParentMessageStatus.CONFIRMED:
            {
              const execTx = await message.execute(childProvider);
              const link = await getTransactionExplorerLink(execTx);
              const execReceipt = await execTx.wait();
              lines.push(
                `${label}: claimed on chain ${ParentChainID}. Parent (L1) tx: ${execReceipt.transactionHash} (${execReceipt.status === 1 ? 'success' : 'reverted'}, block ${execReceipt.blockNumber}, gas used ${execReceipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}`,
              );
            }
            break;
          case ChildToParentMessageStatus.EXECUTED:
            lines.push(`${label} has already been executed on parent chain`);
            break;
          default:
            lines.push(`${label}: unknown status ${status}`);
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: lines.join('\n'),
          },
        ],
      };
    }
  },
);

// Looks good  
server.registerTool(
  'send_erc20',
  {
    description: 'send erc20 to an address',
    inputSchema: {
      chainID: z.number().describe('The chainID to make the transaction on'),
      tokenAddress: z.string().describe('The address of the token to send over'),
      recipient: z.string().describe('The recipient of the tokens'),
      amount: z.string().describe('The amount of tokens to send (in human-readable units)'),
    },
  },
  async ({ chainID, tokenAddress, recipient, amount }) => {
    const provider = rpcProviders.get(chainID);
    if (provider === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: `Chain: ${chainID} does not have a provider`,
          },
        ],
      };
    }

    const connectedWallet = wallet.connect(provider);
    const token = new Contract(tokenAddress, ERC20_ABI, connectedWallet);

    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol()]);
    const sendValue = utils.parseUnits(amount, decimals);

    const tx = await token.transfer(recipient, sendValue);

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
          text: `Sent ${amount} ${symbol} to ${recipient}: ${receipt.transactionHash} (${receipt.status === 1 ? 'success' : 'reverted'}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed.toString()})${link ? `\n\nView on explorer: ${link}` : ''}`,
        },
      ],
    };
  },
);

server.registerTool(
  'send_eth',
  {
    description: 'send eth to an address',
    inputSchema: {
      recipient: z.string().describe('The recipient of the tokens'),
      amount: z.string().describe('The amount of eth to send (in human readable units)'),
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
