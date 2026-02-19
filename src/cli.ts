/**
 * OATT - CLI Entry Point
 */

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import fs from 'node:fs';
import stringWidth from 'string-width';
import { loadConfig, saveConfig, getConfigPath, getConfigDir } from './config.js';
import { loadCandidates, addRejection, removeCandidate, removeCandidatesBySource, upsertCandidate, saveCandidates } from './storage.js';
import { runForceClosedCollection } from './collectors/force-closed.js';
import { runGraphDistanceCollection } from './collectors/graph-distance.js';
import { connectLnd, getNodeInfo, getOwnPubkey, getForwardingHistory, getChainBalance } from './lnd.js';
import { REJECTION_CONFIG, type RejectionReason, type ChannelCandidate, type OpenPlan } from './models.js';
import { createPlan, addToPlan, removeFromPlan, resizeInPlan, isEligible, sortCandidatesBySignal } from './planner.js';

const program = new Command();

program
    .name('oatt')
    .description('Open All The Things - Lightning Network channel manager')
    .version('0.1.0');

// ============ collect ============

const collectCmd = program
    .command('collect')
    .description('Collect channel candidates from various sources');

collectCmd
    .command('force-closed')
    .description('Find force-closed channels to potentially reopen')
    .action(async () => {
        try {
            await connectLnd();
            const count = await runForceClosedCollection();
            console.log(chalk.green(`✓ Added ${count} candidates from force-closed channels`));
        } catch (error) {
            console.error(chalk.red('Error:'), error);
            process.exit(1);
        }
    });

collectCmd
    .command('graph')
    .description('Find distant nodes in the graph')
    .option('-d, --min-distance <n>', 'Minimum distance from your node', '2')
    .option('-c, --min-channels <n>', 'Minimum channels the node should have', '10')
    .option('-s, --min-capacity <sats>', 'Minimum capacity in sats', '10000000')
    .action(async (options) => {
        try {
            await connectLnd();
            const count = await runGraphDistanceCollection({
                minDistance: parseInt(options.minDistance),
                minChannels: parseInt(options.minChannels),
                minCapacity: parseInt(options.minCapacity),
            });
            console.log(chalk.green(`✓ Added ${count} candidates from graph distance`));
        } catch (error) {
            console.error(chalk.red('Error:'), error);
            process.exit(1);
        }
    });

collectCmd
    .command('forwards')
    .description('Find high-value routing peers from forwarding history')
    .option('-d, --days <n>', 'Days of history to analyse', '30')
    .option('-n, --top-n <n>', 'Number of top candidates to output', '20')
    .option('-s, --min-score <sats>', 'Minimum fee sats to qualify', '0')
    .action(async (options) => {
        try {
            await connectLnd();
            const { runForwardingHistoryCollection } = await import('./collectors/forwards.js');
            const count = await runForwardingHistoryCollection({
                days: parseInt(options.days),
                topN: parseInt(options.topN),
                minScore: parseInt(options.minScore),
            });
            console.log(chalk.green(`✓ Added ${count} candidates from forwarding history`));
        } catch (error) {
            console.error(chalk.red('Error:'), error);
            process.exit(1);
        }
    });

collectCmd
    .command('add <pubkey>')
    .description('Manually add a candidate')
    .action(async (pubkey: string) => {
        try {
            await connectLnd();
            const nodeInfo = await getNodeInfo(pubkey);

            if (!nodeInfo) {
                console.error(chalk.red(`Node ${pubkey} not found in graph`));
                process.exit(1);
            }

            const { upsertCandidate } = await import('./storage.js');
            upsertCandidate({
                pubkey,
                alias: nodeInfo.alias,
                sources: ['manual'],
                addedAt: new Date(),
                channels: nodeInfo.channels,
                capacitySats: nodeInfo.capacitySats,
                lastUpdate: nodeInfo.lastUpdate,
                history: [],
                rejections: [],
            });

            console.log(chalk.green(`✓ Added ${nodeInfo.alias} (${pubkey.slice(0, 12)}...)`));
        } catch (error) {
            console.error(chalk.red('Error:'), error);
            process.exit(1);
        }
    });

// ============ list ============

