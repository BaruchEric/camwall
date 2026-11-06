import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
	build: { outDir: "dist", emptyOutDir: true },
	server: {
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:8090",
			"/ws": { target: "ws://127.0.0.1:8090", ws: true },
		},
	},
});
