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
                source: 'manual',
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
    .action((options) => {
        const candidates = loadCandidates();

        if (candidates.length === 0) {
            console.log(chalk.yellow('No candidates. Run `oatt collect` first.'));
            return;
        }

        let filtered = candidates;

        // Filter eligible only
        if (options.eligible) {
            filtered = candidates.filter(c => {
                if (c.rejections.length === 0) return true;

                // Check if all rejections are retryable
                return c.rejections.every(r => {
                    const config = REJECTION_CONFIG[r.reason];
                    if (!config.retryable) return false;

                    // Check cooldown
                    if (config.cooldownDays !== undefined) {
                        const cooldownMs = config.cooldownDays * 24 * 60 * 60 * 1000;
                        const age = Date.now() - new Date(r.date).getTime();
                        return age >= cooldownMs;
                    }

                    return true;
                });
            });
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
        console.log(formatCandidateHeader());

        for (const candidate of filtered) {
            console.log(formatCandidate(candidate, options.all));
        }

        console.log('');
    });

function formatCandidateHeader(): string {
    return chalk.gray(
        'Pubkey          Channels  Capacity  Distance  Min Size  Source        Alias'
    );
}

function formatCandidate(c: ChannelCandidate, showDetails: boolean): string {
    const pubkey = c.pubkey.slice(0, 12) + '...';
    const channels = c.channels.toString().padStart(8);
    const capacity = formatSats(c.capacitySats).padStart(10);
    const distance = (c.distance?.toString() ?? '-').padStart(8);
    const minSize = c.minChannelSize ? formatSats(c.minChannelSize).padStart(10) : '         -';
    const source = c.source.padEnd(12);
    const alias = c.alias.slice(0, 30);

    let line = `${pubkey}  ${channels}  ${capacity}  ${distance}  ${minSize}  ${source}  ${alias}`;

    // Color based on rejection status
    if (c.rejections.length > 0) {
        const hasBlockingRejection = c.rejections.some(r => !REJECTION_CONFIG[r.reason].retryable);
        if (hasBlockingRejection) {
            line = chalk.red(line);
        } else {
            line = chalk.yellow(line);
        }
    }

    if (showDetails && c.rejections.length > 0) {
        const rejectionDetails = c.rejections
            .map(r => `    ${chalk.gray(r.reason)}: ${r.details ?? ''} ${r.minChannelSize ? formatSats(r.minChannelSize) : ''}`)
            .join('\n');
        line += '\n' + rejectionDetails;
    }

    return line;
}

function formatSats(sats: number): string {
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
                acc[c.source] = (acc[c.source] ?? 0) + 1;
                return acc;
            }, {} as Record<string, number>);

            console.log('\n  By source:');
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
        const { createPlan, formatPlan, addToPlan, removeFromPlan, resizeInPlan } = await import('./planner.js');
        const inquirer = await import('inquirer');
        const { getChainBalance, connectLnd } = await import('./lnd.js');

        let budget: number;
        
        try {
            await connectLnd();
            const balance = await getChainBalance();
            const available = balance.confirmed;
            
            if (options.budget) {
                budget = parseInt(options.budget);
            } else {
                console.log(chalk.gray(`\nAvailable on-chain balance: ${formatSats(available)}`));
                // Suggest 95% of balance to leave some for fees/reserves
                const suggested = Math.floor(available * 0.95);
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
                console.error(chalk.red('Error fetching chain balance. Please specify --budget explicitly.'));
                process.exit(1);
            }
        }

        const defaultSize = parseInt(options.defaultSize);
        const maxSize = parseInt(options.maxSize);

        let plan = createPlan({ budget, defaultSize, maxSize });

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
                        const { executePlan, formatResults } = await import('./opener.js');
                        console.log(chalk.yellow('\nOpening channels...'));
                        const results = await executePlan(plan, {
                            onProgress: (msg: string) => console.log(msg),
                        });
                        console.log(formatResults(results));
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
                    plan = createPlan({ budget, defaultSize, maxSize });
                    console.log(formatPlan(plan));
                    break;
                }
                case 'bos': {
                    const { generateBosCommand } = await import('./opener.js');
                    console.log('\n' + chalk.gray(generateBosCommand(plan)) + '\n');
                    break;
                }
                case 'quit':
                    done = true;
                    break;
            }
        }
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
        const { createPlan, formatPlan } = await import('./planner.js');
        const { executePlan, formatResults, generateBosCommand } = await import('./opener.js');

        // Create plan from budget
        if (!options.budget) {
            console.log(chalk.red('Please specify --budget'));
            console.log('Usage: oatt open --budget 10000000 [--dry-run]');
            process.exit(1);
        }

        const plan = createPlan({
            budget: parseInt(options.budget),
            defaultSize: parseInt(options.defaultSize),
            maxSize: parseInt(options.maxSize),
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
            return;
        }

        // Confirm before executing
        const inquirer = await import('inquirer');
        const { confirm } = await inquirer.default.prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Open ${plan.channels.length} channels for ${formatSats(plan.totalAmount)}?`,
            default: false,
        }]);

        if (!confirm) {
            console.log(chalk.yellow('Cancelled.'));
            return;
        }

        console.log(chalk.yellow('\nOpening channels...'));
        const results = await executePlan(plan, {
            onProgress: (msg: string) => console.log(msg),
        });
        console.log(formatResults(results));
    });

program.parse();
