/**
 * OATT - Batch channel opener with PSBT support
 *
 * Opens multiple channels in a single on-chain transaction using PSBT flow:
 * 1. openChannels - initiates pending channels, returns addresses/amounts
 * 2. fundPsbt - creates unsigned PSBT for those outputs
 * 3. signPsbt - signs the PSBT
 * 4. fundPendingChannels - finalizes with signed PSBT
 */

import * as lnService from 'ln-service';
import { connectLnd, getNodeInfo } from './lnd.js';
import { addRejection, saveOpenHistory } from './storage.js';
import type { OpenPlan, OpenResult, OpenHistory, RejectionReason } from './models.js';

/**
 * Parse LND error messages to extract rejection reason and implicated pubkey
 */
export function parseOpenError(error: unknown): {
    reason: RejectionReason;
    minSize?: number;
    details: string;
    pubkey?: string;
} {
    let message = '';

    if (error instanceof Error) {
        message = error.message;
    } else if (typeof error === 'object' && error !== null) {
        try {
            message = JSON.stringify(error);
        } catch {
            message = String(error);
        }
    } else {
        message = String(error);
    }

    // Handle common ln-service/lnd error arrays [code, message, {details}]
    if (Array.isArray(error) && error.length >= 2) {
        const details = error[2] ? JSON.stringify(error[2]) : '';
        message = `${error[0]} ${error[1]} ${details}`;
    }

    // Extract pubkey if present (66 hex chars starting with 02 or 03)
    const pubkeyMatch = message.match(/(02|03)[0-9a-fA-F]{64}/);
    const pubkey = pubkeyMatch ? pubkeyMatch[0].toLowerCase() : undefined;

    // Check for minimum channel size
    const minSizeMatch = message.match(/channel size.*?(\d+)/i) ||
        message.match(/minimum.*?(\d+)/i) ||
        message.match(/at least.*?(\d+)/i);
    if (minSizeMatch) {
        return {
            reason: 'min_channel_size',
            minSize: parseInt(minSizeMatch[1]),
            details: message,
            pubkey,
        };
    }

    // Check for anchor channels
    if (message.includes('anchor') || message.includes('feature')) {
        return {
            reason: 'no_anchors',
            details: message,
            pubkey,
        };
    }

    // Check for connection issues
    if (message.includes('connect') || message.includes('dial') || message.includes('timeout')) {
        return {
            reason: 'failed_to_connect',
            details: message,
            pubkey,
        };
    }

    // Check for offline
    if (message.includes('offline') || message.includes('not online')) {
        return {
            reason: 'not_online',
            details: message,
            pubkey,
        };
    }

    // Check for no address
    if (message.includes('no address') || message.includes('no route')) {
        return {
            reason: 'no_address',
            details: message,
            pubkey,
        };
    }

    // Check for explicit rejection
    if (message.includes('reject') || message.includes('denied') || message.includes('refused')) {
        return {
            reason: 'rejected',
            details: message,
            pubkey,
        };
    }

    // Check for internal errors
    if (message.includes('internal') || message.includes('err')) {
        return {
            reason: 'internal_error',
            details: message,
            pubkey,
        };
    }

    // Default to rejected
    return {
        reason: 'rejected',
        details: message,
        pubkey,
    };
}

export interface OpenOptions {
    dryRun?: boolean;
    feeRate?: number;  // sats/vbyte
    onProgress?: (message: string) => void;
}

interface ChannelOpenAttempt {
    pubkey: string;
    alias: string;
    amount: number;
    pendingId?: string;
    address?: string;
    error?: string;
    rejectionReason?: RejectionReason;
    detectedMinimum?: number;
}

/**
 * Execute a PSBT-batched channel open
 */
