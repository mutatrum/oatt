/**
 * OATT - Force-closed channel collector
 *
 * Finds force-closed channels that are candidates for reopening.
 * Smart filtering: skip peers where we reopened after force-close and then coop-closed.
 */

import {
    getClosedChannels,
    getChannels,
    getNodeInfo,
    getCloseType,
    toChannelHistory,
} from '../lnd.js';
import { loadCandidates, upsertCandidate } from '../storage.js';
import type { ChannelCandidate, ChannelHistory, CloseType } from '../models.js';

interface PeerChannelSummary {
    pubkey: string;
    channels: ChannelHistory[];
    hasForceClose: boolean;
    hasCoopCloseAfterForce: boolean;
    allClosedByUs: boolean;  // All closes were local_force
}

/**
 * Analyze channel history with a peer to determine if they're a good candidate
 */
function analyzePeerHistory(channels: ChannelHistory[]): {
    isCandidate: boolean;
    reason?: string;
} {
    if (channels.length === 0) {
        return { isCandidate: false, reason: 'no channels' };
    }

    // Sort by close date
    const sorted = [...channels].sort((a, b) =>
        (a.closedAt?.getTime() ?? 0) - (b.closedAt?.getTime() ?? 0)
    );

    // Check if there's a force close by peer (remote_force)
    const hasRemoteForceClose = sorted.some(c => c.closeType === 'remote_force');

    if (!hasRemoteForceClose) {
        return { isCandidate: false, reason: 'no remote force close' };
    }

    // Find the last remote force close
    const lastForceCloseIndex = sorted.findLastIndex(c => c.closeType === 'remote_force');

    // Check if there's a coop close AFTER the last force close
    // This means we reopened and then coop-closed, so probably shouldn't try again
    const hasCoopAfterForce = sorted
        .slice(lastForceCloseIndex + 1)
        .some(c => c.closeType === 'coop');

    if (hasCoopAfterForce) {
        return { isCandidate: false, reason: 'coop closed after reopening' };
    }

    // Check if WE force-closed after their force-close
    // This means we had issues with them too
    const hasLocalForceAfter = sorted
        .slice(lastForceCloseIndex + 1)
        .some(c => c.closeType === 'local_force');

    if (hasLocalForceAfter) {
        return { isCandidate: false, reason: 'we force closed after reopening' };
    }

    return { isCandidate: true };
}

/**
 * Collect force-closed channel candidates
 */
export async function collectForceClosedCandidates(): Promise<ChannelCandidate[]> {
    // Get all closed channels
    const closedChannels = await getClosedChannels();

    // Get currently open channels (to exclude peers we already have channels with)
    const openChannels = await getChannels();
    const openPeerPubkeys = new Set(openChannels.map(c => c.partner_public_key));

    // Get existing candidates to check for already-known rejections
    const existingCandidates = loadCandidates();
    const existingByPubkey = new Map(existingCandidates.map(c => [c.pubkey, c]));

    // Group closed channels by peer
    const peerChannels = new Map<string, ChannelHistory[]>();

    for (const closed of closedChannels) {
        const pubkey = closed.partner_public_key;
        const history = toChannelHistory(closed);

        if (!peerChannels.has(pubkey)) {
            peerChannels.set(pubkey, []);
        }
        peerChannels.get(pubkey)!.push(history);
    }

    // Analyze each peer
    const candidates: ChannelCandidate[] = [];

    for (const [pubkey, channels] of peerChannels) {
        // Skip if we already have an open channel with this peer
        if (openPeerPubkeys.has(pubkey)) {
            continue;
        }

        // Analyze channel history
        const { isCandidate, reason } = analyzePeerHistory(channels);

        if (!isCandidate) {
            console.log(`Skipping ${pubkey.slice(0, 12)}...: ${reason}`);
            continue;
        }

        // Get node info from graph
        const nodeInfo = await getNodeInfo(pubkey);

        if (!nodeInfo) {
            console.log(`Skipping ${pubkey.slice(0, 12)}...: not found in graph`);
            continue;
        }

        // Check if node has no addresses (can't connect)
        if (nodeInfo.addresses.length === 0) {
            console.log(`Skipping ${nodeInfo.alias}: no addresses`);
            continue;
        }

        // Get existing candidate data if any
        const existing = existingByPubkey.get(pubkey);

        const candidate: ChannelCandidate = {
            pubkey,
            alias: nodeInfo.alias,
            source: 'force_closed',
            addedAt: existing?.addedAt ?? new Date(),
            channels: nodeInfo.channels,
            capacitySats: nodeInfo.capacitySats,
            lastUpdate: nodeInfo.lastUpdate,
            history: channels,
            rejections: existing?.rejections ?? [],
            minChannelSize: existing?.minChannelSize,
        };

        candidates.push(candidate);
    }

    return candidates;
}

/**
 * Run force-closed collection and save results
 */
export async function runForceClosedCollection(): Promise<number> {
    const candidates = await collectForceClosedCandidates();

    console.log(`Found ${candidates.length} candidates from force-closed channels`);

    // Clear old force-closed candidates
    const { removeCandidatesBySource } = await import('../storage.js');
    removeCandidatesBySource('force_closed');

    // Save each candidate
    for (const candidate of candidates) {
        upsertCandidate(candidate);
    }

    return candidates.length;
}