program
    .command('list')
    .description('List channel candidates')
    .option('-e, --eligible', 'Show only eligible candidates (no blocking rejections)')
    .option('-d, --by-distance', 'Sort by graph distance')
    .option('-a, --all', 'Show all details including rejections')
    .action(async (options) => {
        await listCandidates(options);
    });

// Visual width helpers for alignment with double-wide characters
function visualTruncate(str: string, width: number): string {
    let currentWidth = 0;
    let result = '';
    for (const char of str) {
        const charWidth = stringWidth(char);
        if (currentWidth + charWidth > width) break;
        result += char;
        currentWidth += charWidth;
    }
    return result;
}

function visualPadEnd(str: string, width: number): string {
    const sw = stringWidth(str);
    if (sw >= width) return str;
    return str + ' '.repeat(width - sw);
}

function formatCandidateHeader(isPlan: boolean): string {
    const parts = [
        visualPadEnd('#', 4),
        visualPadEnd('Alias', 25),
        visualPadEnd('Pubkey', 15),
    ];

    if (isPlan) {
        parts.push(visualPadEnd('Amount', 10));
    }

    parts.push(
        visualPadEnd('Sources', 15),
        'Ch ',
        'Cap    ',
        'Dist ',
        'Min Size ',
        visualPadEnd('Status', 13),
        'Age'
    );

    return chalk.gray(parts.join(' '));
}

function formatCandidateRow(c: ChannelCandidate, index: number, planAmount?: number): string {
    const num = (index + 1).toString().slice(0, 3).padEnd(4);
    const alias = visualPadEnd(visualTruncate(c.alias, 25), 25);
    const pubkey = visualPadEnd(c.pubkey.slice(0, 12) + '...', 15);
    
    const parts = [num, alias, pubkey];

    if (planAmount !== undefined) {
        parts.push(visualPadEnd(formatSats(planAmount), 10));
    }

    const sourceLabels = c.sources.map(s => {
        switch (s) {
            case 'force_closed': return 'Closed';
            case 'graph_distance': return 'Graph';
            case 'forwarding_history': return 'Forwards';
            case 'manual': return 'Manual';
            default: return s;
        }
    }).join('|');
    const sources = visualPadEnd(visualTruncate(sourceLabels, 15), 15);

    const channels = c.channels.toString().padStart(2);
    const capacity = formatSats(c.capacitySats).padStart(7);
    const distance = (c.distance?.toString() ?? '-').padStart(4);
    const minSize = c.minChannelSize ? formatSats(c.minChannelSize).padStart(8) : '       -';
    const age = Math.floor((Date.now() - c.addedAt.getTime()) / (1000 * 60 * 60 * 24)) + 'd';

    // Determine status
    let status = 'Eligible';
    let statusColor = chalk.green;
    
    if (c.rejections.length > 0) {
        const blocking = c.rejections.find(r => !REJECTION_CONFIG[r.reason].retryable);
        if (blocking) {
            status = 'Blocked';
            statusColor = chalk.red;
        } else {
            let maxWaitDays = 0;
            for (const r of c.rejections) {
                const config = REJECTION_CONFIG[r.reason];
                if (config.cooldownDays) {
                    const cooldownMs = config.cooldownDays * 24 * 60 * 60 * 1000;
                    const elapsedMs = Date.now() - new Date(r.date).getTime();
                    const remainingMs = cooldownMs - elapsedMs;
                    if (remainingMs > 0) {
                        maxWaitDays = Math.max(maxWaitDays, Math.ceil(remainingMs / (24 * 60 * 60 * 1000)));
                    }
                }
            }
            if (maxWaitDays > 0) {
                status = `Wait ${maxWaitDays}d`;
                statusColor = chalk.yellow;
            }
        }
    }

    const statusStr = statusColor(status.padEnd(13));
    
    parts.push(sources, channels, capacity, distance, minSize, statusStr, age.padStart(4));
    return parts.join(' ');
}

