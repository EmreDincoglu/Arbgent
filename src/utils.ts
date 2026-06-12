import type { providers } from 'ethers';

export async function getTransactionExplorerLink(
  ts: providers.TransactionResponse,
): Promise<string | undefined> {
  switch (ts.chainId) {
    case 42161:
      return `https://arbiscan.io/tx/${ts.hash}`;
    case 421614:
      return `https://sepolia.arbiscan.io/tx/${ts.hash}`;
    case 1:
      return `https://etherscan.io/tx/${ts.hash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${ts.hash}`;
    default:
      return undefined;
  }
}
