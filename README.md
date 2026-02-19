# OATT - Open All The Things

Automated Lightning Network channel manager for batch channel opens with rejection tracking.

## The Problem

Managing Lightning Network channels efficiently often involves a repetitive, manual workflow:
1. **Finding Peers**: Identifying suitable nodes (e.g., nodes that force-closed on you previously, or well-connected nodes at a specific distance in the network graph).
2. **Batch Management**: Manually calculating how to distribute a total funding budget across multiple peers to maximize channel count while respecting their varying minimum size requirements.
3. **Execution & Failure**: Trial-and-error opens frequently fail because a peer's minimum channel size isn't public, or a peer is offline. These reasons are usually lost once the command finishes.
4. **Manual Tracking**: Forced to keep manual notes or spreadsheets of which nodes to avoid or which need larger funding amounts.

OATT (Open All The Things) automates this cycle into a single, cohesive workflow.

## The Workflow

1. **Collect**: OATT gathers candidates from your node's history (smart force-close detection), forwarding history (identifying profitable routing partners), and the network graph (BFS distance analysis).
2. **Plan**: You define a budget. OATT automatically suggests an allocation that maximizes the number of channels while respecting known minimums. You can interactively add, remove, or resize channels.
3. **Execute & Converge**: Channels are opened in a single, efficient PSBT batch transaction. OATT uses a **Convergence Loop** that automatically re-plans the batch if any peer fails to connect or rejects the initiation (Step 2). It backfills your budget with next-best candidates on the fly.
4. **Safety Verification**: Before any on-chain transaction is broadcast, OATT presents the final converged plan for approval. If you abort, it automatically cleans up LND's pending stubs.
5. **Learn**: Failures are automatically parsed. If a node rejects a channel for being too small, OATT records that minimum and applies it to your next planning session. Candidates that appear in multiple collectors are tagged with multiple sources, providing a stronger "multi-signal" for selection.

## Features

- **Collect candidates** from force-closed channels, forwarding history, and graph distance analysis
- **Multi-source tracking**: Candidates found by multiple algorithms are tagged (e.g., `[Graph|Forwards]`) to highlight high-quality routing partners.
- **Track rejections** with reasons and minimum channel sizes
- **Plan batch opens** with budget optimization
- **Execute opens** via ln-service with PSBT batching.
- **Opportunistic Backfilling**: Automatic re-planning during execution to maximize budget usage when peers are offline or flukey.
- **Smart Partner Filtering**: Automatically skips candidates with existing **active or pending** channels.
- **Safety Guards**: Final user confirmation before broadcast + automatic pending stub cleanup on abort.

## Installation

```bash
npm install
npm run build
```

### Running the CLI

There are several ways to run the CLI:

**Development mode** (no build needed):
```bash
npm run dev -- <command>
```

**After building**:
```bash
npm start -- <command>
# Or directly:
node dist/cli.js <command>
```

**Global install** (makes `oatt` available system-wide):
```bash
npm link
oatt <command>
```

To remove the global link later:
```bash
npm unlink -g oatt
```

## Configuration

Create `~/.oatt/config.json`:

```json
{
  "lnd": {
    "socket": "localhost:10009",
    "macaroonPath": "~/.lnd/data/chain/bitcoin/mainnet/admin.macaroon",
    "certPath": "~/.lnd/tls.cert"
  }
}
```

## Usage

### Check Connection

```bash
oatt status
```

### Collect Candidates

```bash
# From force-closed channels
oatt collect force-closed

# From graph distance analysis
oatt collect graph -d 2 -c 10 -s 10000000
# Options:
#   -d, --min-distance <n>     Minimum distance from your node (default: 2)
#   -c, --min-channels <n>     Minimum channels the node should have (default: 10)
#   -s, --min-capacity <sats>  Minimum capacity in sats (default: 10000000)

# From forwarding history (fee/volume scoring)
oatt collect forwards --days 30 --top-n 20
# Options:
#   -d, --days <n>             Days of history to analyse (default: 30)
#   -n, --top-n <n>            Number of top candidates to output (default: 20)
#   -s, --min-score <sats>     Minimum fee sats to qualify (default: 0)

# Manually add a node
oatt collect add <pubkey>

# Sync graph distances for all candidates
oatt collect sync
```

### List Candidates

```bash
# List all candidates
oatt list

# List only eligible candidates (no blocking rejections)
oatt list --eligible

# Show all details including rejections
oatt list --all

# Sort by graph distance
oatt list --by-distance
```

### Manage Candidates

```bash
# Record a rejection for a node
oatt reject <pubkey> --reason <reason> [--min-size <sats>] [--note <text>]

# Remove a candidate
oatt remove <pubkey>
```

Valid rejection reasons:
- `min_channel_size` - Node requires minimum channel size (learned and buffered)
- `already_open` - Node already has an active or pending channel (filtered)
- `failed_to_connect` - Node was unreachable (Tor/Clearnet)
- `not_online` - Node is currently offline
- `too_many_pending` - Remote peer has too many pending channels
- `coop_close` - Recent cooperative close (blocked)
- `no_anchors` - Node doesn't support anchors (blocked)
- `internal_error` - Unexpected LND/Node error

### Plan Batch Opens

```bash
# Interactive planning
oatt plan --budget 10000000

# Options:
#   -b, --budget <sats>        Total budget in sats (required)
#   -s, --default-size <sats>  Default channel size (default: 1000000)
#   -m, --max-size <sats>      Maximum channel size (default: 10000000)
```

The interactive planner allows you to:
- Execute the plan
- Add/remove candidates
- Resize channels
- Generate a `bos` (Balance of Satoshis) command
- Quit without executing

### Execute Channel Opens

```bash
# Dry-run (show what would happen)
oatt open --budget 10000000 --dry-run

# Execute for real
oatt open --budget 10000000

# Options:
#   -b, --budget <sats>        Total budget in sats (required)
#   -s, --default-size <sats>  Default channel size (default: 1000000)
#   -m, --max-size <sats>      Maximum channel size (default: 10000000)
#   --dry-run                  Show what would happen without opening
```

### Show Configuration

```bash
oatt config
```

## License

MIT