async function listCandidates(options: { eligible?: boolean; all?: boolean; byDistance?: boolean }) {
    try {
        let candidates = loadCandidates();

        const openPeerPubkeys = new Set<string>();
        try {
            await connectLnd();
            const channels = await import('./lnd.js').then(m => m.getChannels());
            channels.forEach(c => openPeerPubkeys.add(c.partner_public_key));
        } catch (e) {
            console.error(chalk.yellow('  Warning: Could not fetch open channels from LND. Results might include existing partners.'));
        }

        // Filter
        let filtered = candidates;
        if (options.eligible) {
            filtered = candidates.filter(c => isEligible(c, openPeerPubkeys));
        } else {
            // Even if not strictly 'eligible', we filter out existing partners for list to keep it clean
            filtered = candidates.filter(c => !openPeerPubkeys.has(c.pubkey));
        }

        // Sort
        if (options.byDistance) {
            filtered.sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
        } else {
            // Default: use the same signal-based sorting as plan
            filtered = sortCandidatesBySignal(filtered);
        }

        // Display
        console.log(chalk.bold(`\n${filtered.length} candidates:\n`));
        console.log(formatCandidateHeader(false));

        filtered.forEach((candidate, i) => {
            console.log(formatCandidateRow(candidate, i));

            if (options.all && candidate.rejections.length > 0) {
                const rejectionLines = candidate.rejections.map(r => {
                    const config = REJECTION_CONFIG[r.reason];
                    let cooldownInfo = '';

                    if (config.retryable && config.cooldownDays) {
                        const cooldownMs = config.cooldownDays * 24 * 60 * 60 * 1000;
                        const elapsedMs = Date.now() - new Date(r.date).getTime();
                        const remainingMs = cooldownMs - elapsedMs;

                        if (remainingMs > 0) {
                            const h = Math.floor(remainingMs / (60 * 60 * 1000));
                            const hoursStr = h > 0 ? `${h}h ` : '';
                            const m = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
                            cooldownInfo = chalk.cyan(` [Active Cooldown: ${hoursStr}${m}m remaining]`);
                        }
                    }

                    return `    ${chalk.gray(new Date(r.date).toLocaleDateString())} ${chalk.yellow(r.reason)}: ${r.details ?? ''} ${r.minChannelSize ? formatSats(r.minChannelSize) : ''}${cooldownInfo}`;
                });
                console.log(rejectionLines.join('\n'));
            }
        });

        console.log('');
    } catch (e) {
        console.error(chalk.red('  Error listing candidates:'), e);
    }
}


function formatSats(sats: number | undefined | null): string {
    if (sats === undefined || sats === null) return '0';
    if (sats >= 100_000_000) return (sats / 100_000_000).toFixed(2) + ' BTC';
    if (sats >= 1_000_000) return (sats / 1_000_000).toFixed(1) + 'M';
    if (sats >= 1_000) return (sats / 1_000).toFixed(0) + 'k';
    return sats.toString();
}

function renderPlanTable(plan: OpenPlan) {
    const candidates = loadCandidates();
    
    console.log('');
    console.log(`Budget: ${formatSats(plan.budget)} | Default: ${formatSats(plan.defaultSize)} | Max: ${formatSats(plan.maxSize)}`);
    console.log(`Note: Each channel includes an additional ${formatSats(2500 /* ANCHOR_RESERVE */)} anchor reserve.`);
    console.log('─'.repeat(120));
    console.log(formatCandidateHeader(true));
    console.log('─'.repeat(120));

    plan.channels.forEach((ch, i) => {
        const candidate = candidates.find(c => c.pubkey === ch.pubkey);
        if (candidate) {
            console.log(formatCandidateRow(candidate, i, ch.amount));
        } else {
            // Fallback for manual adds not yet in storage (though they should be)
            console.log(`${(i + 1).toString().padEnd(4)} ${visualPadEnd(ch.alias, 25)} ${visualPadEnd(ch.pubkey.slice(0, 12) + '...', 15)} ${visualPadEnd(formatSats(ch.amount), 10)} (Node info missing)`);
        }
    });

    console.log('─'.repeat(120));
    console.log(`Total: ${plan.channels.length} channels, ${formatSats(plan.totalAmount)} | Remaining: ${formatSats(plan.remainingBudget)}`);
    console.log('');
}

// ============ reject ============

