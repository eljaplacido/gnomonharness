// Exposes the two loopback-only servers this run needs -- the agent's model
// (llama-server :18080) and the decision-shadow server (:18195) -- on the docker
// bridge address, so a terminal-bench task container can reach them.
//
// Bound to the bridge address only, never 0.0.0.0: while it runs, every
// container on this host can reach both servers, and nothing outside the host
// can. Started by run_h7.sh and stopped when the run ends.
import net from "node:net";

const BIND = process.env.RELAY_BIND ?? "172.17.0.1";
const PORTS = (process.env.RELAY_PORTS ?? "18080,18195").split(",").map(Number);

for (const port of PORTS) {
  net
    .createServer((client) => {
      const upstream = net.connect(port, "127.0.0.1");
      client.pipe(upstream);
      upstream.pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    })
    .listen(port, BIND, () => console.log(`relay ${BIND}:${port} -> 127.0.0.1:${port}`));
}
