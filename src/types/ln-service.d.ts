// ln-service has no types, declare module
declare module 'ln-service' {
    export interface AuthenticatedLnd {
        lnd: unknown;
    }

    export interface LndAuthentication {
        socket: string;
        macaroon: string;
        cert: string;
    }

    export function authenticatedLndGrpc(auth: LndAuthentication): AuthenticatedLnd;

    export function getWalletInfo(args: { lnd: unknown }): Promise<{
        public_key: string;
        alias: string;
    }>;

    export function getNode(args: {
        lnd: unknown;
        public_key: string;
        is_omitting_channels?: boolean;
    }): Promise<{
        public_key: string;
        alias: string;
        channel_count: number;
        capacity: number;
        updated_at: string;
        sockets?: string[];
        features?: { type: string }[];
    }>;

    export function getChannels(args: { lnd: unknown }): Promise<{
        channels: {
            id: string;
            partner_public_key: string;
            local_balance: number;
            remote_balance: number;
            is_active: boolean;
        }[];
    }>;

    export function getClosedChannels(args: { lnd: unknown }): Promise<{
        channels: {
            id: string;
            partner_public_key: string;
            close_balance_vout?: number;
            close_transaction_id?: string;
            is_breach_close: boolean;
            is_cooperative_close: boolean;
            is_funding_cancel: boolean;
            is_local_force_close: boolean;
            is_remote_force_close: boolean;
            final_local_balance: number;
            final_time_locked_balance: number;
        }[];
    }>;

    export function getForwards(args: {
        lnd: unknown;
        after?: string;
        before?: string;
    }): Promise<{
        forwards: {
            created_at: string;
            fee: number;
            incoming_channel: string;
            outgoing_channel: string;
            tokens: number;
        }[];
    }>;

    export function getNetworkGraph(args: { lnd: unknown }): Promise<{
        channels: {
            id: string;
            capacity: number;
            policies: {
                public_key: string;
                base_fee_mtokens: string;
                fee_rate: number;
                is_disabled: boolean;
            }[];
        }[];
        nodes: {
            alias: string;
            public_key: string;
            updated_at: string;
            sockets?: string[];
            features?: { bit: number; is_known: boolean; is_required: boolean; type: string }[];
        }[];
    }>;

    export function openChannel(args: {
        lnd: unknown;
        partner_public_key: string;
        local_tokens: number;
        is_private?: boolean;
    }): Promise<{
        transaction_id: string;
        transaction_vout: number;
    }>;

    // Batch channel opening
    export interface OpenChannelsChannel {
        capacity: number;
        partner_public_key: string;
        is_private?: boolean;
        cooperative_close_address?: string;
        base_fee_mtokens?: string;
        fee_rate?: number;
        give_tokens?: number;
        min_htlc_mtokens?: string;
    }

    export interface PendingChannel {
        address: string;
        id: string;
        tokens: number;
    }

    export function openChannels(args: {
        lnd: unknown;
        channels: OpenChannelsChannel[];
        is_avoiding_broadcast?: boolean;
    }): Promise<{
        pending: PendingChannel[];
    }>;

    export function fundPsbt(args: {
        lnd: unknown;
        outputs: { address: string; tokens: number }[];
        fee_tokens_per_vbyte?: number;
        min_confirmations?: number;
    }): Promise<{
        inputs: {
            lock_expires_at?: string;
            lock_id?: string;
            transaction_id: string;
            transaction_vout: number;
        }[];
        outputs: {
            is_change: boolean;
            output_script: string;
            tokens: number;
        }[];
        psbt: string;
    }>;

    export function signPsbt(args: {
        lnd: unknown;
        psbt: string;
    }): Promise<{
        psbt: string;
    }>;

    export function fundPendingChannels(args: {
        lnd: unknown;
        channels: string[];
        funding: string;
    }): Promise<void>;

    export function cancelPendingChannel(args: {
        lnd: unknown;
        id: string;
    }): Promise<void>;

    export function addPeer(args: {
        lnd: unknown;
        public_key: string;
        socket: string;
        is_temporary?: boolean;
    }): Promise<void>;

    export function getPeers(args: {
        lnd: unknown;
    }): Promise<{
        peers: {
            public_key: string;
            socket: string;
            is_inbound: boolean;
        }[];
    }>;

    export function getChainBalance(args: {
        lnd: unknown;
    }): Promise<{
        chain_confirmed_balance: number;
        chain_unconfirmed_balance: number;
    }>;

    export function getWalletStatus(args: {
        lnd: unknown;
    }): Promise<{
        is_active: boolean;
        is_ready: boolean;
    }>;
}