export async function executePlan(plan: OpenPlan, options: OpenOptions = {}): Promise<OpenResult[]> {
    const { dryRun = false, feeRate, onProgress } = options;
    const log = onProgress ?? console.log;

    // Ensure LND is connected
    const { lnd } = await connectLnd();

    const results: OpenResult[] = [];
    const attempts: ChannelOpenAttempt[] = plan.channels.map(ch => ({
        pubkey: ch.pubkey,
        alias: ch.alias,
        amount: ch.amount,
    }));

    if (dryRun) {
        log('DRY RUN - Simulating batch open...');
        for (const attempt of attempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: true,
                channelId: `dry-run:${attempt.pubkey.slice(0, 8)}`,
            });
        }
        return results;
    }

    // Step 0: Pre-verify connections and fetch fresh info
    log('Step 1/5: Verifying peer connectivity...');
    const { getConnectedPeers, connectPeer } = await import('./lnd.js');
    const [nodeInfos, connectedPeers] = await Promise.all([
        Promise.all(
            attempts.map(async (a) => {
                try {
                    const info = await getNodeInfo(a.pubkey);
                    return { pubkey: a.pubkey, info };
                } catch {
                    return { pubkey: a.pubkey, info: null };
                }
            })
        ),
        getConnectedPeers()
    ]);
    
    const infoMap = new Map(nodeInfos.map(n => [n.pubkey, n.info]));
    const connectedSet = new Set(connectedPeers);

    // Verify all peers in small batches to avoid overwhelming Tor proxy
    const BATCH_SIZE = 3;
    const verificationResults: { attempt: ChannelOpenAttempt; success: boolean; reason?: RejectionReason; errorMsg?: string }[] = [];
    
    for (let i = 0; i < attempts.length; i += BATCH_SIZE) {
        const batch = attempts.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (attempt) => {
            // Already connected?
            if (connectedSet.has(attempt.pubkey)) {
                log(`  • ${attempt.alias}: Already connected`);
                return { attempt, success: true };
            }

            const info = infoMap.get(attempt.pubkey);
            if (!info || info.addresses.length === 0) {
                const reason: RejectionReason = info ? 'no_address' : 'not_online';
                const errorMsg = info ? 'Node has no addresses in graph' : 'Node not found in graph';
                return { attempt, success: false, reason, errorMsg };
            }

            // Try all addresses for this peer
            log(`  • ${attempt.alias}: Connecting to ${info.addresses.length} addresses...`);
            let lastError = 'Failed to connect';
            for (let j = 0; j < info.addresses.length; j++) {
                const address = info.addresses[j];
                try {
                    // Use a 15 second timeout for each attempt
                    await connectPeer(attempt.pubkey, address, 15000);
                    log(`  ✓ ${attempt.alias}: Connected`);
                    return { attempt, success: true };
                } catch (err) {
                    const parsed = parseOpenError(err);
                    lastError = parsed.details;
                    
                    // Specific logging for Tor proxy errors
                    if (lastError.includes('tor general error')) {
                        log(`    - ${attempt.alias} | ${address} failed: Tor proxy error (check your Tor status)`);
                    } else {
                        log(`    - ${attempt.alias} | ${address} failed: ${lastError}`);
                    }
                }
            }

            return { 
                attempt, 
                success: false, 
                reason: 'failed_to_connect' as RejectionReason, 
                errorMsg: `Failed to connect: ${lastError}` 
            };
        }));
        
        verificationResults.push(...batchResults);
    }

    const viableAttempts: ChannelOpenAttempt[] = [];
    for (const res of verificationResults) {
        if (res.success) {
            viableAttempts.push(res.attempt);
        } else {
            results.push({
                pubkey: res.attempt.pubkey,
                success: false,
                error: res.errorMsg!,
                rejectionReason: res.reason!,
            });

            addRejection(res.attempt.pubkey, {
                date: new Date(),
                reason: res.reason!,
                details: res.errorMsg!,
            });
            
            log(`✗ Skipping ${res.attempt.alias}: ${res.errorMsg}`);
        }
    }

    if (viableAttempts.length === 0) {
        log('No viable nodes left to open in this batch.');
        saveHistory(plan, results);
        return results;
    }

    // Step 1: Initiate pending channels with remaining peers
    log(`Step 2/5: Initiating ${viableAttempts.length} channel opens...`);

    const channelsToOpen: lnService.OpenChannelsChannel[] = viableAttempts.map(a => ({
        capacity: a.amount,
        partner_public_key: a.pubkey,
    }));

    let pendingChannels: lnService.PendingChannel[];

    try {
        const result = await lnService.openChannels({
            lnd,
            channels: channelsToOpen,
            is_avoiding_broadcast: true,  // We'll broadcast ourselves after PSBT
        });
        pendingChannels = result.pending;
    } catch (error) {
        // If batch open fails entirely, try to identify which channel(s) failed
        const parsed = parseOpenError(error);
        log(`Batch open failed: ${parsed.details}`);

        // Record results and rejections
        for (const attempt of viableAttempts) {
            // Is this specific node the cause of the failure?
            const isImplicated = !parsed.pubkey || parsed.pubkey === attempt.pubkey;

            results.push({
                pubkey: attempt.pubkey,
                success: false,
                error: isImplicated ? parsed.details : 'Batch cancelled due to node being offline or other failure',
                rejectionReason: isImplicated ? parsed.reason : 'batch_failed',
                detectedMinimum: isImplicated ? parsed.minSize : undefined,
            });

            // Only record rejection for retry logic if this specific node was named
            if (isImplicated) {
                addRejection(attempt.pubkey, {
                    date: new Date(),
                    reason: parsed.reason,
                    details: parsed.details,
                    minChannelSize: parsed.minSize,
                });
            }
        }

        saveHistory(plan, results);
        return results;
    }

    // Match pending channels to our attempts
    for (let i = 0; i < pendingChannels.length; i++) {
        viableAttempts[i].pendingId = pendingChannels[i].id;
        viableAttempts[i].address = pendingChannels[i].address;
    }

    log(`Step 3/5: Creating funding PSBT for ${pendingChannels.length} outputs...`);

    // Step 2: Create PSBT with all outputs
    const outputs = pendingChannels.map(p => ({
        address: p.address,
        tokens: p.tokens,
    }));

    let unsignedPsbt: string;
    try {
        const fundResult = await lnService.fundPsbt({
            lnd,
            outputs,
            fee_tokens_per_vbyte: feeRate,
        });
        unsignedPsbt = fundResult.psbt;
    } catch (error) {
        // Funding failed - likely insufficient funds
        const parsed = parseOpenError(error);
        log(`Failed to create PSBT: ${parsed.details}`);

        // Cancel all pending channels
        await cancelAllPending(lnd, viableAttempts, log);

        for (const attempt of viableAttempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: false,
                error: `Funding failed: ${parsed.details}`,
                rejectionReason: 'internal_error',
            });
        }

        saveHistory(plan, results);
        return results;
    }

    // Step 3: Sign the PSBT
    log('Step 4/5: Signing PSBT...');

    let signedPsbt: string;
    try {
        const signResult = await lnService.signPsbt({
            lnd,
            psbt: unsignedPsbt,
        });
        signedPsbt = signResult.psbt;
    } catch (error) {
        const parsed = parseOpenError(error);
        log(`Failed to sign PSBT: ${parsed.details}`);

        await cancelAllPending(lnd, viableAttempts, log);

        for (const attempt of viableAttempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: false,
                error: `Signing failed: ${parsed.details}`,
                rejectionReason: 'internal_error',
            });
        }

        saveHistory(plan, results);
        return results;
    }

    // Step 4: Fund pending channels with signed PSBT
    log('Step 5/5: Broadcasting funding transaction...');

    const pendingIds = viableAttempts
        .filter(a => a.pendingId)
        .map(a => a.pendingId!);

    try {
        await lnService.fundPendingChannels({
            lnd,
            channels: pendingIds,
            funding: signedPsbt,
        });

        // All channels funded successfully
        for (const attempt of viableAttempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: true,
                channelId: attempt.pendingId,
            });
        }

        log(`✓ Funding transaction broadcast! ${viableAttempts.length} channels opening.`);
    } catch (error) {
        // Final funding failed
        const parsed = parseOpenError(error);
        log(`Failed to broadcast funding: ${parsed.details}`);

        for (const attempt of viableAttempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: false,
                error: `Broadcast failed: ${parsed.details}`,
                rejectionReason: 'internal_error',
            });
        }
    }

    saveHistory(plan, results);
    return results;
}

