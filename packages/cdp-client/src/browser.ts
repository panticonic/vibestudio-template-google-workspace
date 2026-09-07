import { BrowserImpl } from "./worker";

export { BrowserImpl };
export { CdpConnection, CdpError } from "./worker";
export type {
  CdpProfileCoverage,
  CdpProfileCoverageScript,
  CdpProfileNetworkMetrics,
  CdpProfileNetworkRequest,
  CdpProfileOptions,
  CdpProfilePageMetrics,
  CdpProfileReport,
  CdpProfileRuntimeMetrics,
} from "./profile";

export type Browser = Awaited<ReturnType<typeof BrowserImpl.connect>>;

export type Options = {
  headless?: boolean;
};

export async function connect(
  wsEndpoint: string,
  _browserName: string,
  options: Options & { authToken?: string } = {}
): Promise<Browser> {
  return BrowserImpl.connect(wsEndpoint, {
    transportOptions: options.authToken ? { authToken: options.authToken } : undefined,
  });
}