program
    .command('reject <pubkey>')
    .description('Record a rejection for a node')
    .requiredOption('-r, --reason <reason>', 'Rejection reason')
    .option('-m, --min-size <sats>', 'Minimum channel size (for min_channel_size reason)')
    .option('-n, --note <text>', 'Additional notes')
    .action((pubkey: string, options) => {
        const reason = options.reason as RejectionReason;

        if (!REJECTION_CONFIG[reason]) {
            console.error(chalk.red(`Invalid reason: ${reason}`));
            console.log('Valid reasons:', Object.keys(REJECTION_CONFIG).join(', '));
            process.exit(1);
        }

        addRejection(pubkey, {
            date: new Date(),
            reason,
            details: options.note,
            minChannelSize: options.minSize ? parseInt(options.minSize) : undefined,
        });

        console.log(chalk.green(`✓ Recorded rejection for ${pubkey.slice(0, 12)}...`));
    });

// ============ remove ============

program
    .command('remove <pubkey>')
    .description('Remove a candidate')
    .action((pubkey: string) => {
        const removed = removeCandidate(pubkey);
        if (removed) {
            console.log(chalk.green(`✓ Removed ${pubkey.slice(0, 12)}...`));
        } else {
            console.log(chalk.yellow(`Candidate ${pubkey.slice(0, 12)}... not found`));
        }
    });

// ============ config ============

program
    .command('config')
    .description('Show configuration')
    .action(() => {
        const config = loadConfig();
        console.log(chalk.bold('Configuration:'));
        console.log(chalk.gray('Path:'), getConfigPath());
        console.log(JSON.stringify(config, null, 2));
    });

// ============ status ============

program
    .command('status')
    .description('Show connection status and summary')
    .action(async () => {
        try {
            await connectLnd();
            const pubkey = await getOwnPubkey();
            const candidates = loadCandidates();

            console.log(chalk.bold('\nOATT Status\n'));
            console.log(chalk.green('✓ LND Connected'));
            console.log(`  Node: ${pubkey.slice(0, 20)}...`);
            console.log(`\n  Candidates: ${candidates.length}`);

            const eligible = candidates.filter(c =>
                c.rejections.length === 0 ||
                c.rejections.every(r => REJECTION_CONFIG[r.reason].retryable)
            );
            console.log(`  Eligible: ${eligible.length}`);

            const bySource = candidates.reduce((acc, c) => {
                c.sources.forEach(source => {
                    acc[source] = (acc[source] ?? 0) + 1;
                });
                return acc;
            }, {} as Record<string, number>);

            console.log('\n  By sources:');
            for (const [source, count] of Object.entries(bySource)) {
                console.log(`    ${source}: ${count}`);
            }

            console.log('');
        } catch (error) {
            console.error(chalk.red('✗ LND Connection Failed'));
            console.error('  Check your config:', getConfigPath());
            console.error('  Error:', error);
            process.exit(1);
        }
    });
// ============ plan ============

