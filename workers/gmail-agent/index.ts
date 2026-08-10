export { GmailAgentWorker } from "./gmail-agent-worker.js";

export default {
  fetch(_req: Request) {
    return new Response("gmail-agent DO service");
  },
};
