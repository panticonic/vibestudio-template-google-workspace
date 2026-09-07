/**
 * Ad blocking programmatic interface for panels.
 *
 * Provides a clean API for panels to interact with the ad blocking system,
 * including per-panel stats and control.
 */
import type { RpcClient } from "@vibestudio/rpc";
/**
 * Ad blocking statistics.
 */
export interface AdBlockStats {
    blockedRequests: number;
    blockedElements: number;
}
/**
 * Ad blocking API interface.
 */
export interface AdBlockApi {
    /** Get global ad blocking statistics */
    getStats(): Promise<AdBlockStats>;
    /** Check if ad blocking is globally active */
    isActive(): Promise<boolean>;
    /** Get ad blocking statistics for a specific panel */
    getStatsForPanel(webContentsId: number): Promise<AdBlockStats>;
    /** Check if ad blocking is enabled for a specific panel */
    isEnabledForPanel(webContentsId: number): Promise<boolean>;
    /** Enable or disable ad blocking for a specific panel */
    setEnabledForPanel(webContentsId: number, enabled: boolean): Promise<void>;
    /** Reset statistics for a specific panel */
    resetStatsForPanel(webContentsId: number): Promise<void>;
    /** Get the URL currently being tracked for a panel */
    getPanelUrl(webContentsId: number): Promise<string | undefined>;
    /** Add a domain to the global whitelist (supports wildcards like *.example.com) */
    addToWhitelist(domain: string): Promise<void>;
    /** Remove a domain from the global whitelist */
    removeFromWhitelist(domain: string): Promise<void>;
}
/**
 * Create the ad blocking API using the provided RPC bridge.
 */
export function createAdBlockApi(rpc: Pick<RpcClient, "call">): AdBlockApi {
    return {
        async getStats(): Promise<AdBlockStats> {
            return rpc.call<AdBlockStats>("main", "adblock.getStats", []);
        },
        async isActive(): Promise<boolean> {
            return rpc.call<boolean>("main", "adblock.isActive", []);
        },
        async getStatsForPanel(webContentsId: number): Promise<AdBlockStats> {
            return rpc.call<AdBlockStats>("main", "adblock.getStatsForPanel", [webContentsId]);
        },
        async isEnabledForPanel(webContentsId: number): Promise<boolean> {
            return rpc.call<boolean>("main", "adblock.isEnabledForPanel", [webContentsId]);
        },
        async setEnabledForPanel(webContentsId: number, enabled: boolean): Promise<void> {
            await rpc.call<boolean>("main", "adblock.setEnabledForPanel", [webContentsId, enabled]);
        },
        async resetStatsForPanel(webContentsId: number): Promise<void> {
            await rpc.call<boolean>("main", "adblock.resetStatsForPanel", [webContentsId]);
        },
        async getPanelUrl(webContentsId: number): Promise<string | undefined> {
            return rpc.call<string | undefined>("main", "adblock.getPanelUrl", [webContentsId]);
        },
        async addToWhitelist(domain: string): Promise<void> {
            await rpc.call<boolean>("main", "adblock.addToWhitelist", [domain]);
        },
        async removeFromWhitelist(domain: string): Promise<void> {
            await rpc.call<boolean>("main", "adblock.removeFromWhitelist", [domain]);
        },
    };
}
