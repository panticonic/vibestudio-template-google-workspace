import {gmailGoalCompose} from "natlang:services";
import type {RetainedCompose} from "../types.js";
/** Read the selected Gmail compose through its owned retained event sequence. */
export default async function readRetainedCompose(id: string):Promise<RetainedCompose>{
 return gmailGoalCompose.read(id);
}
