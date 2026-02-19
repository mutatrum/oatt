import { describe, it, expect } from 'vitest';
import { isEligible, sortCandidatesBySignal, createPlan } from './planner.js';
import { REJECTION_CONFIG, ANCHOR_RESERVE, type ChannelCandidate } from './models.js';

describe('planner', () => {
    describe('isEligible', () => {
        const baseCandidate: ChannelCandidate = {
            pubkey: 'pub1',
            alias: 'alias1',
            sources: ['manual'],
            addedAt: new Date(),
            channels: 10,
            capacitySats: 10000000,
            lastUpdate: new Date(),
            history: [],
            rejections: [],
        };

        it('should be eligible if no rejections', () => {
            expect(isEligible(baseCandidate)).toBe(true);
        });

        it('should not be eligible if partner pubkey is in openPeerPubkeys', () => {
            const openPeers = new Set(['pub1']);
            expect(isEligible(baseCandidate, openPeers)).toBe(false);
        });

        it('should not be eligible if has non-retryable rejection', () => {
            const candidate = {
                ...baseCandidate,
                rejections: [{ date: new Date(), reason: 'already_open' as any }]
            };
            expect(isEligible(candidate)).toBe(false);
        });

        it('should not be eligible if in cooldown', () => {
            const oneHourAgo = new Date();
            oneHourAgo.setHours(oneHourAgo.getHours() - 1);
            
            const candidate = {
                ...baseCandidate,
                rejections: [{ date: oneHourAgo, reason: 'failed_to_connect' as any }]
            };
            // failed_to_connect has 1 day cooldown
            expect(isEligible(candidate)).toBe(false);
        });

        it('should be eligible if cooldown expired', () => {
            const twoDaysAgo = new Date();
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
            
            const candidate = {
                ...baseCandidate,
                rejections: [{ date: twoDaysAgo, reason: 'failed_to_connect' as any }]
            };
            expect(isEligible(candidate)).toBe(true);
        });
    });

    describe('sortCandidatesBySignal', () => {
        const c1: ChannelCandidate = {
            pubkey: 'c1',
            alias: 'c1',
            sources: ['graph_distance'],
            addedAt: new Date(2023, 1, 1),
            channels: 10,
            capacitySats: 1000000,
            history: [],
            rejections: [],
            lastUpdate: new Date(),
        };

        const c2: ChannelCandidate = {
            ...c1,
            pubkey: 'c2',
            alias: 'c2',
            sources: ['manual', 'graph_distance'],
        };

        const c3: ChannelCandidate = {
            ...c1,
            pubkey: 'c3',
            alias: 'c3',
            history: [{ channelId: '1', openedAt: new Date(), feesEarned: 1000, localBalance: 0, remoteBalance: 0, satsRouted: 0 }],
        };

        it('should prioritize manual candidates', () => {
            const sorted = sortCandidatesBySignal([c1, c2]);
            expect(sorted[0].pubkey).toBe('c2');
        });

        it('should prioritize profitable history', () => {
            const sorted = sortCandidatesBySignal([c1, c3]);
            expect(sorted[0].pubkey).toBe('c3');
        });

        it('should prioritize multi-signal (source count)', () => {
            const cMulti: ChannelCandidate = { ...c1, pubkey: 'multi', sources: ['graph_distance', 'forwarding_history'] };
            const sorted = sortCandidatesBySignal([c1, cMulti]);
            expect(sorted[0].pubkey).toBe('multi');
        });
    });

    describe('createPlan', () => {
        const candidates: ChannelCandidate[] = [
            {
                pubkey: 'p1',
                alias: 'p1',
                sources: ['manual'],
                addedAt: new Date(),
                channels: 10,
                capacitySats: 10000000,
                lastUpdate: new Date(),
                history: [],
                rejections: [],
            },
            {
                pubkey: 'p2',
                alias: 'p2',
                sources: ['graph_distance'],
                addedAt: new Date(),
                channels: 20,
                capacitySats: 20000000,
                lastUpdate: new Date(),
                history: [],
                rejections: [],
            }
        ];

        it('should allocate budget respecting defaultSize and anchor reserve', () => {
            const budget = 2_000_000 + (2 * ANCHOR_RESERVE);
            const plan = createPlan({
                budget,
                defaultSize: 1_000_000,
                maxSize: 5_000_000,
                candidates
            });

            expect(plan.channels.length).toBe(2);
            expect(plan.channels[0].amount).toBe(1_000_000);
            expect(plan.totalAmount).toBe(2_000_000);
            expect(plan.remainingBudget).toBe(0);
        });

        it('should skip candidates if budget is insufficient', () => {
            const budget = 1_000_000 + ANCHOR_RESERVE + 500_000; // Not enough for second
            const plan = createPlan({
                budget,
                defaultSize: 1_000_000,
                maxSize: 5_000_000,
                candidates
            });

            expect(plan.channels.length).toBe(1);
            expect(plan.remainingBudget).toBe(500_000);
        });

        it('should respect learned minimum sizes', () => {
            const cWithMin: ChannelCandidate = {
                ...candidates[0],
                minChannelSize: 2_000_000
            };
            const plan = createPlan({
                budget: 3_000_000 + ANCHOR_RESERVE,
                defaultSize: 1_000_000,
                maxSize: 5_000_000,
                candidates: [cWithMin]
            });

            expect(plan.channels[0].amount).toBe(2_000_000);
            expect(plan.channels[0].isMinimumEnforced).toBe(true);
        });
    });
});
