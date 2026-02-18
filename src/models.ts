/**
 * OATT - Core data models
 */

// Rejection reason types
export type RejectionReason =
    | 'min_channel_size'
    | 'no_anchors'
    | 'failed_to_connect'
    | 'not_online'
    | 'no_address'
    | 'rejected'
    | 'no_routing'
    | 'custom_requirements'
    | 'coop_close'
    | 'batch_failed'
    | 'internal_error';

// Retry configuration for each rejection type
export const REJECTION_CONFIG: Record<RejectionReason, { retryable: boolean; cooldownDays?: number }> = {
    min_channel_size: { retryable: true },  // Retry with increased amount
    no_anchors: { retryable: false },
    failed_to_connect: { retryable: true, cooldownDays: 1 },
    not_online: { retryable: true, cooldownDays: 7 },
    no_address: { retryable: false },
    rejected: { retryable: false },
    no_routing: { retryable: false },
    custom_requirements: { retryable: false },
    coop_close: { retryable: false },
    batch_failed: { retryable: true, cooldownDays: 0 },
    internal_error: { retryable: true, cooldownDays: 0 },
};

// Reserve required by LND per channel (e.g. for anchors)
export const ANCHOR_RESERVE = 2500;

// Channel close types
export type CloseType = 'local_force' | 'remote_force' | 'coop';

// Source of channel candidate
export type CandidateSource = 'force_closed' | 'graph_distance' | 'manual';

// Channel history with a peer
export interface ChannelHistory {
    channelId: string;
    openedAt: Date;
    closedAt?: Date;
    closeType?: CloseType;
    localBalance: number;
    remoteBalance: number;
    satsRouted: number;
    feesEarned: number;
}

// Rejection record
export interface Rejection {
    date: Date;
    reason: RejectionReason;
    details?: string;
    minChannelSize?: number;  // For min_channel_size rejections
}

// Channel candidate
export interface ChannelCandidate {
    pubkey: string;
    alias: string;
    source: CandidateSource;
    addedAt: Date;

    // Node metrics from graph
    channels: number;
    capacitySats: number;
    lastUpdate: Date;
    distance?: number;

    // Previous channel history with this peer
    history: ChannelHistory[];

    // Rejection tracking
    rejections: Rejection[];
    minChannelSize?: number;  // Learned minimum (highest from rejections)

    // For planning
    proposedAmount?: number;
}

// Planned channel open
export interface PlannedChannel {
    pubkey: string;
    alias: string;
    amount: number;
    isMinimumEnforced: boolean;  // Amount was bumped due to known minimum
}

// Batch open plan
export interface OpenPlan {
    createdAt: Date;
    budget: number;
    defaultSize: number;
    maxSize: number;
    channels: PlannedChannel[];
    totalAmount: number;
    remainingBudget: number;
}

// Open attempt result
export interface OpenResult {
    pubkey: string;
    success: boolean;
    channelId?: string;
    error?: string;
    rejectionReason?: RejectionReason;
    detectedMinimum?: number;
}

// Batch open history
export interface OpenHistory {
    date: Date;
    plan: OpenPlan;
    results: OpenResult[];
}

// Node info from graph
export interface NodeInfo {
    pubkey: string;
    alias: string;
    channels: number;
    capacitySats: number;
    lastUpdate: Date;
    addresses: string[];
    features: string[];
}
