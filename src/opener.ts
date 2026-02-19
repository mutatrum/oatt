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
import chalk from 'chalk';
import { connectLnd, getNodeInfo } from './lnd.js';
import { createPlan, formatSats } from './planner.js';
import { loadCandidates, addRejection, saveOpenHistory } from './storage.js';
import type { OpenPlan, OpenResult, OpenHistory, RejectionReason, ChannelCandidate } from './models.js';

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

    // Define specific error patterns with their associated reasons and logic
    const patterns = [
        // Minimum channel size / capacity (priority 1: specific BTC errors)
        {
            reason: 'min_channel_size' as RejectionReason,
            regex: /is below (?:min chan size of )?.*?(\d+\.?\d*)\s*BTC/i,
            process: (match: RegExpMatchArray) => {
                const btc = parseFloat(match[1]);
                return { minSize: Math.round(btc * 100_000_000) };
            }
        },
        // Minimum channel size / capacity (priority 2: specific sat errors)
        {
            reason: 'min_channel_size' as RejectionReason,
            regex: /is below .*?(\d+)\s*sat/i,
            process: (match: RegExpMatchArray) => ({ minSize: parseInt(match[1]) })
        },
        // Minimum channel size / capacity (legacy generic sat)
        {
            reason: 'min_channel_size' as RejectionReason,
            regex: /(?:minimum|at least).*?(\d+)/i,
            process: (match: RegExpMatchArray) => ({ minSize: parseInt(match[1]) })
        },
        // General capacity error (fallback)
        {
            reason: 'min_channel_size' as RejectionReason,
            regex: /(?:channel|chan) size.*?(\d+\.?\d*)/i,
            process: (match: RegExpMatchArray) => {
                const val = match[1];
                if (message.includes(val + ' BTC')) {
                    return { minSize: Math.round(parseFloat(val) * 100_000_000) };
                }
                return { minSize: parseInt(val.replace(/,/g, '')) };
            }
        },
        // Connection issues (Tor, proxy, timeouts)
        {
            reason: 'failed_to_connect' as RejectionReason,
            regex: /connect|dial|timeout|tor|proxy/i
        },
        // Offline
        {
            reason: 'not_online' as RejectionReason,
            regex: /offline|not online/i
        },
        // No address/route
        {
            reason: 'no_address' as RejectionReason,
            regex: /no address|no route/i
        },
        // Explicit rejection
        {
            reason: 'rejected' as RejectionReason,
            regex: /reject|denied|refused/i
        },
        // Anchor channels
        {
            reason: 'no_anchors' as RejectionReason,
            regex: /anchor|feature/i
        },
        // Zombie / Pending limits
        {
            reason: 'too_many_pending' as RejectionReason,
            regex: /pending channels exceed maximum/i
        },
        // Remote internal errors
        {
            reason: 'internal_error' as RejectionReason,
            regex: /remote canceled|internal error|funding failed/i
        },
        // Generic error catch-all
        {
            reason: 'internal_error' as RejectionReason,
            regex: /error|Error/
        }
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern.regex);
        if (match) {
            let extra = {};
            if (pattern.process) {
                extra = pattern.process(match);
            }

            // Special overhead calculation logic for specific capacity errors
            if (pattern.reason === 'min_channel_size') {
                const fundingMatch = message.match(/funding (\d+)sat/i);
                const capacityMatch = message.match(/channel capacity is (\d+)sat/i);
                
                if (fundingMatch && capacityMatch) {
                    const funding = parseInt(fundingMatch[1]);
                    const capacity = parseInt(capacityMatch[1]);
                    const overhead = funding - capacity;
                    
                    if (overhead > 0) {
                        const minSize = (extra as any).minSize || 0;
                        (extra as any).minSize = minSize + overhead + 10000;
                    }
                }
            }

            return {
                reason: pattern.reason,
                details: message,
                pubkey,
                ...extra,
            };
        }
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
    availableCandidates?: ChannelCandidate[];
    openPeerPubkeys?: Set<string>;
    defaultSize?: number;
    maxSize?: number;
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
 * Execute a PSBT-batched channel open with opportunistic backfilling
 */