program
    .command('plan')
    .description('Create a batch channel open plan')
    .option('-b, --budget <sats>', 'Total budget in sats (defaults to available on-chain balance)')
    .option('-s, --default-size <sats>', 'Default channel size', '1000000')
    .option('-m, --max-size <sats>', 'Maximum channel size', '10000000')
    .action(async (options) => {
        const { createPlan, addToPlan, removeFromPlan, resizeInPlan, formatSats } = await import('./planner.js');
        const inquirer = await import('inquirer');
        const { getChainBalance, connectLnd } = await import('./lnd.js');

        let budget: number;
        let openPeerPubkeys: Set<string> | undefined;

        try {
            await connectLnd();
            const balance = await getChainBalance();
            const available = balance.confirmed;

            const channels = await import('./lnd.js').then(m => m.getChannels());
            openPeerPubkeys = new Set(channels.map(c => c.partner_public_key));

            if (options.budget) {
                budget = parseInt(options.budget);
            } else {
                console.log(chalk.gray(`\nAvailable on-chain balance: ${formatSats(available)}`));
                // Suggest 100% of balance, user can adjust if they want to leave some for fees
                const suggested = available;
                const { budgetInput } = await inquirer.default.prompt([{
                    type: 'number',
                    name: 'budgetInput',
                    message: 'Enter budget in sats:',
                    default: suggested,
                }]);
                budget = budgetInput;
            }
        } catch (error) {
            if (options.budget) {
                budget = parseInt(options.budget);
            } else {
                console.error(chalk.red('Error fetching chain balance or channels:'), error);
                console.log(chalk.yellow('\nTip: You can specify a budget explicitly with --budget <sats>'));
                process.exit(1);
            }
        }

        const defaultSize = parseInt(options.defaultSize);
        const maxSize = parseInt(options.maxSize);

        let plan = createPlan({ budget, defaultSize, maxSize, openPeerPubkeys });

        // Log adjustments
        plan.channels.forEach(ch => {
            if (ch.isMinimumEnforced) {
                console.log(chalk.blue(`ℹ Bumped ${ch.alias} to ${formatSats(ch.amount)} due to learned minimum size.`));
            }
        });

        console.log(chalk.bold('\nBatch Channel Open Plan'));
        renderPlanTable(plan);

        if (plan.channels.length === 0) {
            console.log(chalk.yellow('No eligible candidates found. Run `oatt collect` first.'));
            return;
        }

        // Interactive loop
        let done = false;
        while (!done) {
            const { action } = await inquirer.default.prompt([{
                type: 'list',
                name: 'action',
                message: 'Action:',
                choices: [
                    { name: 'Execute plan', value: 'execute' },
                    { name: 'Add candidate', value: 'add' },
                    { name: 'Remove from plan', value: 'remove' },
                    { name: 'Resize channel', value: 'resize' },
                    { name: 'Refresh plan', value: 'refresh' },
                    { name: 'Show bos command', value: 'bos' },
                    { name: 'Quit', value: 'quit' },
                ],
            }]);

            switch (action) {
                case 'execute': {
                    const { confirm } = await inquirer.default.prompt([{
                        type: 'confirm',
                        name: 'confirm',
                        message: `Open ${plan.channels.length} channels for ${formatSats(plan.totalAmount)}?`,
                        default: false,
                    }]);
                    if (confirm) {
                        const { feeRate } = await inquirer.default.prompt([{
                            type: 'number',
                            name: 'feeRate',
                            message: 'Enter fee rate (sats/vB):',
                            default: 2,
                        }]);

                        const { executePlan, formatResults } = await import('./opener.js');
                        console.log(chalk.yellow('\nOpening channels...'));
                        const candidates = loadCandidates();
                        let results: any[] = [];
                        try {
                            results = await executePlan(plan, {
                                feeRate,
                                onProgress: (msg: string) => console.log(msg),
                                availableCandidates: candidates,
                                openPeerPubkeys,
                                defaultSize,
                                maxSize
                            });
                        } catch (err: any) {
                            console.log(chalk.red('\n✗ Batch execution failed:'));
                            console.log(chalk.red(`  ${err.message || err.details || JSON.stringify(err)}`));
                            continue; // In interactive mode, we want to continue to the menu
                        }
                        console.log(formatResults(results));

                        const failures = results.filter(r => !r.success);
                        if (failures.length > 0) {
                            const { retry } = await inquirer.default.prompt([{
                                type: 'confirm',
                                name: 'retry',
                                message: 'Batch had failures. Refresh plan and retry?',
                                default: true,
                            }]);
                            if (retry) {
                                plan = createPlan({ budget, defaultSize, maxSize, openPeerPubkeys });
                                renderPlanTable(plan);
                                continue;
                            }
                        }
                        done = true;
                    }
                    break;
                }
                case 'add': {
                    const { pubkey } = await inquirer.default.prompt([{
                        type: 'input',
                        name: 'pubkey',
                        message: 'Pubkey to add:',
                    }]);
                    if (pubkey) {
                        try {
                            plan = addToPlan(plan, pubkey.trim());
                            renderPlanTable(plan);
                        } catch (e) {
                            console.log(chalk.red((e as Error).message));
                        }
                    }
                    break;
                }
                case 'remove': {
                    const { index } = await inquirer.default.prompt([{
                        type: 'number',
                        name: 'index',
                        message: 'Channel number to remove:',
                    }]);
                    if (index !== undefined && index > 0 && index <= plan.channels.length) {
                        const channel = plan.channels[index - 1];
                        const { reason } = await inquirer.default.prompt([{
                            type: 'list',
                            name: 'reason',
                            message: `Why remove ${channel.alias}?`,
                            choices: Object.keys(REJECTION_CONFIG).map(r => ({ name: r, value: r })),
                        }]);

                        if (reason) {
                            addRejection(channel.pubkey, {
                                date: new Date(),
                                reason: reason as RejectionReason,
                                details: 'Removed from plan manually',
                            });

                            try {
                                plan = removeFromPlan(plan, index - 1);  // Convert to 0-indexed
                                renderPlanTable(plan);
                            } catch (e) {
                                console.log(chalk.red((e as Error).message));
                            }
                        }
                    } else {
                        console.log(chalk.red('Invalid index'));
                    }
                    break;
                }
                case 'resize': {
                    const { index, amount } = await inquirer.default.prompt([
                        { type: 'number', name: 'index', message: 'Channel number:' },
                        { type: 'number', name: 'amount', message: 'New amount (sats):' },
                    ]);
                    if (index !== undefined && amount) {
                        try {
                            plan = resizeInPlan(plan, index - 1, amount);
                            renderPlanTable(plan);
                        } catch (e) {
                            console.log(chalk.red((e as Error).message));
                        }
                    }
                    break;
                }
                case 'refresh': {
                    plan = createPlan({ budget, defaultSize, maxSize, openPeerPubkeys });
                    renderPlanTable(plan);
                    break;
                }
                case 'bos': {
                    const { generateBosCommand } = await import('./opener.js');
                    console.log('\n' + chalk.gray(generateBosCommand(plan)) + '\n');
                    break;
                }
                case 'quit':
                    process.exit(0);
                    break;
            }
        }
        process.exit(0);
    });

