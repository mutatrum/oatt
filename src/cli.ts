/**
 * OATT - CLI Entry Point
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, getConfigPath } from './config.js';
import { loadCandidates, addRejection, removeCandidate } from './storage.js';
import { runForceClosedCollection } from './collectors/force-closed.js';
import { runGraphDistanceCollection } from './collectors/graph-distance.js';
import { connectLnd, getNodeInfo, getOwnPubkey } from './lnd.js';
import { REJECTION_CONFIG, type RejectionReason, type ChannelCandidate } from './models.js';

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
        const { isEligible } = await import('./planner.js');
        const { getChannels } = await import('./lnd.js');

        const candidates = loadCandidates();

        if (candidates.length === 0) {
            console.log(chalk.yellow('No candidates. Run `oatt collect` first.'));
            return;
        }

        let openPeerPubkeys: Set<string> | undefined;
        try {
            await connectLnd();
            const channels = await getChannels();
            openPeerPubkeys = new Set(channels.map(c => c.partner_public_key));
        } catch (e) {
            console.warn(chalk.yellow('Warning: Could not fetch open channels from LND. List may include existing partners.'));
        }

        let filtered = candidates;

        // Filter eligible only
        if (options.eligible) {
            filtered = candidates.filter(c => isEligible(c, openPeerPubkeys));
        }

        // Sort
        if (options.byDistance) {
            filtered.sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
        } else {
            // Default: sort by channels
            filtered.sort((a, b) => b.channels - a.channels);
        }

        // Display
        console.log(chalk.bold(`\n${filtered.length} candidates:\n`));
        console.log(chalk.gray(
            'Alias                     Pubkey          Sources         Ch  Cap     Dist  Min Size  Status         Age'
        ));

        for (const candidate of filtered) {
            const c = candidate;
            const alias = c.alias.slice(0, 25).padEnd(25);
            const pubkey = (c.pubkey.slice(0, 12) + '...').padEnd(15);
            
            const sourceLabels = c.sources.map(s => {
                switch (s) {
                    case 'force_closed': return 'Closed';
                    case 'graph_distance': return 'Graph';
                    case 'forwarding_history': return 'Forwards';
                    case 'manual': return 'Manual';
                    default: return s;
                }
            }).join('|');
            const sources = sourceLabels.slice(0, 15).padEnd(15);

            const channels = c.channels.toString().padStart(2);
            const capacity = formatSats(c.capacitySats).padStart(7);
            const distance = (c.distance?.toString() ?? '-').padStart(4);
            const minSize = c.minChannelSize ? formatSats(c.minChannelSize).padStart(8) : '       -';
            const age = Math.floor((Date.now() - c.addedAt.getTime()) / (1000 * 60 * 60 * 24));

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
            let line = `${alias} ${pubkey} ${sources} ${channels} ${capacity} ${distance} ${minSize} ${statusStr} ${age}d`;

            if (options.all && c.rejections.length > 0) {
                const rejectionLines = c.rejections.map(r => {
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
                line += '\n' + rejectionLines.join('\n');
            }
            console.log(line);
        }

        console.log('');
    });

function formatSats(sats: number | undefined | null): string {
    if (sats === undefined || sats === null) {
        return '0';
    }
    if (sats >= 100_000_000) {
        return (sats / 100_000_000).toFixed(2) + ' BTC';
    }
    if (sats >= 1_000_000) {
        return (sats / 1_000_000).toFixed(1) + 'M';
    }
    if (sats >= 1_000) {
        return (sats / 1_000).toFixed(0) + 'k';
    }
    return sats.toString();
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
        const { createPlan, formatPlan, addToPlan, removeFromPlan, resizeInPlan, formatSats } = await import('./planner.js');
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
        console.log(formatPlan(plan));

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
                        const results = await executePlan(plan, {
                            feeRate,
                            onProgress: (msg: string) => console.log(msg),
                        });
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
                                console.log(formatPlan(plan));
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
                            console.log(formatPlan(plan));
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
                                console.log(formatPlan(plan));
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
                            console.log(formatPlan(plan));
                        } catch (e) {
                            console.log(chalk.red((e as Error).message));
                        }
                    }
                    break;
                }
                case 'refresh': {
                    plan = createPlan({ budget, defaultSize, maxSize, openPeerPubkeys });
                    console.log(formatPlan(plan));
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
        const { createPlan, formatPlan, formatSats } = await import('./planner.js');
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
        console.log(formatPlan(plan));

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
            const results = await executePlan(plan, {
                feeRate,
                onProgress: (msg: string) => console.log(msg),
            });
            console.log(formatResults(results));
            process.exit(0);
        } else {
            process.exit(0);
        }
    });

program.parse();