export async function executePlan(plan: OpenPlan, options: OpenOptions = {}): Promise<OpenResult[]> {
    const { dryRun = false, feeRate, onProgress, availableCandidates: overrideCandidates, openPeerPubkeys, defaultSize = plan.defaultSize, maxSize = plan.maxSize } = options;
    const log = onProgress ?? console.log;

    // Ensure LND is connected
    const { lnd } = await connectLnd();

    const results: OpenResult[] = [];
    let currentPlan = plan;
    let attempts: ChannelOpenAttempt[] = [];
    let backfilled = false;
    let iteration = 0;
    const MAX_ITERATIONS = 5;

    while (iteration < MAX_ITERATIONS) {
        iteration++;
        backfilled = false;
        attempts = currentPlan.channels.map(ch => ({
            pubkey: ch.pubkey,
            alias: ch.alias,
            amount: ch.amount,
        }));

        if (attempts.length === 0) break;

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

        // Step 1: Pre-verify connections
        log(`Step 1/5: Verifying peer connectivity (Attempt ${iteration})...`);
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
        const BATCH_SIZE = 3;
        let dropoutCount = 0;

        for (let i = 0; i < attempts.length; i += BATCH_SIZE) {
            const batch = attempts.slice(i, i + BATCH_SIZE);
            const batchResults = await Promise.all(batch.map(async (attempt) => {
                if (connectedSet.has(attempt.pubkey)) {
                    log(`  • ${attempt.alias}: Already connected`);
                    return { attempt, success: true };
                }

                const info = infoMap.get(attempt.pubkey);
                if (!info || info.addresses.length === 0) {
                    const reason: RejectionReason = info ? 'no_address' : 'not_online';
                    const errorMsg = info ? 'Node has no addresses' : 'Node not found in graph';
                    return { attempt, success: false, reason, errorMsg };
                }

                const uniqueAddresses = Array.from(new Set(info.addresses));
                log(`  • ${attempt.alias}: Connecting to ${uniqueAddresses.length} addresses...`);
                
                let lastError = 'Failed to connect';
                for (const address of uniqueAddresses) {
                    try {
                        await connectPeer(attempt.pubkey, address, 15000);
                        log(`  ✓ ${attempt.alias}: Connected`);
                        return { attempt, success: true };
                    } catch (err) {
                        const parsed = parseOpenError(err);
                        lastError = parsed.details;
                        log(`    - ${attempt.alias} | ${address} failed: ${lastError}`);
                    }
                }

                return { attempt, success: false, reason: 'failed_to_connect' as RejectionReason, errorMsg: lastError };
            }));

            for (const res of batchResults) {
                if (!res.success) {
                    log(chalk.yellow(`✗ Node ${res.attempt.alias} failed to connect. Dropping and re-planning...`));
                    addRejection(res.attempt.pubkey, {
                        date: new Date(),
                        reason: res.reason!,
                        details: res.errorMsg!,
                    });
                    dropoutCount++;
                }
            }
        }

        if (dropoutCount > 0) {
            log(chalk.blue(`ℹ ${dropoutCount} nodes failed connection. Re-planning to backfill budget...`));
            currentPlan = createPlan({
                budget: currentPlan.budget,
                defaultSize,
                maxSize,
                openPeerPubkeys,
                candidates: loadCandidates() // Always load from disk to pick up recent rejections
            });
            backfilled = true;
            continue; // Re-attempt connection phase with new plan
        }

        // Step 2: Initiate pending channels
        log(`Step 2/5: Initiating ${attempts.length} channel opens...`);
        const channelsToOpen: lnService.OpenChannelsChannel[] = attempts.map(a => ({
            capacity: a.amount,
            partner_public_key: a.pubkey,
        }));

        try {
            const result = await lnService.openChannels({
                lnd,
                channels: channelsToOpen,
                is_avoiding_broadcast: true,
            });
            
            // Match pending channels to our attempts
            for (let i = 0; i < result.pending.length; i++) {
                attempts[i].pendingId = result.pending[i].id;
                attempts[i].address = result.pending[i].address;
            }
            // If we successfully initiated everything, we can exit the convergence loop
            break;
        } catch (error) {
            const parsed = parseOpenError(error);
            log(chalk.red(`✗ Step 2 failed: ${parsed.details}`));
            
            if (parsed.pubkey) {
                log(chalk.yellow(`ℹ Node ${parsed.pubkey} rejected initiation. Marking and re-planning...`));
                addRejection(parsed.pubkey, {
                    date: new Date(),
                    reason: parsed.reason,
                    details: parsed.details,
                    minChannelSize: parsed.minSize,
                });
                
                currentPlan = createPlan({
                    budget: currentPlan.budget,
                    defaultSize,
                    maxSize,
                    openPeerPubkeys,
                    candidates: loadCandidates()
                });
                backfilled = true;
                continue;
            } else {
                // If it's a batch-wide failure without a specific pubkey (e.g. insufficient funds)
                // we have to abort or handle specially.
                log(chalk.red('Fatal batch error. Aborting.'));
                throw error;
            }
        }
    }

    if (attempts.length === 0) {
        log(chalk.yellow('No viable nodes left to open.'));
        return results;
    }

    // Step 3: Create PSBT with all outputs
    log(`Step 3/5: Creating funding PSBT for ${attempts.length} outputs...`);
    const outputs = attempts.map(a => ({
        address: a.address!,
        tokens: a.amount,
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
        const parsed = parseOpenError(error);
        log(`Failed to create PSBT: ${parsed.details}`);
        await cancelAllPending(lnd, attempts, log);
        throw error;
    }

    // Step 4: Sign the PSBT
    log('Step 4/5: Signing PSBT...');
    let signedPsbt: string;
    let transaction: string | undefined;
    try {
        const signResult = await lnService.signPsbt({
            lnd,
            psbt: unsignedPsbt,
        });
        signedPsbt = signResult.psbt;
        transaction = signResult.transaction;
    } catch (error) {
        const parsed = parseOpenError(error);
        log(`Failed to sign PSBT: ${parsed.details}`);
        await cancelAllPending(lnd, attempts, log);
        throw error;
    }

    // Step 5: Fund pending channels with signed PSBT
    log('Step 5/5: Broadcasting funding transaction...');
    const pendingIds = attempts.map(a => a.pendingId!);

    try {
        await lnService.fundPendingChannels({
            lnd,
            channels: pendingIds,
            funding: signedPsbt,
        });

        if (transaction) {
            log('Actually broadcasting funding transaction...');
            await lnService.broadcastChainTransaction({
                lnd,
                transaction,
            });
        }

        for (const attempt of attempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: true,
                channelId: attempt.pendingId,
            });
        }
        log(`✓ Funding transaction broadcast! ${attempts.length} channels opening.`);
    } catch (error) {
        const parsed = parseOpenError(error);
        log(`Failed to broadcast funding: ${parsed.details}`);
        for (const attempt of attempts) {
            results.push({
                pubkey: attempt.pubkey,
                success: false,
                error: `Broadcast failed: ${parsed.details}`,
                rejectionReason: parsed.reason,
            });
        }
    }

    saveHistory(currentPlan, results);
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
