import checkLinkedAsset from "./reviewLinkedAssets/checkLinkedAsset.js";
import type {AssetIntent,AssetEvidence} from "../types.js";
export default async function reviewLinkedAssets(requested:AssetIntent[]):Promise<AssetEvidence[]>{
 const observed:AssetEvidence[]=[];
 for(const intent of requested)observed.push(await checkLinkedAsset(intent));
 return observed;
}
