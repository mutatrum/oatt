import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { upsertCandidate, loadCandidates, getCandidate } from './storage.js';
import type { ChannelCandidate } from './models.js';

// Mock fs and config
vi.mock('node:fs');
vi.mock('./config.js', () => ({
    getConfigDir: () => '/mock/config/dir',
    ensureConfigDir: vi.fn(),
}));

describe('storage', () => {
    // Helper to setup fs mock state
    let mockFileContent: string | null = null;

    beforeEach(() => {
        vi.resetAllMocks();
        mockFileContent = null;

        // Default fs mocks
        vi.mocked(fs.existsSync).mockImplementation(() => mockFileContent !== null);
        vi.mocked(fs.readFileSync).mockImplementation(() => mockFileContent || '[]');
        vi.mocked(fs.writeFileSync).mockImplementation((_path, data) => {
            mockFileContent = data as string;
        });
    });

    const createCandidate = (pubkey: string, sources: string[] = ['manual']): ChannelCandidate => ({
        pubkey,
        alias: 'alias',
        sources: sources as any[],
        addedAt: new Date('2023-01-01'),
        channels: 10,
        capacitySats: 1000,
        lastUpdate: new Date('2023-01-01'),
        history: [],
        rejections: [],
    });

    describe('upsertCandidate', () => {
        it('should add a new candidate', () => {
            const candidate = createCandidate('pub1');
            upsertCandidate(candidate);

            const saved = loadCandidates();
            expect(saved).toHaveLength(1);
            expect(saved[0].pubkey).toBe('pub1');
        });

        it('should merge sources for existing candidate', () => {
            // Initial state
            const existing = createCandidate('pub1', ['manual']);
            upsertCandidate(existing);

            // Update with new source
            const update = createCandidate('pub1', ['graph_distance']);
            upsertCandidate(update);

            const saved = getCandidate('pub1');
            expect(saved?.sources).toContain('manual');
            expect(saved?.sources).toContain('graph_distance');
            expect(saved?.sources).toHaveLength(2);
        });

        it('should update metrics but preserve addedAt', () => {
            const existing = createCandidate('pub1');
            upsertCandidate(existing);

            const update = {
                ...createCandidate('pub1'),
                channels: 20, // increased
                addedAt: new Date('2023-02-01') // newer date
            };
            upsertCandidate(update);

            const saved = getCandidate('pub1');
            expect(saved?.channels).toBe(20);
            expect(saved?.addedAt.toISOString()).toBe(existing.addedAt.toISOString()); // Should keep original
        });

        it('should calculate max minChannelSize from rejections', () => {
             const candidate = createCandidate('pub1');
             upsertCandidate(candidate);

             const update = {
                 ...candidate,
                 rejections: [
                     { date: new Date(), reason: 'min_channel_size', minChannelSize: 1000 } as any,
                     { date: new Date(), reason: 'min_channel_size', minChannelSize: 5000 } as any
                 ]
             };
             upsertCandidate(update);

             const saved = getCandidate('pub1');
             expect(saved?.minChannelSize).toBe(5000);
        });
        
         it('should merge history entries without duplicates', () => {
            const h1 = { channelId: '1', openedAt: new Date(1), closedAt: new Date(2), closeType: 'coop', localBalance: 0, remoteBalance: 0, satsRouted: 0, feesEarned: 0 };
            const candidate = { ...createCandidate('pub1'), history: [h1] as any };
            upsertCandidate(candidate);
            
            // Upsert same history again + new one
            const h2 = { ...h1, channelId: '2' };
            const update = { ...createCandidate('pub1'), history: [h1, h2] as any };
            upsertCandidate(update);
            
            const saved = getCandidate('pub1');
            expect(saved?.history).toHaveLength(2);
            expect(saved?.history.map(h => h.channelId)).toEqual(['1', '2']);
        });
    });
});
