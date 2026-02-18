/**
 * OATT - Configuration management
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface LndConfig {
    socket: string;
    macaroonPath: string;
    certPath: string;
}

export interface DefaultsConfig {
    channelSize: number;      // Default channel size in sats
    maxChannelSize: number;   // Maximum acceptable channel size
    minDistance: number;      // Minimum graph distance for candidates
    minChannels: number;      // Minimum channels a node should have
    minCapacity: number;      // Minimum capacity in sats
    activeDays: number;       // Max days since last update
}

export interface Config {
    lnd: LndConfig;
    defaults: DefaultsConfig;
}

const DEFAULT_CONFIG: Config = {
    lnd: {
        socket: 'localhost:10009',
        macaroonPath: path.join(os.homedir(), '.lnd/data/chain/bitcoin/mainnet/admin.macaroon'),
        certPath: path.join(os.homedir(), '.lnd/tls.cert'),
    },
    defaults: {
        channelSize: 1_000_000,
        maxChannelSize: 10_000_000,
        minDistance: 2,
        minChannels: 10,
        minCapacity: 10_000_000,  // 0.1 BTC
        activeDays: 7,
    },
};

// Config directory
export function getConfigDir(): string {
    return path.join(os.homedir(), '.oatt');
}

// Config file path
export function getConfigPath(): string {
    return path.join(getConfigDir(), 'config.json');
}

// Ensure config directory exists
export function ensureConfigDir(): void {
    const dir = getConfigDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// Expand ~ in paths
function expandPath(p: string): string {
    if (p.startsWith('~')) {
        return path.join(os.homedir(), p.slice(1));
    }
    return p;
}

// Load configuration
export function loadConfig(): Config {
    ensureConfigDir();
    const configPath = getConfigPath();

    if (!fs.existsSync(configPath)) {
        // Create default config
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return DEFAULT_CONFIG;
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<Config>;

        // Merge with defaults and expand paths
        const config: Config = {
            lnd: {
                socket: parsed.lnd?.socket ?? DEFAULT_CONFIG.lnd.socket,
                macaroonPath: expandPath(parsed.lnd?.macaroonPath ?? DEFAULT_CONFIG.lnd.macaroonPath),
                certPath: expandPath(parsed.lnd?.certPath ?? DEFAULT_CONFIG.lnd.certPath),
            },
            defaults: {
                ...DEFAULT_CONFIG.defaults,
                ...parsed.defaults,
            },
        };

        return config;
    } catch (error) {
        console.error('Error loading config:', error);
        return DEFAULT_CONFIG;
    }
}

// Save configuration
export function saveConfig(config: Config): void {
    ensureConfigDir();
    const configPath = getConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
