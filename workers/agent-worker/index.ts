export { AiChatWorker } from "./ai-chat-worker.js";
export default { fetch(_req: Request) { return new Response("agent-worker DO service"); } };
