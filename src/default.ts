export const CHAIN_INFO = {
  ArbSepolia: {
    chainID: 421614,
    RPC_URL: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  ArbOne: {
    chainID: 42161,
    RPC_URL: 'https://arb1.arbitrum.io/rpc',
  },
  EthSepolia: {
    chainID: 11155111,
    RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  EthMainnet: {
    chainID: 1,
    RPC_URL: 'https://ethereum-rpc.publicnode.com',
  },
};

export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