/**
 * Cancel all pending channels on failure
 */
async function cancelAllPending(
    lnd: unknown,
    attempts: ChannelOpenAttempt[],
    log: (msg: string) => void
): Promise<void> {
    log('Cancelling pending channels...');

    for (const attempt of attempts) {
        if (attempt.pendingId) {
            try {
                await lnService.cancelPendingChannel({
                    lnd,
                    id: attempt.pendingId,
                });
            } catch {
                // Ignore cancel errors
            }
        }
    }
}

/**
 * Save open history
 */
function saveHistory(plan: OpenPlan, results: OpenResult[]): void {
    const history: OpenHistory = {
        date: new Date(),
        plan,
        results,
    };
    saveOpenHistory(history);
}

/**
 * Format results for display
 */
export function formatResults(results: OpenResult[]): string {
    const lines: string[] = [];

    lines.push('');
    lines.push('Results:');
    lines.push('─'.repeat(80));

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    for (const result of successful) {
        lines.push(`✓ ${result.pubkey.slice(0, 16)}... → pending: ${result.channelId?.slice(0, 16)}...`);
    }

    for (const result of failed) {
        const reason = result.rejectionReason ?? 'unknown';
        const details = result.error?.slice(0, 40) ?? '';
        lines.push(`✗ ${result.pubkey.slice(0, 16)}... → ${reason}: ${details}...`);
    }

    lines.push('─'.repeat(80));
    lines.push(`Successful: ${successful.length} | Failed: ${failed.length}`);
    lines.push('');

    return lines.join('\n');
}

