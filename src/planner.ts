/**
 * OATT - Batch channel open planner
 *
 * Allocates budget across candidates, respecting minimum channel sizes.
 * Goal: Maximize number of channels for a given budget.
 */

import { loadCandidates, saveCandidates } from './storage.js';
import { loadConfig } from './config.js';
import { REJECTION_CONFIG, ANCHOR_RESERVE, type ChannelCandidate, type OpenPlan, type PlannedChannel } from './models.js';

export interface PlanOptions {
    budget: number;
    defaultSize: number;
    maxSize: number;
    candidates?: ChannelCandidate[];  // Optional override, otherwise load from storage
    openPeerPubkeys?: Set<string>;
}

/**
 * Check if a candidate is eligible for channel opens
 */
export function isEligible(candidate: ChannelCandidate, openPeerPubkeys?: Set<string>): boolean {
    // If we already have a channel with this peer, they are not eligible
    if (openPeerPubkeys?.has(candidate.pubkey)) {
        return false;
    }

    // No rejections = eligible
    if (candidate.rejections.length === 0) {
        return true;
    }

    // Check each rejection
    for (const rejection of candidate.rejections) {
        const config = REJECTION_CONFIG[rejection.reason];

        // Non-retryable rejection = not eligible
        if (!config.retryable) {
            return false;
        }

        // Check cooldown for retryable rejections
        if (config.cooldownDays !== undefined && config.cooldownDays > 0) {
            const cooldownMs = config.cooldownDays * 24 * 60 * 60 * 1000;
            const age = Date.now() - new Date(rejection.date).getTime();
            if (age < cooldownMs) {
                return false;  // Still in cooldown
            }
        }
    }

    return true;
}

/**
 * Get the effective minimum channel size for a candidate
 */
function getEffectiveMinimum(candidate: ChannelCandidate, defaultSize: number): number {
    return Math.max(candidate.minChannelSize ?? 0, defaultSize);
}

/**
 * Sort candidates by "signal" (quality/reliability)
 */
export function sortCandidatesBySignal(candidates: ChannelCandidate[]): ChannelCandidate[] {
    return candidates.slice().sort((a, b) => {
        // 1. Manual source always comes before others
        const aManual = a.sources.includes('manual');
        const bManual = b.sources.includes('manual');
        if (aManual && !bManual) return -1;
        if (!aManual && bManual) return 1;

        // 2. Profitable History (Total fees earned)
        const aFees = a.history.reduce((sum, h) => sum + (h.feesEarned ?? 0), 0);
        const bFees = b.history.reduce((sum, h) => sum + (h.feesEarned ?? 0), 0);
        if (aFees > bFees) return -1;
        if (aFees < bFees) return 1;

        // 3. Multi-Signal (Source count)
        if (a.sources.length > b.sources.length) return -1;
        if (a.sources.length < b.sources.length) return 1;

        // 4. Potential (Capacity * Channels)
        const aScore = a.capacitySats * a.channels;
        const bScore = b.capacitySats * b.channels;
        if (aScore > bScore) return -1;
        if (aScore < bScore) return 1;

        // 5. Recency
        return b.addedAt.getTime() - a.addedAt.getTime();
    });
}

/**
 * Create a batch open plan
 */
export function createPlan(options: PlanOptions): OpenPlan {
    const { budget, defaultSize, maxSize } = options;

    // Get candidates - either from options or storage
    let candidates = options.candidates ?? loadCandidates();

    // Filter to eligible candidates only
    candidates = candidates.filter(c => isEligible(c, options.openPeerPubkeys));

    // Filter out candidates with minimum > maxSize
    candidates = candidates.filter(c => getEffectiveMinimum(c, defaultSize) <= maxSize);

    // Prioritize by signal quality
    candidates = sortCandidatesBySignal(candidates);

    // Allocate budget
    const plannedChannels: PlannedChannel[] = [];
    let remaining = budget;

    for (const candidate of candidates) {
        const effectiveMin = getEffectiveMinimum(candidate, defaultSize);
        const requiredAmount = effectiveMin + ANCHOR_RESERVE;

        // Can we afford this channel + its anchor reserve?
        if (requiredAmount > remaining) {
            continue;  // Skip, but try smaller candidates next
        }

        // Add to plan
        plannedChannels.push({
            pubkey: candidate.pubkey,
            alias: candidate.alias,
            amount: effectiveMin,
            isMinimumEnforced: effectiveMin > defaultSize,
        });

        remaining -= requiredAmount;

        // Stop if we can't afford even the default size anymore
        if (remaining < (defaultSize + ANCHOR_RESERVE)) {
            break;
        }
    }

    return {
        createdAt: new Date(),
        budget,
        defaultSize,
        maxSize,
        channels: plannedChannels,
        totalAmount: plannedChannels.reduce((sum, ch) => sum + ch.amount, 0),
        remainingBudget: remaining,
    };
}

/**
 * Add a candidate to an existing plan
 */
export function addToPlan(plan: OpenPlan, pubkey: string, amount?: number): OpenPlan {
    const candidates = loadCandidates();
    const candidate = candidates.find(c => c.pubkey === pubkey);

    if (!candidate) {
        throw new Error(`Candidate ${pubkey} not found`);
    }

    const effectiveAmount = amount ?? getEffectiveMinimum(candidate, plan.defaultSize);

    if (effectiveAmount > plan.remainingBudget) {
        throw new Error(`Not enough budget. Need ${effectiveAmount}, have ${plan.remainingBudget}`);
    }

    // Add to plan
    plan.channels.push({
        pubkey: candidate.pubkey,
        alias: candidate.alias,
        amount: effectiveAmount,
        isMinimumEnforced: effectiveAmount > plan.defaultSize,
    });

    plan.totalAmount += effectiveAmount;
    plan.remainingBudget -= effectiveAmount;

    return plan;
}

/**
 * Remove a channel from the plan by index
 */
export function removeFromPlan(plan: OpenPlan, index: number): OpenPlan {
    if (index < 0 || index >= plan.channels.length) {
        throw new Error(`Invalid index ${index}`);
    }

    const removed = plan.channels.splice(index, 1)[0];
    plan.totalAmount -= removed.amount;
    plan.remainingBudget += removed.amount;

    return plan;
}

/**
 * Resize a channel in the plan
 */
export function resizeInPlan(plan: OpenPlan, index: number, newAmount: number): OpenPlan {
    if (index < 0 || index >= plan.channels.length) {
        throw new Error(`Invalid index ${index}`);
    }

    const channel = plan.channels[index];
    const diff = newAmount - channel.amount;

    if (diff > plan.remainingBudget) {
        throw new Error(`Not enough budget. Need ${diff} more, have ${plan.remainingBudget}`);
    }

    channel.amount = newAmount;
    channel.isMinimumEnforced = newAmount > plan.defaultSize;
    plan.totalAmount += diff;
    plan.remainingBudget -= diff;

    return plan;
}

/**
 * Format sats for display
 */
export function formatSats(sats: number): string {
    if (sats >= 100_000_000) {
        return (sats / 100_000_000).toFixed(2) + ' BTC';
    }
    if (sats >= 1_000_000) {
        return (sats / 1_000_000).toFixed(2) + 'M';
    }
    if (sats >= 1_000) {
        return Math.round(sats / 1_000) + 'k';
    }
    return sats.toString();
}


