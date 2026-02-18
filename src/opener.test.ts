import { describe, it, expect } from 'vitest';
import { parseOpenError } from './opener.js';

describe('parseOpenError', () => {
    it('should parse standard sat-based capacity errors', () => {
        const error = 'chan size of 100000sat is below min chan size of 200000sat';
        const result = parseOpenError(error);
        expect(result.reason).toBe('min_channel_size');
        expect(result.minSize).toBe(200000);
    });

    it('should parse BTC-denominated capacity errors', () => {
        const error = 'chan size of 0.01000000 BTC is below min chan size of 0.05000000 BTC';
        const result = parseOpenError(error);
        expect(result.reason).toBe('min_channel_size');
        expect(result.minSize).toBe(5_000_000);
    });

    it('should calculate overhead buffer for complex capacity errors', () => {
        // Based on actual error from user:
        // funding 1000000sat, reserves 10000sat/10000sat, ..., channel capacity is 979056sat, which is below 1000000sat
        const error = 'funding 1000000sat, reserves 10000sat/10000sat, channel capacity is 979056sat, which is below 1000000sat';
        const result = parseOpenError(error);
        
        expect(result.reason).toBe('min_channel_size');
        
        // Overhead = 1,000,000 - 979,056 = 20,944
        // Required = 1,000,000
        // Result = 1,000,000 + 20,944 + 10,000 (buffer) = 1,030,944
        expect(result.minSize).toBe(1030944);
    });

    it('should extract pubkey from the error message', () => {
        const pubkey = '022bd0aa893db4ac890e457cca8c83f112518d6941bf9153dab4bf904620503a78';
        const error = `received funding error from ${pubkey}: some error`;
        const result = parseOpenError(error);
        expect(result.pubkey).toBe(pubkey);
    });

    it('should handle remote canceled funding as internal_error', () => {
        const error = 'remote canceled funding, possibly timed out';
        const result = parseOpenError(error);
        expect(result.reason).toBe('internal_error');
    });

    it('should detect Tor general error', () => {
        const error = 'tor general error (e.g. status 503)';
        const result = parseOpenError(error);
        expect(result.reason).toBe('failed_to_connect');
        expect(result.details).toContain('tor general error');
    });

    it('should handle offline errors', () => {
        const error = 'peer is not online';
        const result = parseOpenError(error);
        expect(result.reason).toBe('not_online');
    });

    it('should avoid over-matching "err" in JSON by looking for specific error terms', () => {
        // If we just matched "err", this would be an internal_error
        const error = { some_field: 'cherry' }; 
        const result = parseOpenError(error);
        expect(result.reason).not.toBe('internal_error');
        expect(result.reason).toBe('rejected'); // Default fallback
    });
});