/**
 * Generate a bos open command equivalent (for reference/debugging)
 */
export function generateBosCommand(plan: OpenPlan): string {
    const parts = ['bos open'];

    for (const channel of plan.channels) {
        parts.push(`${channel.pubkey} --amount ${channel.amount}`);
    }

    return parts.join(' \\\n  ');
}

/**
 * Execute with fallback to sequential opens if batch fails
 * 
 * This is a more robust approach for when batch opening fails due to
 * one or more peers not supporting it.
 */
export async function executePlanWithFallback(
    plan: OpenPlan,
    options: OpenOptions = {}
): Promise<OpenResult[]> {
    const { onProgress } = options;
    const log = onProgress ?? console.log;

    try {
        // Try batch first
        return await executePlan(plan, options);
    } catch (error) {
        log('Batch open failed, falling back to sequential opens...');

        // Fallback to individual opens
        const { lnd } = await connectLnd();
        const results: OpenResult[] = [];

        for (const channel of plan.channels) {
            try {
                const result = await lnService.openChannel({
                    lnd,
                    partner_public_key: channel.pubkey,
                    local_tokens: channel.amount,
                });

                results.push({
                    pubkey: channel.pubkey,
                    success: true,
                    channelId: `${result.transaction_id}:${result.transaction_vout}`,
                });

                log(`✓ ${channel.alias}`);
            } catch (err) {
                const parsed = parseOpenError(err);

                results.push({
                    pubkey: channel.pubkey,
                    success: false,
                    error: parsed.details,
                    rejectionReason: parsed.reason,
                    detectedMinimum: parsed.minSize,
                });

                addRejection(channel.pubkey, {
                    date: new Date(),
                    reason: parsed.reason,
                    details: parsed.details,
                    minChannelSize: parsed.minSize,
                });

                log(`✗ ${channel.alias}: ${parsed.reason}`);
            }
        }

        saveHistory(plan, results);
        return results;
    }
}
