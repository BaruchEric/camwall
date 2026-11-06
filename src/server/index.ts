import { createApp, type SocketData } from "@/server/app";
import { Go2rtc } from "@/server/go2rtc";
import { log } from "@/server/log";
import { Store } from "@/server/store";

const env = process.env;
const port = Number(env.PORT ?? 8090);
const hostname = env.HOST ?? "127.0.0.1";
const dir = env.CAMWALL_DATA ?? "./data";
const allowVirtual = env.CAMWALL_ALLOW_VIRTUAL === "1";
const allowedOrigins = (env.CAMWALL_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);

const store = await Store.open({ dir, allowVirtual });
const go2rtc = new Go2rtc(env.GO2RTC_URL ?? "http://127.0.0.1:1984");
const app = createApp({ store, go2rtc, staticDir: env.CAMWALL_STATIC ?? "./dist", allowedOrigins });

Bun.serve<SocketData>({ port, hostname, idleTimeout: 60, ...app });

store.onChange((config) => void go2rtc.sync(config));
void go2rtc.sync(store.config);
setInterval(() => void go2rtc.sync(store.config), 15_000);

log.info("camwall listening", { hostname, port, cameras: store.config.cameras.length });
