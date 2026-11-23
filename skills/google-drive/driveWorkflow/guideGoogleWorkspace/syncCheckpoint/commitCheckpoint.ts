import {driveCheckpoint} from "natlang:services";
import type {GoogleCheckpointReceipt} from "../../types.js";
/** Apply one checkpoint transition guarded by the previously saved cursor. */
export default async function commitCheckpoint(expected: string, terminal: string):Promise<GoogleCheckpointReceipt>{
 return driveCheckpoint.commit(expected, terminal);
}
