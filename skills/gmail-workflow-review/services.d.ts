declare module "natlang:services" {
  export const gmailComposeHistory: {
    /** Read the assigned compose card's bounded native channel history. */
    read(operationId: string): Promise<import("./types.js").ComposeHistoryReceipt>;
  };
}
