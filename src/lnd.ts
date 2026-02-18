/**
 * OATT - LND client wrapper using ln-service
 */

import * as fs from 'node:fs';
import * as lnService from 'ln-service';
import { loadConfig } from './config.js';
import type { ChannelHistory, CloseType, NodeInfo } from './models.js';

// Re-export types from ln-service for use elsewhere
type Channel = Awaited<ReturnType<typeof lnService.getChannels>>['channels'][0];
type ClosedChannel = Awaited<ReturnType<typeof lnService.getClosedChannels>>['channels'][0];
type Forward = Awaited<ReturnType<typeof lnService.getForwards>>['forwards'][0];
type NetworkGraph = Awaited<ReturnType<typeof lnService.getNetworkGraph>>;

// LND connection singleton
let authenticatedLnd: lnService.AuthenticatedLnd | null = null;

export async function connectLnd(): Promise<lnService.AuthenticatedLnd> {
    if (authenticatedLnd) {
        return authenticatedLnd;
    }

    const config = loadConfig();

    // Read macaroon and cert
    const macaroon = fs.readFileSync(config.lnd.macaroonPath).toString('hex');
    const cert = fs.readFileSync(config.lnd.certPath).toString('base64');

    authenticatedLnd = lnService.authenticatedLndGrpc({
        socket: config.lnd.socket,
        macaroon,
        cert,
    });

    return authenticatedLnd;
}

// Get node info
export async function getNodeInfo(pubkey: string): Promise<NodeInfo | null> {
    try {
        const { lnd } = await connectLnd();

        const info = await lnService.getNode({ lnd, public_key: pubkey, is_omitting_channels: true });

        return {
            pubkey: info.public_key,
            alias: info.alias,
            channels: info.channel_count,
            capacitySats: info.capacity,
            lastUpdate: new Date(info.updated_at),
            addresses: info.sockets?.map((s: { socket: string }) => s.socket) ?? [],
            features: info.features?.map((f: { type: string }) => f.type) ?? [],
        };
    } catch (error) {
        // Suppress loud error for nodes not in the graph
        const isUnknown = Array.isArray(error) && error[0] === 404 && error[1] === 'NodeIsUnknown';
        if (!isUnknown) {
            console.error(`Error getting node info for ${pubkey}:`, error);
        }
        return null;
    }
}

// Get own node pubkey
export async function getOwnPubkey(): Promise<string> {
    const { lnd } = await connectLnd();
    const info = await lnService.getWalletInfo({ lnd });
    return info.public_key;
}

// Get on-chain balance
export async function getChainBalance(): Promise<{ confirmed: number; unconfirmed: number }> {
    const { lnd } = await connectLnd();
    const confirmed = await lnService.getChainBalance({ lnd });
    const pending = await lnService.getPendingChainBalance({ lnd });
    
    return {
        confirmed: confirmed.chain_balance ?? 0,
        unconfirmed: pending.pending_chain_balance ?? 0,
    };
}

// Get open channels
export async function getChannels(): Promise<Channel[]> {
    const { lnd } = await connectLnd();
    const result = await lnService.getChannels({ lnd });
    return result.channels;
}

// Get closed channels
export async function getClosedChannels(): Promise<ClosedChannel[]> {
    const { lnd } = await connectLnd();
    const result = await lnService.getClosedChannels({ lnd });
    return result.channels;
}

// Get forwarding history
export async function getForwardingHistory(after?: Date, before?: Date): Promise<Forward[]> {
    const { lnd } = await connectLnd();
    const result = await lnService.getForwards({
        lnd,
        after: after?.toISOString(),
        before: before?.toISOString(),
    });
    return result.forwards;
}

// Get network graph
export async function getNetworkGraph(): Promise<NetworkGraph> {
    const { lnd } = await connectLnd();
    const result = await lnService.getNetworkGraph({ lnd });
    return result;
}

// Open a channel
export async function openChannel(
    pubkey: string,
    localAmount: number,
    options?: {
        isPrivate?: boolean;
        baseFee?: number;
        feeRate?: number;
    }
): Promise<{ channelId: string }> {
    const { lnd } = await connectLnd();

    const result = await lnService.openChannel({
        lnd,
        partner_public_key: pubkey,
        local_tokens: localAmount,
        is_private: options?.isPrivate ?? false,
    });

    return { channelId: result.transaction_id + ':' + result.transaction_vout };
}

// Determine close type from closed channel info
export function getCloseType(closedChannel: ClosedChannel): CloseType {
    if (closedChannel.is_cooperative_close) {
        return 'coop';
    }
    if (closedChannel.is_local_force_close) {
        return 'local_force';
    }
    return 'remote_force';
}

// Build channel history from closed channel data
export function toChannelHistory(closedChannel: ClosedChannel): ChannelHistory {
    return {
        channelId: closedChannel.id,
        openedAt: new Date(), // We don't have this info from closedChannels
        closedAt: new Date(), // We don't have exact close time either
        closeType: getCloseType(closedChannel),
        localBalance: closedChannel.final_local_balance,
        remoteBalance: 0, // Not available from closedChannels
        satsRouted: 0, // Will be filled from forwarding history
        feesEarned: 0, // Will be filled from forwarding history
    };
}

// Connect to a peer
export async function connectPeer(pubkey: string, socket: string, timeout?: number): Promise<void> {
    const { lnd } = await connectLnd();
    await lnService.addPeer({
        lnd,
        public_key: pubkey,
        socket,
        timeout,
    });
}

// Get connected peers
export async function getConnectedPeers(): Promise<string[]> {
    const { lnd } = await connectLnd();
    const result = await lnService.getPeers({ lnd });
    return result.peers.map(p => p.public_key);
}
