# Arbgent

An MCP server that lets Claude bridge and send ETH across Ethereum and Arbitrum. It exposes three tools:

- `bridge_eth_L1_to_L2` — deposit ETH from a parent (L1) chain to a child (L2) chain
- `bridge_status` — check the status of a bridge deposit
- `send_eth` — send ETH to an address on a given chain

Supported chains: Ethereum Mainnet (`1`), Ethereum Sepolia (`11155111`), Arbitrum One (`42161`), Arbitrum Sepolia (`421614`).

## Setup

All you need is a **private key** and to register the server in your **Claude config**.

### 1. Install and build

```bash
pnpm install
pnpm build
```

This compiles the server to `dist/index.js`.

### 2. Provide your private key

The server reads the signing key from the `PRIVATE_KEY` environment variable, which you pass through the Claude config (see the next step).

> ⚠️ This key signs and sends real transactions. Use a dedicated, low-value wallet — never your main account.

#### Optional: custom RPC URLs

Public RPCs are used by default. To override any of them, add these alongside `PRIVATE_KEY` in the Claude config:

```
ARB_ONE_RPC=...
ETH_MAINNET_RPC=...
ARB_SEPOLIA_RPC=...
ETH_SEPOLIA_RPC=...
```

### 3. Register Arbgent in the Claude files

Add the server to your Claude MCP config so Claude can launch it.

**Claude Code** — add an `.mcp.json` in your project (or your user config):

```json
{
  "mcpServers": {
    "Arbgent": {
      "command": "node",
      "args": ["/absolute/path/to/Arbgent/dist/index.js"],
      "env": {
        "PRIVATE_KEY": "0xyour_private_key_here"
      }
    }
  }
}
```

**Claude Desktop** — add the same block to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Use the absolute path to `dist/index.js`, and put your private key in the `env` block as shown.

### 4. Restart Claude

Restart Claude Code / Claude Desktop so it picks up the config. You should see Arbgent connect (it logs `Arbgent is Running`), and the three tools become available.

## Usage

Once connected, just ask Claude in natural language, e.g.:

- "Bridge 0.01 ETH from Sepolia to Arbitrum Sepolia."
- "What's the status of bridge tx 0x… from chain 11155111 to 421614?"
- "Send 0.005 ETH to 0x… on Arbitrum One."