// ============ open ============

program
    .command('open')
    .description('Execute a batch channel open from saved plan or directly')
    .option('--dry-run', 'Show what would happen without actually opening')
    .option('-b, --budget <sats>', 'Total budget (creates new plan)')
    .option('-s, --default-size <sats>', 'Default channel size', '1000000')
    .option('-m, --max-size <sats>', 'Maximum channel size', '10000000')
    .action(async (options) => {
        const { createPlan, formatSats } = await import('./planner.js');
        const { executePlan, formatResults, generateBosCommand } = await import('./opener.js');
        const inquirer = await import('inquirer');

        // Create plan from budget
        if (!options.budget) {
            console.log(chalk.red('Please specify --budget'));
            console.log('Usage: oatt open --budget 10000000 [--dry-run]');
            process.exit(1);
        }

        let openPeerPubkeys: Set<string> | undefined;
        try {
            const { getChannels } = await import('./lnd.js');
            const channels = await getChannels();
            openPeerPubkeys = new Set(channels.map(c => c.partner_public_key));
        } catch (e) {}

        const plan = createPlan({
            budget: parseInt(options.budget),
            defaultSize: parseInt(options.defaultSize),
            maxSize: parseInt(options.maxSize),
            openPeerPubkeys,
        });

        console.log(chalk.bold('\nBatch Channel Open Plan'));
        renderPlanTable(plan);

        if (plan.channels.length === 0) {
            console.log(chalk.yellow('No eligible candidates.'));
            return;
        }

        if (options.dryRun) {
            console.log(chalk.yellow('DRY RUN - No channels will be opened\n'));
            console.log('Equivalent bos command:');
            console.log(chalk.gray(generateBosCommand(plan)));
            console.log('');
            process.exit(0);
        }

        // Confirm before executing
        const { confirm } = await inquirer.default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Open ${plan.channels.length} channels for ${formatSats(plan.totalAmount)}?`,
            default: false,
        }]);

        if (confirm) {
            const { feeRate } = await inquirer.default.prompt([{
                type: 'number',
                name: 'feeRate',
                message: 'Enter fee rate (sats/vB):',
                default: 2,
            }]);

            console.log(chalk.yellow('\nOpening channels...'));
            const candidates = loadCandidates();
            try {
                const results = await executePlan(plan, {
                    feeRate,
                    onProgress: (msg: string) => console.log(msg),
                    availableCandidates: candidates,
                    openPeerPubkeys,
                    defaultSize: parseInt(options.defaultSize),
                    maxSize: parseInt(options.maxSize),
                });
                console.log(formatResults(results));
                process.exit(0);
            } catch (err: any) {
                console.log(chalk.red('\n✗ Batch execution failed:'));
                console.log(chalk.red(`  ${err.message || err.details || JSON.stringify(err)}`));
                process.exit(1);
            }
        } else {
            process.exit(0);
        }
    });

program.parse();
