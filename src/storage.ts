/**
 * OATT - Persistent storage for candidates, rejections, and history
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfigDir, ensureConfigDir } from './config.js';
import type { ChannelCandidate, OpenHistory, Rejection, CandidateSource } from './models.js';

// File paths
function getCandidatesPath(): string {
    return path.join(getConfigDir(), 'candidates.json');
}

function getHistoryDir(): string {
    return path.join(getConfigDir(), 'history');
}

// JSON serialization helpers (handle Date objects)
function serialize<T>(data: T): string {
    return JSON.stringify(data, null, 2);
}

function deserializeDates<T>(obj: T): T {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(deserializeDates) as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
            result[key] = new Date(value);
        } else if (typeof value === 'object' && value !== null) {
            result[key] = deserializeDates(value);
        } else {
            result[key] = value;
        }
    }
    return result as T;
}

// Load candidates
export function loadCandidates(): ChannelCandidate[] {
    ensureConfigDir();
    const candidatesPath = getCandidatesPath();

    if (!fs.existsSync(candidatesPath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(candidatesPath, 'utf-8');
        const parsed = JSON.parse(raw) as ChannelCandidate[];
        return parsed.map(deserializeDates);
    } catch (error) {
        console.error('Error loading candidates:', error);
        return [];
    }
}

// Save candidates
export function saveCandidates(candidates: ChannelCandidate[]): void {
    ensureConfigDir();
    const candidatesPath = getCandidatesPath();
    fs.writeFileSync(candidatesPath, serialize(candidates));
}

// Get a single candidate by pubkey
export function getCandidate(pubkey: string): ChannelCandidate | undefined {
    const candidates = loadCandidates();
    return candidates.find(c => c.pubkey === pubkey);
}

// Add or update a candidate
export function upsertCandidate(candidate: ChannelCandidate): void {
    const candidates = loadCandidates();
    const index = candidates.findIndex(c => c.pubkey === candidate.pubkey);

    if (index >= 0) {
        // Merge: keep existing history and rejections, update metrics
        const existing = candidates[index];
        candidates[index] = {
            ...candidate,
            history: [...existing.history, ...candidate.history.filter(
                h => !existing.history.some(eh => eh.channelId === h.channelId)
            )],
            rejections: [...existing.rejections, ...candidate.rejections],
            addedAt: existing.addedAt,  // Keep original add date
        };
        // Update learned minimum
        candidates[index].minChannelSize = Math.max(
            ...candidates[index].rejections
                .filter(r => r.reason === 'min_channel_size' && r.minChannelSize)
                .map(r => r.minChannelSize!),
            0
        ) || undefined;
    } else {
        candidates.push(candidate);
    }

    saveCandidates(candidates);
}

// Add a rejection to a candidate
export function addRejection(pubkey: string, rejection: Rejection): void {
    const candidates = loadCandidates();
    const candidate = candidates.find(c => c.pubkey === pubkey);

    if (candidate) {
        candidate.rejections.push(rejection);

        // Update learned minimum if applicable
        if (rejection.reason === 'min_channel_size' && rejection.minChannelSize) {
            candidate.minChannelSize = Math.max(
                candidate.minChannelSize ?? 0,
                rejection.minChannelSize
            );
        }

        saveCandidates(candidates);
    }
}

/**
 * Remove candidates by source
 */
export function removeCandidatesBySource(source: CandidateSource): number {
    const candidates = loadCandidates();
    const filtered = candidates.filter(c => c.source !== source);
    const removedCount = candidates.length - filtered.length;
    
    if (removedCount > 0) {
        saveCandidates(filtered);
    }
    
    return removedCount;
}

/**
 * Sync candidate node info
 */
export async function syncCandidateInfo(pubkey: string): Promise<void> {
    const { getNodeInfo } = await import('./lnd.js');
    const info = await getNodeInfo(pubkey);
    
    if (info) {
        upsertCandidate({
            pubkey,
            alias: info.alias,
            channels: info.channels,
            capacitySats: info.capacitySats,
            lastUpdate: info.lastUpdate,
            addedAt: new Date(), // Reset addedAt for fresh sync?
        } as any);
    }
}

// Remove a candidate
export function removeCandidate(pubkey: string): boolean {
    const candidates = loadCandidates();
    const index = candidates.findIndex(c => c.pubkey === pubkey);

    if (index >= 0) {
        candidates.splice(index, 1);
        saveCandidates(candidates);
        return true;
    }

    return false;
}

// Save open history
export function saveOpenHistory(history: OpenHistory): void {
    ensureConfigDir();
    const historyDir = getHistoryDir();

    if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
    }

    const filename = history.date.toISOString().split('T')[0] + '.json';
    const filepath = path.join(historyDir, filename);

    // Append to existing file if same day
    let existing: OpenHistory[] = [];
    if (fs.existsSync(filepath)) {
        try {
            const raw = fs.readFileSync(filepath, 'utf-8');
            existing = JSON.parse(raw) as OpenHistory[];
        } catch {
            existing = [];
        }
    }

    existing.push(history);
    fs.writeFileSync(filepath, serialize(existing));
}

// Load open history for a date
export function loadOpenHistory(date: Date): OpenHistory[] {
    const historyDir = getHistoryDir();
    const filename = date.toISOString().split('T')[0] + '.json';
    const filepath = path.join(historyDir, filename);

    if (!fs.existsSync(filepath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(filepath, 'utf-8');
        const parsed = JSON.parse(raw) as OpenHistory[];
        return parsed.map(deserializeDates);
    } catch (error) {
        console.error('Error loading history:', error);
        return [];
    }
}
