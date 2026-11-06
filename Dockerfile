FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src/server src/server
COPY src/shared src/shared
COPY --from=build /app/dist dist
RUN mkdir /data && chown bun:bun /data
USER bun
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090 CAMWALL_DATA=/data CAMWALL_STATIC=/app/dist GO2RTC_URL=http://go2rtc:1984
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:8090/healthz'); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "src/server/index.ts"]
