import {googleSetupPanel} from "natlang:services";
import type {GoogleSetupReceipt} from "../../../types.js";
/** Observe the assigned Google Workspace setup panel and return its receipts. */
export default async function observeSetupPanel():Promise<GoogleSetupReceipt[]>{
 return googleSetupPanel.observe();
}
