import { createRequestHandler } from "react-router";
import { EscrowMachine } from "./escrow-machine";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export { EscrowMachine };

export default {
  async fetch(request) {
    return requestHandler(request);
  },
} satisfies ExportedHandler<Env>;
