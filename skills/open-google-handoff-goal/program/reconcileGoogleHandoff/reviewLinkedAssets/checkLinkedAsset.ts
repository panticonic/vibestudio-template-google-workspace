import {googleHandoffDrive} from "natlang:services";
import type {AssetEvidence, AssetIntent} from "../../types.js";
/** Inspect an asset by its exact link identity and obtain the requested Drive evidence. */
export default async function checkLinkedAsset(asset: AssetIntent):Promise<AssetEvidence>{
 return googleHandoffDrive.inspect(asset);
}
