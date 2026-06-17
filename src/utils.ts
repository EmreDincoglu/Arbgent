import type { providers } from 'ethers';

export async function getTransactionExplorerLink(
  tx: providers.TransactionResponse,
): Promise<string | undefined> {
  switch (tx.chainId) {
    case 42161:
      return `https://arbiscan.io/tx/${tx.hash}`;
    case 421614:
      return `https://sepolia.arbiscan.io/tx/${tx.hash}`;
    case 1:
      return `https://etherscan.io/tx/${tx.hash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${tx.hash}`;
    default:
      return undefined;
  }
}
