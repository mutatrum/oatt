/**
 * OATT - Graph distance collector
 *
 * Finds nodes that are far from your node in the graph (high distance).
 * Based on the logic from lnd_graph_crawl.js
 */

import { getNetworkGraph, getOwnPubkey, getNodeInfo } from '../lnd.js';
import { loadConfig } from '../config.js';
import { loadCandidates, upsertCandidate, getCandidate } from '../storage.js';
import type { ChannelCandidate, NodeInfo } from '../models.js';

interface GraphNode {
    pubkey: string;
    alias: string;
    lastUpdate: Date;
    channels: number;
    capacity: number;
    addresses: string[];
}

interface GraphEdge {
    node1: string;
    node2: string;
    capacity: number;
}

/**
 * Build adjacency list from network graph
 */
function buildAdjacencyList(
    nodes: Map<string, GraphNode>,
    edges: GraphEdge[]
): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();

    // Initialize all nodes
    for (const pubkey of nodes.keys()) {
        adjacency.set(pubkey, new Set());
    }

    // Add edges (bidirectional)
    for (const edge of edges) {
        adjacency.get(edge.node1)?.add(edge.node2);
        adjacency.get(edge.node2)?.add(edge.node1);
    }

    return adjacency;
}

/**
 * BFS to find distances from source node
 */
function computeDistances(
    adjacency: Map<string, Set<string>>,
    sourcePubkey: string
): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: string[] = [sourcePubkey];
    distances.set(sourcePubkey, 0);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const currentDistance = distances.get(current)!;

        const neighbors = adjacency.get(current);
        if (!neighbors) continue;

        for (const neighbor of neighbors) {
            if (!distances.has(neighbor)) {
                distances.set(neighbor, currentDistance + 1);
                queue.push(neighbor);
            }
        }
    }

    return distances;
}

/**
 * Collect graph distance candidates
 */
export async function collectGraphDistanceCandidates(options?: {
    minDistance?: number;
    minChannels?: number;
    minCapacity?: number;
    maxActiveDays?: number;
}): Promise<ChannelCandidate[]> {
    const config = loadConfig();

    const minDistance = options?.minDistance ?? config.defaults.minDistance;
    const minChannels = options?.minChannels ?? config.defaults.minChannels;
    const minCapacity = options?.minCapacity ?? config.defaults.minCapacity;
    const maxActiveDays = options?.maxActiveDays ?? config.defaults.activeDays;

    console.log('Fetching network graph...');
    const graph = await getNetworkGraph();
    const ownPubkey = await getOwnPubkey();

    console.log(`Graph has ${graph.nodes.length} nodes and ${graph.channels.length} channels`);

    // Build node map
    const nodes = new Map<string, GraphNode>();
    const nodeChannelCount = new Map<string, number>();
    const nodeCapacity = new Map<string, number>();

    // Count channels per node
    for (const channel of graph.channels) {
        for (const policy of channel.policies) {
            const pubkey = policy.public_key;
            nodeChannelCount.set(pubkey, (nodeChannelCount.get(pubkey) ?? 0) + 1);
            nodeCapacity.set(pubkey, (nodeCapacity.get(pubkey) ?? 0) + channel.capacity);
        }
    }

    // Build node info
    for (const node of graph.nodes) {
        nodes.set(node.public_key, {
            pubkey: node.public_key,
            alias: node.alias,
            lastUpdate: new Date(node.updated_at),
            channels: nodeChannelCount.get(node.public_key) ?? 0,
            capacity: nodeCapacity.get(node.public_key) ?? 0,
            addresses: node.sockets ?? [],
        });
    }

    // Build edges
    const edges: GraphEdge[] = graph.channels.map(ch => ({
        node1: ch.policies[0]?.public_key ?? '',
        node2: ch.policies[1]?.public_key ?? '',
        capacity: ch.capacity,
    })).filter(e => e.node1 && e.node2);

    // Build adjacency and compute distances
    console.log('Computing distances...');
    const adjacency = buildAdjacencyList(nodes, edges);
    const distances = computeDistances(adjacency, ownPubkey);

    // Filter candidates
    const now = new Date();
    const maxAgeMs = maxActiveDays * 24 * 60 * 60 * 1000;
    const existingCandidates = loadCandidates();
    const existingByPubkey = new Map(existingCandidates.map(c => [c.pubkey, c]));

    const candidates: ChannelCandidate[] = [];

    for (const [pubkey, node] of nodes) {
        // Skip self
        if (pubkey === ownPubkey) continue;

        const distance = distances.get(pubkey);

        // Skip unreachable or too close
        if (distance === undefined || distance < minDistance) continue;

        // Apply filters
        if (node.channels < minChannels) continue;
        if (node.capacity < minCapacity) continue;

        const age = now.getTime() - node.lastUpdate.getTime();
        if (age > maxAgeMs) continue;

        // Skip nodes without addresses
        if (node.addresses.length === 0) continue;

        // Get existing candidate data if any
        const existing = existingByPubkey.get(pubkey);

        const candidate: ChannelCandidate = {
            pubkey,
            alias: node.alias,
            sources: ['graph_distance'],
            addedAt: existing?.addedAt ?? new Date(),
            channels: node.channels,
            capacitySats: node.capacity,
            lastUpdate: node.lastUpdate,
            distance,
            history: existing?.history ?? [],
            rejections: existing?.rejections ?? [],
            minChannelSize: existing?.minChannelSize,
        };

        candidates.push(candidate);
    }

    // Sort by distance (descending) then by channels (descending)
    candidates.sort((a, b) => {
        const distDiff = (b.distance ?? 0) - (a.distance ?? 0);
        if (distDiff !== 0) return distDiff;
        return b.channels - a.channels;
    });

    return candidates;
}

/**
 * Run graph distance collection and save results
 */
export async function runGraphDistanceCollection(options?: {
    minDistance?: number;
    minChannels?: number;
    minCapacity?: number;
}): Promise<number> {
    const candidates = await collectGraphDistanceCandidates(options);

    console.log(`Found ${candidates.length} candidates at distance >= ${options?.minDistance ?? 2}`);

    // Clear old graph candidates
    const { removeCandidatesBySource } = await import('../storage.js');
    const removed = removeCandidatesBySource('graph_distance');
    if (removed > 0) {
        console.log(`Cleared ${removed} old graph candidates`);
    }

    // Save each candidate
    for (const candidate of candidates) {
        upsertCandidate(candidate);
    }

    return candidates.length;
}
