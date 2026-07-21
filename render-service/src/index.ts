import { buildServer } from "./server.js";

const server = buildServer();
const port = Number(process.env.PORT ?? 8080);

server
  .listen({ port, host: "0.0.0.0" })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
