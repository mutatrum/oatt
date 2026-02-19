/**
 * OATT - Forwarding history collector
 *
 * Analyzes your forwarding history to find nodes that are high-value routing
 * partners. Peers from *closed* channels that routed well are the primary output:
 * we can't see beyond our direct neighbors, but we CAN see if a peer whose
 * channel we've since closed was historically profitable.
 *
 * Algorithm:
 * 1. Fetch recent forwards + current open channels + closed channels
 * 2. Build channelId → pubkey map from BOTH open and closed channels
 * 3. Score each peer: sum(fee_earned) for each forward they appeared in
 * 4. Filter to only peers where the channel is NOW CLOSED (open ones are filtered out)
 * 5. Rank by score, return top-N
 */

import { getForwardingHistory, getChannels, getClosedChannels, getNodeInfo } from '../lnd.js';
import { loadCandidates, upsertCandidate } from '../storage.js';
import type { ChannelCandidate } from '../models.js';

export interface ForwardsCollectionOptions {
    /** How many days of history to look back (default: 30) */
    days?: number;
    /** How many top candidates to return (default: 20) */
    topN?: number;
    /** Minimum score (fee sats) to be considered a candidate (default: 0) */
    minScore?: number;
}

interface PeerScore {
    pubkey: string;
    totalFeesSats: number;      // Total fees earned from forwards involving this peer
    totalVolumeSats: number;    // Total volume forwarded involving this peer
    inboundCount: number;       // Times appeared as incoming peer
    outboundCount: number;      // Times appeared as outgoing peer
    bidirectional: boolean;     // Appeared on both sides (strongest signal)
}

/**
 * Analyse forwarding history and score peers
 */
export async function collectForwardingCandidates(
    options: ForwardsCollectionOptions = {}
): Promise<ChannelCandidate[]> {
    const { days = 30, topN = 20, minScore = 0 } = options;

    // Time window
    const after = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    console.log(`Fetching forwards from last ${days} days...`);
    const [forwards, channels, closedChannels] = await Promise.all([
        getForwardingHistory(after),
        getChannels(),
        getClosedChannels(),
    ]);

    console.log(`  Got ${forwards.length} forwards`);

    // Track existing (open) channel partners — these are NOT candidates
    const openPeerPubkeys = new Set(channels.map(c => c.partner_public_key));

    // Track closed channel peers — these ARE potential candidates
    const closedPeerPubkeys = new Set(closedChannels.map(c => c.partner_public_key));

    // Build channelId → pubkey map from BOTH open AND closed channels
    const channelToPubkey = new Map<string, string>();
    for (const ch of channels) {
        channelToPubkey.set(ch.id, ch.partner_public_key);
    }
    for (const ch of closedChannels) {
        if (ch.id) channelToPubkey.set(ch.id, ch.partner_public_key);
    }

    console.log(`  ${channels.length} open channels, ${closedChannels.length} closed channels mapped`);

    // Score each peer
    const scores = new Map<string, PeerScore>();

    const getOrCreate = (pubkey: string): PeerScore => {
        if (!scores.has(pubkey)) {
            scores.set(pubkey, {
                pubkey,
                totalFeesSats: 0,
                totalVolumeSats: 0,
                inboundCount: 0,
                outboundCount: 0,
                bidirectional: false,
            });
        }
        return scores.get(pubkey)!;
    };

    let unmapped = 0;
    for (const fwd of forwards) {
        const inboundPubkey = channelToPubkey.get(fwd.incoming_channel);
        const outboundPubkey = channelToPubkey.get(fwd.outgoing_channel);

        if (!inboundPubkey && !outboundPubkey) {
            unmapped++;
            continue;
        }

        const feeSats = (fwd.fee ?? 0);
        const volumeSats = Math.round((fwd.tokens ?? 0));

        if (inboundPubkey) {
            const s = getOrCreate(inboundPubkey);
            s.totalFeesSats += feeSats;
            s.totalVolumeSats += volumeSats;
            s.inboundCount++;
        }

        if (outboundPubkey) {
            const s = getOrCreate(outboundPubkey);
            s.totalFeesSats += feeSats;
            s.totalVolumeSats += volumeSats;
            s.outboundCount++;
        }
    }

    if (unmapped > 0) {
        console.log(`  ${unmapped} forwards could not be mapped to any known channel`);
    }

    // Show how many scored peers came from closed vs open channels
    const closedScored = Array.from(scores.keys()).filter(k => closedPeerPubkeys.has(k) && !openPeerPubkeys.has(k)).length;
    const openScored = Array.from(scores.keys()).filter(k => openPeerPubkeys.has(k)).length;
    console.log(`  Scored peers: ${openScored} open (will be filtered out), ${closedScored} from closed channels`);

    // Mark bidirectional peers
    for (const score of scores.values()) {
        score.bidirectional = score.inboundCount > 0 && score.outboundCount > 0;
    }

    // Sort: bidirectional first, then by total fees
    const ranked = Array.from(scores.values())
        .filter(s => s.totalFeesSats >= minScore)
        .filter(s => !openPeerPubkeys.has(s.pubkey))  // Skip existing partners
        .sort((a, b) => {
            // Bidirectional peers rank higher
            if (a.bidirectional !== b.bidirectional) {
                return a.bidirectional ? -1 : 1;
            }
            return b.totalFeesSats - a.totalFeesSats;
        })
        .slice(0, topN);

    console.log(`  ${ranked.length} unique peers scored (${scores.size - ranked.length} filtered)`);

    // Resolve node info and build candidates
    const existingCandidates = loadCandidates();
    const existingByPubkey = new Map(existingCandidates.map(c => [c.pubkey, c]));

    const candidates: ChannelCandidate[] = [];

    for (const score of ranked) {
        const nodeInfo = await getNodeInfo(score.pubkey);
        if (!nodeInfo) {
            console.log(`  Skipping ${score.pubkey.slice(0, 12)}...: not in graph`);
            continue;
        }
        if (nodeInfo.addresses.length === 0) {
            console.log(`  Skipping ${nodeInfo.alias}: no addresses`);
            continue;
        }

        const existing = existingByPubkey.get(score.pubkey);

        candidates.push({
            pubkey: score.pubkey,
            alias: nodeInfo.alias,
            source: 'forwarding_history',
            addedAt: existing?.addedAt ?? new Date(),
            channels: nodeInfo.channels,
            capacitySats: nodeInfo.capacitySats,
            lastUpdate: nodeInfo.lastUpdate,
            history: existing?.history ?? [],
            rejections: existing?.rejections ?? [],
            minChannelSize: existing?.minChannelSize,
        });

        const dir = score.bidirectional ? '↔' : score.inboundCount > 0 ? '←' : '→';
        console.log(
            `  ${dir} ${nodeInfo.alias.padEnd(30)} ` +
            `${String(score.totalFeesSats).padStart(8)} sats fees  ` +
            `${String(Math.round(score.totalVolumeSats / 1000)).padStart(10)} k sats vol`
        );
    }

    return candidates;
}

/**
 * Run forwarding history collection and save results
 */
export async function runForwardingHistoryCollection(
    options: ForwardsCollectionOptions = {}
): Promise<number> {
    const candidates = await collectForwardingCandidates(options);

    console.log(`\nFound ${candidates.length} candidates from forwarding history`);

    // Clear old forwarding_history candidates and replace
    const { removeCandidatesBySource } = await import('../storage.js');
    removeCandidatesBySource('forwarding_history');

    for (const candidate of candidates) {
        upsertCandidate(candidate);
    }

    return candidates.length;
}
