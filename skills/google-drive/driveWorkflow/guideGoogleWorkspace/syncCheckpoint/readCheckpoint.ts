import {driveCheckpoint} from "natlang:services";
/** Read the current cursor from the assigned checkpoint file. */
export default async function readCheckpoint():Promise<string>{
 return driveCheckpoint.read();
}
